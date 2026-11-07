/**
 * The `local` screening provider (compliance LLD §4, SP-15, ADR-0020 decision 4): NearPay blocklist +
 * the locally imported OFAC SDN digital-currency list. Hits block; until a list has been imported the
 * provider is unavailable (`sanctions_list_unavailable`), exactly like an unreachable vendor, so a
 * fresh install never passes large live payments unscreened. Risk is always null (list hits only).
 */
import type { Kysely } from "@nearpay-internal/db";
import { OFAC_SOURCE } from "../../app/sanctions.js";
import type { ScreeningProvider } from "../../app/screening-provider.js";
import type { NormalizedSubject } from "../../domain/screening/subject.js";
import type { DB } from "../../infra/db/schema.js";

export function localProvider(): ScreeningProvider {
  return {
    name: "local",
    async check(db: Kysely<DB>, subject: NormalizedSubject) {
      const bl = await db
        .selectFrom("blocklist")
        .select("subject")
        .where("subject", "in", [subject.norm, ...subject.listKeys.map((k) => k.address)])
        .where("removed_at", "is", null)
        .executeTakeFirst();
      const hit = await db
        .selectFrom("sanctions_entries")
        .select("address_norm")
        .where((eb) =>
          eb.or(
            subject.listKeys.map((k) =>
              k.family === "*"
                ? eb("address_norm", "=", k.address)
                : eb.and([eb("chain_family", "=", k.family), eb("address_norm", "=", k.address)]),
            ),
          ),
        )
        .executeTakeFirst();
      const listLoaded =
        (await db
          .selectFrom("sanctions_lists")
          .select("source")
          .where("source", "=", OFAC_SOURCE)
          .executeTakeFirst()) !== undefined;
      return {
        name: "local",
        hits: [...(hit ? ["sanctions"] : []), ...(bl ? ["blocklist"] : [])],
        unavailable: listLoaded ? null : "sanctions_list_unavailable",
        risk: null,
      };
    },
  };
}
