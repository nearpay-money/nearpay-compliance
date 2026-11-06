import { describe, expect, it } from "vitest";
import { cacheTtlMs, decide, type ScreeningFacts } from "../../src/domain/screening/decision.js";

const THRESHOLD = 1_000_000_000n; // USD 1,000
const live = (over: Partial<ScreeningFacts> = {}): ScreeningFacts => ({
  livemode: true,
  sandboxBlocked: false,
  blocklisted: false,
  sanctioned: false,
  listLoaded: true,
  cached: null,
  vendor: "none",
  amountUsdMicros: null,
  failClosedThresholdUsdMicros: THRESHOLD,
  ...over,
});

describe("decide — test mode", () => {
  it("uses only the magic subject (lists, cache and vendor are not consulted)", () => {
    expect(decide(live({ livemode: false, sanctioned: true, blocklisted: true, listLoaded: false }))).toMatchObject({
      kind: "decided",
      decision: "allow",
      provider: "sandbox",
    });
    expect(decide(live({ livemode: false, sandboxBlocked: true }))).toMatchObject({
      decision: "block",
      reasons: ["sandbox_magic"],
      provider: "sandbox",
    });
  });
});

describe("decide — live mode", () => {
  it("blocks list hits with every matching reason, ahead of the cache", () => {
    const cached = { decision: "allow" as const, reasons: [] };
    expect(decide(live({ sanctioned: true, cached }))).toMatchObject({ decision: "block", reasons: ["sanctions"] });
    expect(decide(live({ blocklisted: true }))).toMatchObject({ decision: "block", reasons: ["blocklist"] });
    expect(decide(live({ sanctioned: true, blocklisted: true }))).toMatchObject({
      decision: "block",
      reasons: ["sanctions", "blocklist"],
      provider: "local_list",
      cached: false,
    });
  });

  it("serves a cached decision", () => {
    expect(decide(live({ cached: { decision: "review", reasons: ["vendor_risk"] } }))).toEqual({
      kind: "decided",
      decision: "review",
      reasons: ["vendor_risk"],
      risk: null,
      provider: "cache",
      postScreenRequired: false,
      cached: true,
    });
  });

  it("allows on the local list alone when no vendor is configured (Stage 1)", () => {
    expect(decide(live())).toMatchObject({
      decision: "allow",
      reasons: [],
      provider: "local_list",
      postScreenRequired: false,
    });
  });

  describe.each([
    ["no sanctions list imported yet", { listLoaded: false }, "sanctions_list_unavailable"],
    ["vendor unavailable", { vendor: "unavailable" as const }, "vendor_unavailable"],
  ])("fail-closed threshold — %s", (_name, over, reason) => {
    it("refuses at and above the threshold", () => {
      expect(decide(live({ ...over, amountUsdMicros: THRESHOLD }))).toEqual({ kind: "unavailable" });
      expect(decide(live({ ...over, amountUsdMicros: THRESHOLD + 1n }))).toEqual({ kind: "unavailable" });
    });
    it("allows below the threshold (or without an amount) with post-screening required", () => {
      for (const amount of [THRESHOLD - 1n, 0n, null])
        expect(decide(live({ ...over, amountUsdMicros: amount }))).toMatchObject({
          decision: "allow",
          reasons: [reason],
          postScreenRequired: true,
        });
    });
    it("still blocks list hits", () => {
      expect(decide(live({ ...over, blocklisted: true, amountUsdMicros: THRESHOLD }))).toMatchObject({
        decision: "block",
      });
    });
  });

  it("a missing list wins over the cache (a cached allow predates the list)", () => {
    expect(decide(live({ listLoaded: false, cached: { decision: "allow", reasons: [] } }))).toMatchObject({
      reasons: ["sanctions_list_unavailable"],
      cached: false,
    });
  });

  it("maps vendor risk (Stage 2)", () => {
    expect(decide(live({ vendor: { risk: "severe" } }))).toMatchObject({
      decision: "block",
      risk: "severe",
      provider: "vendor",
    });
    expect(decide(live({ vendor: { risk: "high" } }))).toMatchObject({ decision: "block", reasons: ["vendor_risk"] });
    expect(decide(live({ vendor: { risk: "medium" } }))).toMatchObject({ decision: "review", risk: "medium" });
    expect(decide(live({ vendor: { risk: "low" } }))).toMatchObject({ decision: "allow", reasons: [], risk: "low" });
  });
});

describe("cacheTtlMs", () => {
  it("caches allow and review 24 h, block 7 days, degraded allows not at all", () => {
    expect(cacheTtlMs("allow")).toBe(86_400_000);
    expect(cacheTtlMs("review")).toBe(86_400_000);
    expect(cacheTtlMs("block")).toBe(7 * 86_400_000);
    expect(cacheTtlMs("allow", true)).toBe(0);
  });
});
