import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizePolicy } from "../../src/domain/geo-policy/policy.js";
import { decideKyb, type KybDecision, type KybStatus, startKyb } from "../../src/domain/kyb-case/kyb.js";
import { decide, type ScreeningFacts } from "../../src/domain/screening/decision.js";
import { classifyListedAddress } from "../../src/domain/screening/sanctions.js";
import { normalizeSubject } from "../../src/domain/screening/subject.js";

const hex40 = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => Buffer.from(b).toString("hex"));
const decision = fc.constantFrom("allow" as const, "block" as const, "review" as const);
const reasonsOf = fc.subarray(["sanctions", "blocklist"]);
const facts: fc.Arbitrary<ScreeningFacts> = fc.record({
  livemode: fc.boolean(),
  sandboxBlocked: fc.boolean(),
  provider: fc.record({
    name: fc.constantFrom("local", "vendor"),
    hits: reasonsOf,
    unavailable: fc.option(fc.constantFrom("sanctions_list_unavailable", "vendor_unavailable"), { nil: null }),
    risk: fc.option(fc.constantFrom("severe" as const, "high" as const, "medium" as const, "low" as const), {
      nil: null,
    }),
  }),
  cached: fc.option(fc.record({ decision, reasons: fc.array(fc.string(), { maxLength: 2 }) }), { nil: null }),
  amountUsdMicros: fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n }), { nil: null }),
  failClosedThresholdUsdMicros: fc.bigInt({ min: 0n, max: 10n ** 13n }),
});

describe("screening decision properties", () => {
  it("test mode depends only on the magic subject", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const o = decide({ ...f, livemode: false });
        expect(o).toMatchObject({
          kind: "decided",
          provider: "sandbox",
          decision: f.sandboxBlocked ? "block" : "allow",
        });
      }),
    );
  });

  it("a live list hit always blocks, whatever the cache, provider state or amount", () => {
    fc.assert(
      fc.property(facts, fc.boolean(), (f, both) => {
        const hits = both ? ["sanctions", "blocklist"] : ["sanctions"];
        const o = decide({ ...f, livemode: true, provider: { ...f.provider, hits } });
        expect(o).toMatchObject({ kind: "decided", decision: "block", reasons: hits });
      }),
    );
  });

  it("degraded screening never allows a payment at or above the fail-closed threshold", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const g = { ...f, livemode: true, provider: { ...f.provider, hits: [] } };
        const degraded = g.provider.unavailable !== null;
        const o = decide(g);
        if (degraded && g.amountUsdMicros !== null && g.amountUsdMicros >= g.failClosedThresholdUsdMicros)
          expect(o).toEqual({ kind: "unavailable" });
        if (o.kind === "unavailable") expect(degraded && g.amountUsdMicros !== null).toBe(true);
        if (o.kind === "decided" && o.postScreenRequired)
          expect(o.decision === "allow" && o.reasons.length === 1).toBe(true);
      }),
    );
  });
});

describe("normalisation properties", () => {
  it("EVM addresses: one key per address whatever the hex case, and normalising is idempotent", () => {
    fc.assert(
      fc.property(hex40, fc.constantFrom("eip155:1", "eip155:8453", "eip155:42161"), (h, chain) => {
        const lower = normalizeSubject("address", `0x${h}`, chain);
        const upper = normalizeSubject("address", `0x${h.toUpperCase()}`, chain);
        expect(upper.listKeys).toEqual(lower.listKeys);
        expect(normalizeSubject("address", lower.norm, chain)).toEqual(lower);
        // the OFAC side produces the same key for the same address
        expect(classifyListedAddress("ETH", `0x${h.toUpperCase()}`)).toEqual(lower.listKeys[0]);
      }),
    );
  });

  it("listed-address classification is idempotent", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("XBT", "ETH", "USDT", "TRX", "SOL", "LTC", "XMR"),
        fc.stringMatching(/^[0-9A-Za-z]{20,60}$/),
        (code, a) => {
          const k = classifyListedAddress(code, a);
          if (k) expect(classifyListedAddress(code, k.address)).toEqual(k);
        },
      ),
    );
  });

  it("geo policy normalisation is idempotent", () => {
    const cc = fc.stringMatching(/^[A-Za-z]{2}$/);
    fc.assert(
      fc.property(fc.array(cc), fc.array(fc.tuple(cc, fc.stringMatching(/^[A-Za-z0-9]{1,3}$/))), (cs, rs) => {
        const p = normalizePolicy({ blockedCountries: cs, blockedRegions: rs.map(([c, r]) => `${c}-${r}`) });
        expect(normalizePolicy(p)).toEqual(p);
      }),
    );
  });
});

describe("KYB properties (manual Stage 1 path)", () => {
  it("after any sequence of manual decisions the state is the last decision, and only changes emit", () => {
    const cmd = fc.oneof(
      fc.constant({ start: true } as const),
      fc.constantFrom<KybDecision>("approved", "rejected", "needs_info").map((d) => ({ start: false, d }) as const),
    );
    fc.assert(
      fc.property(fc.array(cmd, { maxLength: 20 }), (cmds) => {
        let s: KybStatus = "not_started";
        let events = 0;
        for (const c of cmds) {
          const step: ReturnType<typeof startKyb> = c.start ? startKyb(s) : decideKyb(s, c.d);
          if (step.changed) {
            expect(step.to).not.toBe(s);
            s = step.to;
            events++;
          }
        }
        const decisions = cmds.filter((c) => !c.start);
        expect(events).toBeLessThanOrEqual(decisions.length);
        const last = decisions.at(-1);
        expect(s).toBe(last && !last.start ? last.d : "not_started");
      }),
    );
  });
});
