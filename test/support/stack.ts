/**
 * Integration harness: Postgres provisioned like nearpay-deploy's `postgres-init` (the migrator role
 * owns the database, the app role has DML only), migrations applied as the migrator, NATS JetStream,
 * and the real `api` and `worker` processes built from the same factories `main.ts` uses — so a
 * missing grant, a wrong stream or an unhandled subject fails here, not in Compose.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import type { Service } from "@nearpay-internal/service";
import {
  type EventProbe,
  eventProbe,
  mintServiceToken,
  mintTestToken,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  testKeySource,
} from "@nearpay-internal/testing";
import type { Compliance } from "../../src/app/context.js";
import { importSanctions } from "../../src/app/sanctions.js";
import { createApi, createWorker } from "../../src/app/services.js";
import type { ApiConfig, WorkerConfig } from "../../src/config.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";

export const SAMPLE_SDN = new URL("../fixtures/sdn_advanced.sample.xml", import.meta.url);
/** Listed in the sample (ETH), as published checksummed elsewhere. */
export const LISTED_EVM = "0x252a8bd2319d8a555b872990601221b3a2053bce";
/** Listed in the sample (XBT). */
export const LISTED_BTC = "12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL";
export const CLEAN_EVM = "0x52908400098527886e0f7030069857d2e4169ee7";

export interface Stack {
  readonly pg: Started;
  readonly nats: (Started & { monitorUrl: string }) | null;
  readonly admin: Database<DB>;
  readonly api: Service;
  readonly compliance: Compliance;
  readonly worker: { service: Service; compliance: Compliance; metricsPort: number } | null;
  readonly bus: Bus | null;
  readonly kek: string;
  readonly appUrl: string;
  call(
    method: "GET" | "POST",
    url: string,
    o?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }>;
  /** Imports the recorded OFAC sample. */
  importSample(): Promise<void>;
  publishEvent(e: Envelope): Promise<void>;
  probe(): Promise<EventProbe>;
  stop(): Promise<void>;
}

export interface StackOptions {
  worker?: boolean;
  fetch?: typeof fetch;
  sanctionsRefresh?: boolean;
  sanctionsSourceUrl?: string;
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats] = await Promise.all([startPostgres({ database: "postgres" }), o.worker ? startNats() : null]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "compliance");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  const kek = randomBytes(32).toString("base64");
  const admin = createDb<DB>({ url: appUrl, applicationName: "compliance-test" });

  const base = {
    env: "test" as const,
    logLevel: "silent" as const,
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    piiKek: kek,
    sanctionsSourceUrl: o.sanctionsSourceUrl ?? "https://ofac.example/SDN_ADVANCED.XML",
    screeningVendor: "none" as const,
    kybVendor: "manual" as const,
  };
  const apiConfig: ApiConfig = base;
  const apiDb = createDb<DB>({ url: appUrl, applicationName: "compliance-api-test" });
  const { service: api, compliance } = createApi(apiConfig, { keys: testKeySource(), database: apiDb });
  await api.start();

  let worker: Stack["worker"] = null;
  let bus: Bus | null = null;
  let workerDb: Database<DB> | null = null;
  if (o.worker && nats) {
    bus = await connectBus({ url: nats.url, name: "compliance-test-publisher" });
    const workerConfig: WorkerConfig = {
      ...base,
      natsUrl: nats.url,
      sanctionsRefresh: o.sanctionsRefresh ?? false,
      sanctionsTimeoutMs: 5_000,
    };
    workerDb = createDb<DB>({ url: appUrl, applicationName: "compliance-worker-test" });
    const w = await createWorker(workerConfig, {
      database: workerDb,
      tickMs: 50,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    const { metricsPort } = await w.service.start();
    worker = { ...w, metricsPort };
  }

  return {
    pg,
    nats,
    admin,
    api,
    compliance,
    worker,
    bus,
    kek,
    appUrl,
    async call(method, url, opts = {}) {
      const token = opts.token ?? (await mintServiceToken("rails"));
      const r = await api.app.inject({
        method,
        url,
        ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
        headers: { ...(token === "" ? {} : { "x-nearpay-token": token }), ...(opts.headers ?? {}) },
      });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
    },
    async importSample() {
      await importSanctions(compliance, createReadStream(SAMPLE_SDN));
    },
    async publishEvent(e) {
      if (!bus) throw new Error("the stack runs without NATS");
      await publish(bus, e.subject, e);
    },
    async probe() {
      if (!nats) throw new Error("the stack runs without NATS");
      return eventProbe(nats.url);
    },
    async stop() {
      await worker?.service.stop();
      await api.stop();
      await bus?.close();
      await workerDb?.close();
      await apiDb.close();
      await admin.close();
      await Promise.all([pg.stop(), nats?.stop()]);
    },
  };
}

/** Polls until `fn` returns a value that is not null/undefined/false. */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until)
      throw new Error(`condition not met within ${timeoutMs} ms${last ? `: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const opsToken = (scopes: string[] = ["compliance.kyb.decide"]) =>
  mintTestToken({ sub: "usr_ops_alice", ptype: "ops", scp: scopes });

export const sessionToken = (acct: string, role: "owner" | "admin" | "developer" | "viewer" = "owner") =>
  mintTestToken({ sub: "usr_owner", acct, lm: false, ptype: "session", scp: [], role });

export { mintServiceToken, mintTestToken };
