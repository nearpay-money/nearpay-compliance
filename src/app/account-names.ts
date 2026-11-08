/**
 * Account display names (spec 0.2.1, compliance LLD §"Spec 0.2.1"): `evt.identity.account.created` and
 * `.updated` keep `account_names` current for `ComplianceCase.account_display_name` and refresh the KYB
 * queue's copy. Ordered by identity's aggregate version: an older or redelivered event changes nothing.
 */

import type { Kysely } from "@nearpay-internal/db";
import { sql } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import type { DB } from "../infra/db/schema.js";
import type { Tx } from "./context.js";

/** Stores the name when `version` is newer than the stored one; true when it was applied. */
export async function rememberAccountName(tx: Tx, accountId: string, name: string, version: number): Promise<boolean> {
  const account = toUuid(accountId, "acct");
  const r = await tx
    .insertInto("account_names")
    .values({ account_id: account, display_name: name, version })
    .onConflict((oc) =>
      oc
        .column("account_id")
        .doUpdateSet({ display_name: name, version, updated_at: sql<Date>`now()` })
        .where("account_names.version", "<", version),
    )
    .returning("account_id")
    .executeTakeFirst();
  if (!r) return false;
  await tx.updateTable("kyb_cases").set({ account_display_name: name }).where("account_id", "=", account).execute();
  return true;
}

/** Display names of the given account UUIDs (unknown accounts are absent). */
export async function accountNames(db: Kysely<DB> | Tx, accountUuids: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(accountUuids)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("account_names")
    .select(["account_id", "display_name"])
    .where("account_id", "in", ids)
    .execute();
  return new Map(rows.map((r) => [r.account_id, r.display_name]));
}
