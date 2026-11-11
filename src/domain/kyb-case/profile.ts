/**
 * Self-declared KYB profile (compliance LLD §5, ADR-0020 decision 3). Pure.
 *
 * Minimum business details, declared by the owner: no documents, no vendor. Drafts may be partial;
 * submission needs every field except `website` and `registration_number` (open onboarding, ADR-0024:
 * a business without a register number can still declare itself). `PATCH` semantics: an absent field keeps its value,
 * `null` clears it, an address replaces the stored one as a whole.
 */
import type { KybProfile as KybProfileSchema, KybProfileUpdate as KybProfileUpdateSchema } from "@nearpay-money/spec";
import type { z } from "zod";

export type KybProfile = z.output<typeof KybProfileSchema>;
export type KybProfileUpdate = z.output<typeof KybProfileUpdateSchema>;

export const PROFILE_FIELDS = [
  "legal_name",
  "country_of_incorporation",
  "registration_number",
  "business_type",
  "website",
  "business_address",
  "representative",
  "expected_monthly_volume",
] as const satisfies readonly (keyof KybProfile)[];
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Optional at submission: a business may have no website and no register number (ADR-0024). */
export const OPTIONAL_FIELDS: ReadonlySet<ProfileField> = new Set(["website", "registration_number"]);

export function emptyProfile(): KybProfile {
  return {
    legal_name: null,
    country_of_incorporation: null,
    registration_number: null,
    business_type: null,
    website: null,
    business_address: null,
    representative: null,
    expected_monthly_volume: null,
  };
}

const text = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, " ");
  return t === "" ? null : t;
};

/** Applies a partial update; returns the new profile and the fields whose value changed. */
export function mergeProfile(
  current: KybProfile,
  update: KybProfileUpdate,
): { profile: KybProfile; changed: ProfileField[] } {
  const next: KybProfile = { ...current };
  if (update.legal_name !== undefined) next.legal_name = text(update.legal_name);
  if (update.country_of_incorporation !== undefined)
    next.country_of_incorporation = update.country_of_incorporation?.toUpperCase() ?? null;
  if (update.registration_number !== undefined) next.registration_number = text(update.registration_number);
  if (update.business_type !== undefined) next.business_type = update.business_type;
  if (update.website !== undefined) next.website = update.website;
  if (update.expected_monthly_volume !== undefined) next.expected_monthly_volume = update.expected_monthly_volume;
  if (update.business_address !== undefined) {
    const a = update.business_address;
    next.business_address =
      a === null
        ? null
        : {
            line1: text(a.line1) ?? a.line1,
            line2: text(a.line2 ?? null),
            city: text(a.city) ?? a.city,
            postal_code: text(a.postal_code ?? null),
            region: text(a.region ?? null),
            country: a.country.toUpperCase(),
          };
  }
  if (update.representative !== undefined) {
    const r = update.representative;
    next.representative = r === null ? null : { name: text(r.name) ?? r.name, title: text(r.title) ?? r.title };
  }
  const changed = PROFILE_FIELDS.filter((f) => JSON.stringify(current[f]) !== JSON.stringify(next[f]));
  return { profile: next, changed };
}

/** Required fields that are still missing (submission is refused with `kyb_profile_incomplete`). */
export function missingFields(p: KybProfile): ProfileField[] {
  return PROFILE_FIELDS.filter((f) => !OPTIONAL_FIELDS.has(f) && p[f] === null);
}

/** Parses a stored profile defensively: unknown keys are dropped, missing keys are null. */
export function profileFromJson(raw: unknown): KybProfile {
  const p = emptyProfile();
  if (raw === null || typeof raw !== "object") return p;
  const o = raw as Record<string, unknown>;
  for (const f of PROFILE_FIELDS) if (o[f] !== undefined) (p as Record<string, unknown>)[f] = o[f];
  return p;
}
