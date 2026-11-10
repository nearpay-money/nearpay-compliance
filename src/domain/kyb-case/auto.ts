/**
 * Open onboarding (ADR-0024, compliance LLD §5 "KYB modes"). Pure.
 *
 * `NP_KYB_MODE=auto` (default): a complete self-declared profile is decided by the system the moment it
 * is submitted — no NearPay approval step. The only automatic protection applied here is the geo policy
 * (FR-CMP-03, policy is data): a business registered in, or with its address in, a blocked country or
 * region is rejected automatically with the `geo_blocked` reason code. Payout addresses keep their own
 * automatic sanctions screening (identity → `createScreening`, daily re-screen); operators keep
 * suspension and a manual reject for abuse.
 *
 * `NP_KYB_MODE=manual` keeps the Stage 2 review: `pending` waits for an ops decision.
 */
import type { KybProfile } from "./profile.js";

export const KYB_MODES = ["auto", "manual"] as const;
export type KybMode = (typeof KYB_MODES)[number];

/** Actor recorded on automatic decisions (`decided_by`, transition actor, console history). */
export const SYSTEM_ACTOR = "system";

export const AUTO_APPROVED_REASON = "auto-approved: open onboarding (ADR-0024)";

export interface GeoLists {
  readonly blocked_countries: readonly string[];
  readonly blocked_regions: readonly string[];
}

export type AutoDecision =
  | { readonly decision: "approved"; readonly reason: string }
  | { readonly decision: "rejected"; readonly reason: string; readonly code: "geo_blocked" };

const norm = (s: string) => s.trim().toUpperCase();

/** ISO 3166-2 code of the address region when it can be read as one (`UA-43`, or `43` with country `UA`). */
function regionCode(country: string, region: string | null | undefined): string | null {
  if (!region) return null;
  const r = norm(region);
  if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(r)) return r;
  if (/^[A-Z0-9]{1,3}$/.test(r)) return `${country}-${r}`;
  return null;
}

/** The decision the system takes for a complete, submitted profile. */
export function autoDecide(profile: KybProfile, geo: GeoLists): AutoDecision {
  const countries = new Set(geo.blocked_countries.map(norm));
  const regions = new Set(geo.blocked_regions.map(norm));
  const incorporation = profile.country_of_incorporation ? norm(profile.country_of_incorporation) : null;
  if (incorporation && countries.has(incorporation))
    return {
      decision: "rejected",
      code: "geo_blocked",
      reason: `auto-rejected: geo_blocked (country of incorporation ${incorporation})`,
    };
  const address = profile.business_address;
  if (address) {
    const country = norm(address.country);
    if (countries.has(country))
      return {
        decision: "rejected",
        code: "geo_blocked",
        reason: `auto-rejected: geo_blocked (business address country ${country})`,
      };
    const region = regionCode(country, address.region);
    if (region && regions.has(region))
      return {
        decision: "rejected",
        code: "geo_blocked",
        reason: `auto-rejected: geo_blocked (business address region ${region})`,
      };
  }
  return { decision: "approved", reason: AUTO_APPROVED_REASON };
}
