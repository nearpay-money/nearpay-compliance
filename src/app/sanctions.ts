/**
 * Local sanctions list (compliance LLD §7 `sanctions.refresh`, SP-15): download the OFAC SDN advanced
 * XML, extract digital-currency addresses, replace the `ofac_sdn` entries in one transaction and log
 * the diff. A download or parse failure keeps the previous list (the age metric alerts after 48 h);
 * an empty result is refused (a format change must not silently empty the list).
 */
import type { Readable } from "node:stream";
import { sql, withTx } from "@nearpay-internal/db";
import { openSdnSource, parseSdnAdvanced } from "../vendors/screening/ofac-sdn.js";
import { type Compliance, dbNow } from "./context.js";

export const OFAC_SOURCE = "ofac_sdn";

export interface ImportResult {
  entries: number;
  added: number;
  removed: number;
  skipped: number;
  sha256: string;
  unchanged: boolean;
}

export async function importSanctions(c: Compliance, input: Readable): Promise<ImportResult> {
  const parsed = await parseSdnAdvanced(input);
  if (parsed.entries.length === 0)
    throw new Error("the sanctions list has no digital-currency addresses; keeping the previous list");
  return withTx(c.db, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('compliance:sanctions'))`.execute(tx);
    const prev = await tx
      .selectFrom("sanctions_lists")
      .selectAll()
      .where("source", "=", OFAC_SOURCE)
      .executeTakeFirst();
    const now = await dbNow(tx);
    if (prev?.sha256.equals(parsed.sha256)) {
      await tx.updateTable("sanctions_lists").set({ fetched_at: now }).where("source", "=", OFAC_SOURCE).execute();
      return {
        entries: parsed.entries.length,
        added: 0,
        removed: 0,
        skipped: parsed.skipped,
        sha256: parsed.sha256.toString("hex"),
        unchanged: true,
      };
    }
    const before = await tx
      .selectFrom("sanctions_entries")
      .select(["chain_family", "address_norm"])
      .where("source", "=", OFAC_SOURCE)
      .execute();
    const old = new Set(before.map((r) => `${r.chain_family}|${r.address_norm}`));
    const next = new Set(parsed.entries.map((e) => `${e.family}|${e.address}`));
    await tx.deleteFrom("sanctions_entries").where("source", "=", OFAC_SOURCE).execute();
    for (let i = 0; i < parsed.entries.length; i += 1_000) {
      await tx
        .insertInto("sanctions_entries")
        .values(
          parsed.entries.slice(i, i + 1_000).map((e) => ({
            chain_family: e.family,
            address_norm: e.address,
            source: OFAC_SOURCE,
            currency: e.currency,
          })),
        )
        .onConflict((oc) => oc.columns(["chain_family", "address_norm"]).doNothing())
        .execute();
    }
    await tx
      .insertInto("sanctions_lists")
      .values({ source: OFAC_SOURCE, fetched_at: now, entries: parsed.entries.length, sha256: parsed.sha256 })
      .onConflict((oc) =>
        oc.column("source").doUpdateSet({ fetched_at: now, entries: parsed.entries.length, sha256: parsed.sha256 }),
      )
      .execute();
    const added = [...next].filter((k) => !old.has(k)).length;
    const removed = [...old].filter((k) => !next.has(k)).length;
    c.log.info({ entries: parsed.entries.length, added, removed, skipped: parsed.skipped }, "sanctions list imported");
    return {
      entries: parsed.entries.length,
      added,
      removed,
      skipped: parsed.skipped,
      sha256: parsed.sha256.toString("hex"),
      unchanged: false,
    };
  });
}

export async function refreshSanctions(
  c: Compliance,
  source: string,
  timeoutMs: number,
  f: typeof fetch = fetch,
): Promise<ImportResult> {
  return importSanctions(c, await openSdnSource(source, timeoutMs, f));
}

/** Hours since the list was last fetched (metric `sanctions_list_age_hours`; −1 when never). */
export async function sanctionsAgeHours(c: Compliance): Promise<number> {
  const r = await c.db
    .selectFrom("sanctions_lists")
    .select("fetched_at")
    .where("source", "=", OFAC_SOURCE)
    .executeTakeFirst();
  if (!r) return -1;
  return (Date.now() - r.fetched_at.getTime()) / 3_600_000;
}
