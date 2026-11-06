/**
 * Ops CLI entry (compliance LLD §5, platform §3): `docker compose exec compliance-api node dist/ops.js …`.
 * Reads the api container's configuration (DB URL, KEK); logs go to stderr, results to stdout.
 */
import { hostname } from "node:os";
import { createDb, createEnvelopeCipher, parseKek } from "@nearpay-internal/db";
import { ConfigError, createLogger } from "@nearpay-internal/service";
import { noMetrics } from "./app/context.js";
import { readOpsConfig } from "./config.js";
import type { DB } from "./infra/db/schema.js";
import { runOps } from "./ops/cli.js";

let code = 1;
try {
  const config = readOpsConfig();
  const database = createDb<DB>({ url: config.dbUrl, applicationName: "compliance-ops" });
  try {
    code = await runOps(
      process.argv.slice(2),
      {
        db: database.db,
        cipher: createEnvelopeCipher(parseKek(config.piiKek)),
        log: createLogger({
          service: "compliance-ops",
          env: config.env,
          level: config.logLevel,
          destination: process.stderr,
        }),
        metrics: noMetrics,
        screeningVendor: config.screeningVendor,
      },
      {
        actor: config.opsActor ?? `cli@${hostname()}`,
        sanctions: { source: config.sanctionsSourceUrl, timeoutMs: config.sanctionsTimeoutMs },
      },
    );
  } finally {
    await database.close();
  }
} catch (e) {
  process.stderr.write(
    `${e instanceof ConfigError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
}
process.exit(code);
