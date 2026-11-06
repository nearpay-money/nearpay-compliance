/**
 * Jobs (compliance LLD §7), scheduled by the leader-elected recurring-jobs loop and run by the job
 * worker (foundations §7: leases, backoff, dead letters):
 *
 * | kind                  | when            | what                                                            |
 * |-----------------------|-----------------|-----------------------------------------------------------------|
 * | sanctions.refresh     | daily 03:00 UTC | download + import the OFAC SDN list (failure keeps the old one) |
 * | destinations.rescreen | daily 04:00 UTC | screen active live destinations; a block disables them + case   |
 * | purge.screenings      | daily 05:00 UTC | delete screenings older than the policy retention               |
 * | kit.purge             | hourly          | published outbox, old inbox rows, expired idempotency keys       |
 */

import type { JobContext, JobHandler } from "@nearpay-internal/db";
import { purgeKitTables, type RecurringJob, sql, withTx } from "@nearpay-internal/db";
import { blockDestination } from "../app/admin.js";
import { type Compliance, dbNow } from "../app/context.js";
import { refreshSanctions } from "../app/sanctions.js";
import { screen } from "../app/screening.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RECURRING: readonly RecurringJob[] = [
  { kind: "sanctions.refresh", everyMs: DAY, offsetMs: 3 * HOUR },
  { kind: "destinations.rescreen", everyMs: DAY, offsetMs: 4 * HOUR },
  { kind: "purge.screenings", everyMs: DAY, offsetMs: 5 * HOUR },
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
 * before each batch (the job extends its lease there).
 */
export async function rescreenDestinations(
  c: Compliance,
  onBatch: () => Promise<void> = async () => {},
): Promise<{ screened: number; blocked: number }> {
  let screened = 0;
  let blocked = 0;
  const started = await dbNow(c.db);
  for (;;) {
    await onBatch();
    const batch = await c.db
      .selectFrom("monitored_destinations")
      .selectAll()
      .where("active", "=", true)
      .where("livemode", "=", true)
      .where((eb) => eb.or([eb("last_screened_at", "is", null), eb("last_screened_at", "<", started)]))
      .orderBy("destination_id")
      .limit(200)
      .execute();
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
    }
  }
  return { screened, blocked };
}

export function jobHandlers(c: Compliance, o: JobOptions): Record<string, JobHandler> {
  return {
    "sanctions.refresh": async (_payload, ctx: JobContext) => {
      if (!o.sanctionsRefresh) return;
      // the download alone may take minutes: hold the lease for the whole timeout
      await ctx.extendLease(Math.ceil(o.sanctionsTimeoutMs / 1000) + 300);
      await refreshSanctions(c, o.sanctionsSourceUrl, o.sanctionsTimeoutMs, o.fetch);
    },
    "destinations.rescreen": async (_payload, ctx: JobContext) => {
      const r = await rescreenDestinations(c, () => ctx.extendLease(600));
      c.log.info(r, "destinations re-screened");
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
