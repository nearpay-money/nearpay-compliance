/**
 * Process wiring (compliance LLD §2): `api` serves the routes; `worker` runs the consumers, the job
 * worker, the recurring-job scheduler and the outbox relay.
 */
import { hostname } from "node:os";
import type { KeySource } from "@nearpay-internal/auth";
import {
  type Bus,
  busReady,
  connectBus,
  consumerLag,
  domainConsumersTask,
  durablesOf,
  ensureStreams,
  publish,
} from "@nearpay-internal/bus";
import {
  createDb,
  createEnvelopeCipher,
  type Database,
  deadLettersOpen,
  idempotencyStore,
  jobsDue,
  jobWorkerTask,
  migrationStatus,
  outboxLagSeconds,
  outboxRelayTask,
  parseKek,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { createService, type Service } from "@nearpay-internal/service";
import { STREAMS, type Subject } from "@nearpay-internal/spec";
import { complianceRoutes } from "../api/routes.js";
import type { ApiConfig, WorkerConfig } from "../config.js";
import { complianceHandlers, deadLetters } from "../consumers/handlers.js";
import type { KybMode } from "../domain/kyb-case/auto.js";
import { complianceServiceToken, httpOperatorDirectory, type OperatorDirectory } from "../infra/clients/identity.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import { localProvider } from "../vendors/screening/local.js";
import { jobHandlers, RECURRING } from "../workers/jobs.js";
import { type Compliance, complianceMetrics } from "./context.js";
import { sanctionsAgeHours } from "./sanctions.js";
import type { ScreeningProvider, ScreeningProviderName } from "./screening-provider.js";
import { logSingleOperatorPolicy } from "./single-operator-metrics.js";

export interface ServiceDeps {
  keys?: KeySource;
  database?: Database<DB>;
  /** Identity's operator read (tests inject a client of a spec mock). */
  operators?: OperatorDirectory;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The screening provider behind the vendor-neutral interface (v1: `local` only). */
export function screeningProvider(name: ScreeningProviderName): ScreeningProvider {
  switch (name) {
    case "local":
      return localProvider();
  }
}

/** The bootstrap creates the logger and metrics, so they are attached right after the service exists. */
function context(
  database: Database<DB>,
  config: {
    piiKek: string;
    screeningProvider: ScreeningProviderName;
    opsApprovalTtlSeconds: number;
    opsSingleOperatorDelayS?: number;
    kybMode?: KybMode;
  },
): Mutable<Compliance> {
  return {
    db: database.db,
    cipher: createEnvelopeCipher(parseKek(config.piiKek)),
    log: undefined as unknown as Compliance["log"],
    metrics: undefined as unknown as Compliance["metrics"],
    provider: screeningProvider(config.screeningProvider),
    opsApprovalTtlSeconds: config.opsApprovalTtlSeconds,
    singleOperatorDelaySeconds: config.opsSingleOperatorDelayS ?? 300,
    kybMode: config.kybMode ?? "auto",
  };
}

function attach(c: Mutable<Compliance>, service: Service): Compliance {
  c.log = service.log;
  c.metrics = complianceMetrics(service.metrics);
  logSingleOperatorPolicy(service.log, c.singleOperatorDelaySeconds ?? 300);
  service.log.info({ kyb_mode: c.kybMode ?? "auto" }, "KYB mode (NP_KYB_MODE; ADR-0024)");
  return c;
}

function readiness(database: Database<DB>) {
  return {
    db: () => sql`select 1`.execute(database.db),
    migrations: async () => {
      const s = await migrationStatus(database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

/** DB-derived gauges, exported by the single worker only (the api runs 2 replicas). */
function gauges(service: Service, c: Compliance) {
  service.metrics.collectOutboxLag(() => outboxLagSeconds(c.db));
  service.metrics.collectJobsDue(() => jobsDue(c.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(c.db));
  service.metrics.gauge(
    "sanctions_list_age_hours",
    "Hours since the OFAC list was fetched (-1 = never).",
    [],
    async (g) => g.set(await sanctionsAgeHours(c)),
  );
  service.metrics.gauge("cases_open", "Open compliance cases.", ["kind", "severity"], async (g) => {
    const rows = await c.db
      .selectFrom("cases")
      .select(["kind", "severity", sql<string>`count(*)::text`.as("n")])
      .where("status", "<>", "closed")
      .groupBy(["kind", "severity"])
      .execute();
    g.reset();
    for (const r of rows) g.set({ kind: r.kind, severity: r.severity }, Number(r.n));
  });
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; compliance: Compliance } {
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: "compliance-api" });
  const c = context(database, config);
  c.operators =
    deps.operators ??
    httpOperatorDirectory({
      identityUrl: config.identityUrl,
      serviceToken: complianceServiceToken(config.identityUrl, config.serviceClientSecret),
    });
  const service = createService({
    name: "compliance",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    idempotency: idempotencyStore(database.db, c.cipher),
    routes: complianceRoutes(c),
    readiness: readiness(database),
  });
  attach(c, service);
  if (!deps.database) service.onShutdown(() => database.close());
  return { service, compliance: c };
}

export async function createWorker(
  config: WorkerConfig,
  deps: ServiceDeps & { bus?: Bus; fetch?: typeof fetch; tickMs?: number } = {},
): Promise<{ service: Service; compliance: Compliance }> {
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: "compliance-worker" });
  const service = createService({ name: "compliance", config, readiness: readiness(database) });
  const c = attach(context(database, config), service);
  gauges(service, c);
  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `compliance-worker@${hostname()}` }));
  await ensureStreams(bus, [STREAMS.compliance]);
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = complianceHandlers(c);
  const durables = durablesOf("compliance", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    outboxRelayTask({
      db: database.db,
      pool: database.pool,
      publish: (s, e, id) => publish(bus, s, e, id).then(() => {}),
      onError,
    }),
  );
  service.addBackground(
    domainConsumersTask({ bus, consumer: "compliance", handlers, onDeadLetter: deadLetters(database.db), onError }),
  );
  service.addBackground(
    jobWorkerTask({
      db: database.db,
      workerId: `compliance-worker@${hostname()}:${process.pid}`,
      handlers: jobHandlers(c, {
        sanctionsRefresh: config.sanctionsRefresh,
        sanctionsSourceUrl: config.sanctionsSourceUrl,
        sanctionsTimeoutMs: config.sanctionsTimeoutMs,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
      onError: (e, job) => service.log.error({ err: e, job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  service.addBackground(
    recurringJobsTask({
      db: database.db,
      pool: database.pool,
      name: "compliance:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );
  service.onShutdown(async () => {
    if (!deps.bus) await bus.close();
    if (!deps.database) await database.close();
  });
  return { service, compliance: c };
}
