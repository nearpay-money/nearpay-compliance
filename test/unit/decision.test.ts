import { describe, expect, it } from "vitest";
import {
  cacheTtlMs,
  decide,
  type ProviderResult,
  type ScreeningFacts,
  storedProvider,
} from "../../src/domain/screening/decision.js";

const THRESHOLD = 1_000_000_000n; // USD 1,000
const local = (over: Partial<ProviderResult> = {}): ProviderResult => ({
  name: "local",
  hits: [],
  unavailable: null,
  risk: null,
  ...over,
});
const live = (over: Partial<ScreeningFacts> = {}): ScreeningFacts => ({
  livemode: true,
  sandboxBlocked: false,
  provider: local(),
  cached: null,
  amountUsdMicros: null,
  failClosedThresholdUsdMicros: THRESHOLD,
  ...over,
});

describe("decide — test mode", () => {
  it("uses only the magic subject (provider and cache are not consulted)", () => {
    expect(
      decide(
        live({ livemode: false, provider: local({ hits: ["sanctions"], unavailable: "sanctions_list_unavailable" }) }),
      ),
    ).toMatchObject({ kind: "decided", decision: "allow", provider: "sandbox" });
    expect(decide(live({ livemode: false, sandboxBlocked: true }))).toMatchObject({
      decision: "block",
      reasons: ["sandbox_magic"],
      provider: "sandbox",
    });
  });
});

describe("decide — live mode, local provider", () => {
  it("blocks provider hits with every reason, ahead of the cache", () => {
    const cached = { decision: "allow" as const, reasons: [] };
    expect(decide(live({ provider: local({ hits: ["sanctions"] }), cached }))).toMatchObject({
      decision: "block",
      reasons: ["sanctions"],
    });
    expect(decide(live({ provider: local({ hits: ["sanctions", "blocklist"] }) }))).toMatchObject({
      decision: "block",
      reasons: ["sanctions", "blocklist"],
      provider: "local",
      cached: false,
    });
  });

  it("serves a cached decision under the provider's name", () => {
    expect(decide(live({ cached: { decision: "review", reasons: ["provider_risk"] } }))).toEqual({
      kind: "decided",
      decision: "review",
      reasons: ["provider_risk"],
      risk: null,
      provider: "local",
      postScreenRequired: false,
      cached: true,
    });
  });

  it("allows when the list provider is clear", () => {
    expect(decide(live())).toMatchObject({
      decision: "allow",
      reasons: [],
      provider: "local",
      postScreenRequired: false,
    });
  });

  describe.each([
    ["no sanctions list imported yet", "sanctions_list_unavailable"],
    ["a provider unavailable", "vendor_unavailable"],
  ])("fail-closed threshold — %s", (_name, reason) => {
    const down = local({ unavailable: reason });
    it("refuses at and above the threshold", () => {
      expect(decide(live({ provider: down, amountUsdMicros: THRESHOLD }))).toEqual({ kind: "unavailable" });
      expect(decide(live({ provider: down, amountUsdMicros: THRESHOLD + 1n }))).toEqual({ kind: "unavailable" });
    });
    it("refuses without an amount: an unknown amount cannot be shown to be below the threshold (audit finding 9)", () => {
      expect(decide(live({ provider: down, amountUsdMicros: null }))).toEqual({ kind: "unavailable" });
      expect(
        decide(live({ provider: down, amountUsdMicros: null, cached: { decision: "allow", reasons: [] } })),
      ).toEqual({ kind: "unavailable" });
    });
    it("allows below the threshold with post-screening required", () => {
      for (const amount of [THRESHOLD - 1n, 0n])
        expect(decide(live({ provider: down, amountUsdMicros: amount }))).toMatchObject({
          decision: "allow",
          reasons: [reason],
          postScreenRequired: true,
        });
    });
    it("still blocks list hits", () => {
      expect(decide(live({ provider: { ...down, hits: ["blocklist"] }, amountUsdMicros: THRESHOLD }))).toMatchObject({
        decision: "block",
      });
    });
    it("wins over the cache (a cached allow predates the outage)", () => {
      expect(
        decide(live({ provider: down, amountUsdMicros: THRESHOLD - 1n, cached: { decision: "allow", reasons: [] } })),
      ).toMatchObject({
        reasons: [reason],
        cached: false,
      });
    });
  });

  it("maps a risk-scoring provider (a later vendor behind the same interface)", () => {
    const vendor = (risk: ProviderResult["risk"]) => local({ name: "vendor", risk });
    expect(decide(live({ provider: vendor("severe") }))).toMatchObject({
      decision: "block",
      risk: "severe",
      provider: "vendor",
    });
    expect(decide(live({ provider: vendor("high") }))).toMatchObject({ decision: "block", reasons: ["provider_risk"] });
    expect(decide(live({ provider: vendor("medium") }))).toMatchObject({ decision: "review", risk: "medium" });
    expect(decide(live({ provider: vendor("low") }))).toMatchObject({ decision: "allow", reasons: [], risk: "low" });
  });
});

describe("cacheTtlMs and stored providers", () => {
  it("caches allow and review 24 h, block 7 days, degraded allows not at all", () => {
    expect(cacheTtlMs("allow")).toBe(86_400_000);
    expect(cacheTtlMs("review")).toBe(86_400_000);
    expect(cacheTtlMs("block")).toBe(7 * 86_400_000);
    expect(cacheTtlMs("allow", true)).toBe(0);
  });
  it("renders Stage 1 provider names as `local`", () => {
    for (const p of ["local_list", "cache", "vendor", "local"]) expect(storedProvider(p)).toBe("local");
    expect(storedProvider("sandbox")).toBe("sandbox");
  });
});
