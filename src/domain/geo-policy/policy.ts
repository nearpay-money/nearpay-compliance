/** Geo policy validation (compliance LLD §3, FR-CMP-03: policy is data, not code). Pure. */

const COUNTRY_RE = /^[A-Z]{2}$/;
/** ISO 3166-2 subdivision: country code, dash, 1–3 alphanumerics. */
const REGION_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

export interface GeoPolicyInput {
  readonly blockedCountries: readonly string[];
  readonly blockedRegions: readonly string[];
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Normalises (upper-case, sorted, de-duplicated) and validates the lists. */
export function normalizePolicy(p: GeoPolicyInput): { blockedCountries: string[]; blockedRegions: string[] } {
  const norm = (xs: readonly string[], re: RegExp, what: string) => {
    const out = [...new Set(xs.map((x) => x.trim().toUpperCase()).filter(Boolean))].sort();
    for (const x of out) if (!re.test(x)) throw new PolicyError(`${x} is not a valid ${what}`);
    return out;
  };
  return {
    blockedCountries: norm(p.blockedCountries, COUNTRY_RE, "ISO 3166-1 country code"),
    blockedRegions: norm(p.blockedRegions, REGION_RE, "ISO 3166-2 region code"),
  };
}
