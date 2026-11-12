/**
 * Jobs (compliance LLD §7), scheduled by the leader-elected recurring-jobs loop and run by the job
 * worker (foundations §7: leases, backoff, dead letters):
 *
 * | kind                  | when            | what                                                            |
 * |-----------------------|-----------------|-----------------------------------------------------------------|
 * | sanctions.refresh     | daily 03:00 UTC | download + import the OFAC SDN list (failure keeps the old one) |
 * | destinations.rescreen | daily 04:00 UTC | screen active live destinations; a block disables them + case   |
 * |                       | + console       | (`createOpsRescreen` queues it for one account or all)          |
 * | ops_approvals.expire  | every 15 min    | pending two-person requests past their expiry → `expired`       |
 * | kyb.auto_decide       | every minute    | auto mode (ADR-0024): decide complete cases still `pending`     |
 * | purge.screenings      | daily 05:00 UTC | delete screenings older than the policy retention               |
 * | kit.purge             | hourly          | published outbox, old inbox rows, expired idempotency keys       |
 */

import type { JobContext, JobHandler } from "@nearpay-internal/db";
import { purgeKitTables, type RecurringJob, sql, withTx } from "@nearpay-internal/db";
import { blockDestination } from "../app/admin.js";
import { type Compliance, dbNow } from "../app/context.js";
import { autoDecidePending } from "../app/kyb.js";
import { refreshSanctions } from "../app/sanctions.js";
import { screen } from "../app/screening.js";
import { expireApprovals } from "../app/suspension.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RECURRING: readonly RecurringJob[] = [
  { kind: "sanctions.refresh", everyMs: DAY, offsetMs: 3 * HOUR },
  { kind: "destinations.rescreen", everyMs: DAY, offsetMs: 4 * HOUR },
  { kind: "purge.screenings", everyMs: DAY, offsetMs: 5 * HOUR },
  { kind: "ops_approvals.expire", everyMs: 15 * 60_000 },
  { kind: "kyb.auto_decide", everyMs: 60_000 },
  { kind: "kit.purge", everyMs: HOUR },
];

export interface JobOptions {
  sanctionsRefresh: boolean;
  sanctionsSourceUrl: string;
  sanctionsTimeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * Screens every active live destination (batches of 200; each block in its own tx). `onBatch` runs
 * before each batch and after every destination (the job extends its lease there, throttled; each extension also
 * beats the job worker's liveness heartbeat, kit 0.6.0 — 200 fresh screenings can outlast its 180 s budget).
 */
export async function rescreenDestinations(
  c: Compliance,
  onBatch: () => Promise<void> = async () => {},
  accountUuid: string | null = null,
): Promise<{ screened: number; blocked: number }> {
  let screened = 0;
  let blocked = 0;
  const started = await dbNow(c.db);
  for (;;) {
    await onBatch();
    let q = c.db
      .selectFrom("monitored_destinations")
      .selectAll()
      .where("active", "=", true)
      .where("livemode", "=", true)
      .where((eb) => eb.or([eb("last_screened_at", "is", null), eb("last_screened_at", "<", started)]));
    if (accountUuid) q = q.where("account_id", "=", accountUuid);
    const batch = await q.orderBy("destination_id").limit(200).execute();
    if (batch.length === 0) break;
    for (const d of batch) {
      const r = await screen(
        c,
        {
          subject_type: "destination",
          chain: d.chain,
          subject: d.address_norm,
          context: "destination",
          account_id: undefined,
          livemode: true,
        },
        { fresh: true },
      ).catch((e: unknown) => {
        c.log.error({ err: e, destination: d.destination_id }, "destination re-screen failed");
        return null;
      });
      await withTx(c.db, async (tx) => {
        const row = await tx
          .selectFrom("monitored_destinations")
          .selectAll()
          .where("destination_id", "=", d.destination_id)
          .forUpdate()
          .executeTakeFirst();
        if (!row) return;
        await tx
          .updateTable("monitored_destinations")
          .set({ last_screened_at: await dbNow(tx) })
          .where("destination_id", "=", d.destination_id)
          .execute();
        if (r && r.decision === "block" && row.active) {
          await blockDestination(c, tx, row, `re-screening: ${r.reasons.join(", ")}`, "compliance");
          blocked++;
        }
      });
      screened++;
      await onBatch();
    }
  }
  return { screened, blocked };
}

/** At most one `fn` call per `everyMs` (lease extensions from tight loops). */
export function throttled(fn: () => Promise<void>, everyMs = 30_000, now = Date.now): () => Promise<void> {
  let last = Number.NEGATIVE_INFINITY;
  return async () => {
    const t = now();
    if (t - last < everyMs) return;
    last = t;
    await fn();
  };
}

/**
 * Runs `work` while extending the job's lease every `everyMs` (each extension beats the job worker's liveness
 * heartbeat, kit 0.6.0). For one long awaited step that is bounded by its own timeout (the sanctions download).
 */
export async function keepingLease<T>(
  ctx: JobContext,
  seconds: number,
  work: () => Promise<T>,
  everyMs = 60_000,
): Promise<T> {
  const timer = setInterval(() => void ctx.extendLease(seconds).catch(() => {}), everyMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export function jobHandlers(c: Compliance, o: JobOptions): Record<string, JobHandler> {
  return {
    "sanctions.refresh": async (_payload, ctx: JobContext) => {
      if (!o.sanctionsRefresh) return;
      // the download alone may take minutes (bounded by sanctionsTimeoutMs): hold the lease for the whole timeout and
      // keep extending it, so the job worker's liveness budget (180 s) never sees the download as a hang
      const lease = Math.ceil(o.sanctionsTimeoutMs / 1000) + 300;
      await ctx.extendLease(lease);
      await keepingLease(ctx, lease, () => refreshSanctions(c, o.sanctionsSourceUrl, o.sanctionsTimeoutMs, o.fetch));
    },
    "destinations.rescreen": async (payload, ctx: JobContext) => {
      const account = (payload as { account_id?: string | null } | null)?.account_id ?? null;
      const r = await rescreenDestinations(
        c,
        throttled(() => ctx.extendLease(600)),
        account,
      );
      c.log.info({ ...r, account }, "destinations re-screened");
    },
    "ops_approvals.expire": async () => {
      await expireApprovals(c);
    },
    "kyb.auto_decide": async () => {
      const r = await autoDecidePending(c);
      if (r.decided > 0) c.log.info(r, "pending KYB cases decided automatically");
    },
    "purge.screenings": async () => {
      const r = await sql`delete from screenings
        where created_at < now() - make_interval(years => (select retention_years from policies where id = 'default'))`.execute(
        c.db,
      );
      c.log.info({ deleted: Number(r.numAffectedRows ?? 0n) }, "screenings purged");
    },
    "kit.purge": async () => {
      c.log.info(await purgeKitTables(c.db), "kit tables purged");
    },
  };
}
