import { describe, expect, it } from "vitest";
import { isReview, severityOf, transitionCase } from "../../src/domain/case/case.js";
import { normalizePolicy, PolicyError } from "../../src/domain/geo-policy/policy.js";
import { decideKyb, KYB_STATUSES, kybSubject, startKyb } from "../../src/domain/kyb-case/kyb.js";

describe("KYB case", () => {
  it("starting moves not_started and needs_info to pending, leaves the rest", () => {
    expect(startKyb("not_started")).toEqual({ changed: true, to: "pending" });
    expect(startKyb("needs_info")).toEqual({ changed: true, to: "pending" });
    for (const s of ["pending", "approved", "rejected"] as const) expect(startKyb(s)).toEqual({ changed: false });
  });
  it("a decision changes any other state and is idempotent on its own state", () => {
    for (const from of KYB_STATUSES)
      for (const d of ["approved", "rejected", "needs_info"] as const)
        expect(decideKyb(from, d)).toEqual(from === d ? { changed: false } : { changed: true, to: d });
  });
  it("names the event", () => {
    expect(kybSubject("approved")).toBe("evt.compliance.kyb.approved");
    expect(kybSubject("needs_info")).toBe("evt.compliance.kyb.needs_info");
  });
});

describe("compliance cases", () => {
  it("payment subjects are reviews; destinations and accounts are ops-internal", () => {
    expect(isReview("post_screen_hit", { type: "execution", id: "ex_1" })).toBe(true);
    expect(isReview("held_execution", { type: "execution", id: "ex_1" })).toBe(true);
    expect(isReview("audit_mismatch", { type: "agent_payment", id: "ap_1" })).toBe(true);
    expect(isReview("screening_hit", { type: "payment_intent", id: "pi_1" })).toBe(true);
    expect(isReview("screening_hit", { type: "settlement_destination", id: "sd_1" })).toBe(false);
    expect(isReview("merchant_report", { type: "execution", id: "ex_1" })).toBe(false);
    expect(isReview("screening_hit", { type: "account", id: "acct_1" })).toBe(false);
  });
  it("severity: test mode low; live audit critical, holds and hits high, reports medium", () => {
    for (const k of [
      "audit_mismatch",
      "held_execution",
      "post_screen_hit",
      "screening_hit",
      "merchant_report",
    ] as const)
      expect(severityOf(k, false)).toBe("low");
    expect(severityOf("audit_mismatch", true)).toBe("critical");
    expect(severityOf("held_execution", true)).toBe("high");
    expect(severityOf("post_screen_hit", true)).toBe("high");
    expect(severityOf("screening_hit", true)).toBe("high");
    expect(severityOf("merchant_report", true)).toBe("medium");
  });
  it("transitions: open → investigating → closed; closed is terminal; no self-transitions", () => {
    expect(transitionCase("open", "investigating")).toEqual({ ok: true, to: "investigating" });
    expect(transitionCase("open", "closed")).toEqual({ ok: true, to: "closed" });
    expect(transitionCase("investigating", "closed")).toEqual({ ok: true, to: "closed" });
    expect(transitionCase("investigating", "open")).toEqual({ ok: true, to: "open" });
    expect(transitionCase("open", "open")).toMatchObject({ ok: false });
    expect(transitionCase("closed", "open")).toEqual({ ok: false, reason: "the case is closed" });
    expect(transitionCase("closed", "closed")).toMatchObject({ ok: false });
  });
});

describe("geo policy", () => {
  it("normalises (trim, upper-case, de-duplicate, sort)", () => {
    expect(normalizePolicy({ blockedCountries: [" ir", "CU", "cu", ""], blockedRegions: ["ua-43", "UA-09"] })).toEqual({
      blockedCountries: ["CU", "IR"],
      blockedRegions: ["UA-09", "UA-43"],
    });
    expect(normalizePolicy({ blockedCountries: [], blockedRegions: [] })).toEqual({
      blockedCountries: [],
      blockedRegions: [],
    });
  });
  it("rejects invalid codes", () => {
    expect(() => normalizePolicy({ blockedCountries: ["IRN"], blockedRegions: [] })).toThrow(PolicyError);
    expect(() => normalizePolicy({ blockedCountries: ["I1"], blockedRegions: [] })).toThrow(/country code/);
    expect(() => normalizePolicy({ blockedCountries: [], blockedRegions: ["UA43"] })).toThrow(/region code/);
    expect(() => normalizePolicy({ blockedCountries: [], blockedRegions: ["UA-1234"] })).toThrow(PolicyError);
  });
});
