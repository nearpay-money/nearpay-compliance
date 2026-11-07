/**
 * Screening decision (compliance LLD §4, ADR-0020 decision 4). Pure: the caller asks the configured
 * provider (vendor-neutral interface; v1 has one live provider, `local`: OFAC digital-currency list +
 * NearPay blocklist), looks up the cache, and persists what this returns.
 *
 *   test mode               → magic only: `sanctioned` in the subject blocks, everything else allows
 *   provider list hit       → block (`sanctions` / `blocklist` / …), whatever the cache or amount
 *   provider unavailable    → degraded (for `local`: no sanctions list imported yet,
 *                             `sanctions_list_unavailable`): amount unknown (no
 *                             `amount_usd_micros`: destinations, x402 payers, rails legs it could
 *                             not price) or ≥ fail-closed threshold → unavailable (503); else allow
 *                             with post-screening required
 *   cached decision         → returned as cached
 *   provider risk (vendor)  → severe/high block, medium review (allow + case), low allow
 *   provider clear          → allow
 *
 * A degraded allow (post-screening required) is recorded but never served from the cache, so the
 * next screen consults the recovered provider. An unknown amount fails closed like a large one (audit
 * finding 9, stage 2): a degraded allow needs proof that the amount is below the threshold.
 */

export type Decision = "allow" | "block" | "review";
export type Risk = "severe" | "high" | "medium" | "low";

/** What a provider found for one subject. */
export interface ProviderResult {
  /** Provider name reported in `Screening.provider` (`local` in v1). */
  readonly name: string;
  /** Definitive list hits (block reasons); a hit blocks even when the provider is otherwise unavailable. */
  readonly hits: readonly string[];
  /** Null when the provider answered; otherwise the degraded reason (e.g. `sanctions_list_unavailable`). */
  readonly unavailable: string | null;
  /** Risk level of a risk-scoring provider; null for list-only providers (`local`). */
  readonly risk: Risk | null;
}

export interface ScreeningFacts {
  readonly livemode: boolean;
  readonly sandboxBlocked: boolean;
  readonly provider: ProviderResult;
  readonly cached: { readonly decision: Decision; readonly reasons: readonly string[] } | null;
  readonly amountUsdMicros: bigint | null;
  readonly failClosedThresholdUsdMicros: bigint;
}

export type ScreeningOutcome =
  | {
      readonly kind: "decided";
      readonly decision: Decision;
      readonly reasons: readonly string[];
      readonly risk: string | null;
      readonly provider: string;
      readonly postScreenRequired: boolean;
      /** Served from the cache (nothing to persist). */
      readonly cached: boolean;
    }
  | { readonly kind: "unavailable" };

export const SANDBOX_PROVIDER = "sandbox";

const decided = (
  decision: Decision,
  reasons: readonly string[],
  provider: string,
  o: { risk?: string | null; postScreenRequired?: boolean; cached?: boolean } = {},
): ScreeningOutcome => ({
  kind: "decided",
  decision,
  reasons: [...reasons],
  risk: o.risk ?? null,
  provider,
  postScreenRequired: o.postScreenRequired ?? false,
  cached: o.cached ?? false,
});

export function decide(f: ScreeningFacts): ScreeningOutcome {
  if (!f.livemode)
    return f.sandboxBlocked
      ? decided("block", ["sandbox_magic"], SANDBOX_PROVIDER)
      : decided("allow", [], SANDBOX_PROVIDER);
  const p = f.provider;
  if (p.hits.length > 0) return decided("block", p.hits, p.name);
  if (p.unavailable !== null)
    return f.amountUsdMicros === null || f.amountUsdMicros >= f.failClosedThresholdUsdMicros
      ? { kind: "unavailable" }
      : decided("allow", [p.unavailable], p.name, { postScreenRequired: true });
  if (f.cached) return decided(f.cached.decision, f.cached.reasons, p.name, { cached: true });
  switch (p.risk) {
    case null:
      return decided("allow", [], p.name);
    case "severe":
    case "high":
      return decided("block", ["provider_risk"], p.name, { risk: p.risk });
    case "medium":
      return decided("review", ["provider_risk"], p.name, { risk: p.risk });
    default:
      return decided("allow", [], p.name, { risk: p.risk });
  }
}

/** Cache lifetime (LLD §4): allow 24 h, block 7 days, review 24 h; a degraded allow is not cached. */
export function cacheTtlMs(decision: Decision, postScreenRequired = false): number {
  if (postScreenRequired) return 0;
  return decision === "block" ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
}

/** Provider name of a stored screening (Stage 1 rows say `local_list`, `cache` or `vendor`). */
export function storedProvider(stored: string): "local" | "sandbox" {
  return stored === SANDBOX_PROVIDER ? "sandbox" : "local";
}
