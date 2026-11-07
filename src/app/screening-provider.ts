/**
 * Vendor-neutral screening interface (compliance LLD §4, ADR-0020 decision 4). v1 has one live
 * provider, `local` (`src/vendors/screening/local.ts`: the OFAC digital-currency list + the NearPay
 * blocklist). A vendor is a second implementation behind this port; it needs no contract change, and
 * the fail policy stays in the pure decision (`domain/screening/decision.ts`).
 */
import type { Kysely } from "@nearpay-internal/db";
import type { ProviderResult } from "../domain/screening/decision.js";
import type { NormalizedSubject } from "../domain/screening/subject.js";
import type { DB } from "../infra/db/schema.js";

export const SCREENING_PROVIDERS = ["local"] as const;
export type ScreeningProviderName = (typeof SCREENING_PROVIDERS)[number];

export interface ScreeningProvider {
  readonly name: ScreeningProviderName;
  /**
   * Screens one live subject. Must not throw for "provider unavailable": return `unavailable` so the
   * decision applies the fail-closed threshold. Database errors propagate (the caller retries).
   */
  check(db: Kysely<DB>, subject: NormalizedSubject): Promise<ProviderResult>;
}
