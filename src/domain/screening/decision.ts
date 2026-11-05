/**
 * Screening decision (compliance LLD §4). Pure: the caller gathers the facts (list hits, cache,
 * vendor result) and persists what this returns.
 *
 *   test mode               → magic only: `sanctioned` in the subject blocks, everything else allows
 *   blocklist / sanctions   → block (`blocklist` / `sanctions`), never cached past a list change
 *   no sanctions list yet   → like an unavailable vendor (`sanctions_list_unavailable`): a fresh
 *                             install must not pass large live payments unscreened
 *   cached decision         → returned as cached
 *   vendor (Stage 2+)       → severe/high block, medium review (allow + case), low allow
 *   vendor unavailable      → amount ≥ fail-closed threshold: unavailable (503); else allow with
 *                             `vendor_unavailable` and post-screening required
 *   no vendor (Stage 1)     → allow: the local list is the full screen
 *
 * A degraded allow (post-screening required) is recorded but never served from the cache, so the
 * next screen consults the recovered list/vendor.
 */

export type Decision = "allow" | "block" | "review";

export interface ScreeningFacts {
  readonly livemode: boolean;
  readonly sandboxBlocked: boolean;
  readonly blocklisted: boolean;
  readonly sanctioned: boolean;
  /** A sanctions list has been imported at least once. */
  readonly listLoaded: boolean;
  readonly cached: { readonly decision: Decision; readonly reasons: readonly string[] } | null;
  /** `none` = no vendor configured; otherwise the vendor's risk or `unavailable`. */
  readonly vendor: "none" | "unavailable" | { readonly risk: "severe" | "high" | "medium" | "low" };
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

const decided = (
  decision: Decision,
  reasons: string[],
  provider: string,
  o: { risk?: string | null; postScreenRequired?: boolean; cached?: boolean } = {},
): ScreeningOutcome => ({
  kind: "decided",
  decision,
  reasons,
  risk: o.risk ?? null,
  provider,
  postScreenRequired: o.postScreenRequired ?? false,
  cached: o.cached ?? false,
});

export function decide(f: ScreeningFacts): ScreeningOutcome {
  if (!f.livemode)
    return f.sandboxBlocked ? decided("block", ["sandbox_magic"], "sandbox") : decided("allow", [], "sandbox");
  if (f.blocklisted || f.sanctioned) {
    const reasons = [...(f.sanctioned ? ["sanctions"] : []), ...(f.blocklisted ? ["blocklist"] : [])];
    return decided("block", reasons, "local_list");
  }
  const degraded = (reason: string): ScreeningOutcome =>
    f.amountUsdMicros !== null && f.amountUsdMicros >= f.failClosedThresholdUsdMicros
      ? { kind: "unavailable" }
      : decided("allow", [reason], "local_list", { postScreenRequired: true });
  if (!f.listLoaded) return degraded("sanctions_list_unavailable");
  if (f.cached) return decided(f.cached.decision, [...f.cached.reasons], "cache", { cached: true });
  if (f.vendor === "none") return decided("allow", [], "local_list");
  if (f.vendor === "unavailable") return degraded("vendor_unavailable");
  switch (f.vendor.risk) {
    case "severe":
    case "high":
      return decided("block", ["vendor_risk"], "vendor", { risk: f.vendor.risk });
    case "medium":
      return decided("review", ["vendor_risk"], "vendor", { risk: f.vendor.risk });
    default:
      return decided("allow", [], "vendor", { risk: f.vendor.risk });
  }
}

/** Cache lifetime (LLD §4): allow 24 h, block 7 days, review 24 h; a degraded allow is not cached. */
export function cacheTtlMs(decision: Decision, postScreenRequired = false): number {
  if (postScreenRequired) return 0;
  return decision === "block" ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
}
