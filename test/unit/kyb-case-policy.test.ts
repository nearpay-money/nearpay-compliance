import { describe, expect, it } from "vitest";
import {
  assignCase,
  closeCase,
  isReview,
  resolutionOf,
  severityOf,
  severityRank,
  timelineAction,
  transitionCase,
} from "../../src/domain/case/case.js";
import { normalizePolicy, PolicyError } from "../../src/domain/geo-policy/policy.js";
import {
  decideConsole,
  decideKyb,
  isEditable,
  KYB_STATUSES,
  kybSubject,
  startKyb,
  submitKyb,
} from "../../src/domain/kyb-case/kyb.js";

describe("KYB case", () => {
  it("starting only creates/returns the case (pending means submitted since Stage 2)", () => {
    for (const s of KYB_STATUSES) expect(startKyb(s)).toEqual({ changed: false });
  });
  it("the owner edits and submits only in not_started / needs_info", () => {
    expect(KYB_STATUSES.filter(isEditable)).toEqual(["not_started", "needs_info"]);
    expect(submitKyb("not_started", [])).toEqual({ ok: true, to: "pending" });
    expect(submitKyb("needs_info", [])).toEqual({ ok: true, to: "pending" });
    for (const s of ["pending", "approved", "rejected"] as const)
      expect(submitKyb(s, [])).toEqual({ ok: false, reason: "state" });
    expect(submitKyb("not_started", ["legal_name"])).toEqual({
      ok: false,
      reason: "incomplete",
      missing: ["legal_name"],
    });
    // the state check comes first: a decided case is a conflict, whatever the profile
    expect(submitKyb("approved", ["legal_name"])).toEqual({ ok: false, reason: "state" });
  });
  it("console decisions follow the state table", () => {
    const ok = { requestedInfo: "add your register number", profileComplete: true };
    expect(decideConsole("pending", "approved", ok)).toEqual({ changed: true, to: "approved" });
    for (const s of ["not_started", "needs_info", "rejected"] as const)
      expect(decideConsole(s, "approved", ok)).toMatchObject({ error: "state_conflict" });
    expect(decideConsole("pending", "rejected", ok)).toEqual({ changed: true, to: "rejected" });
    expect(decideConsole("approved", "rejected", ok)).toEqual({ changed: true, to: "rejected" });
    for (const s of ["not_started", "needs_info"] as const)
      expect(decideConsole(s, "rejected", ok)).toMatchObject({ error: "state_conflict" });
    for (const s of ["pending", "approved", "rejected"] as const)
      expect(decideConsole(s, "needs_info", ok)).toEqual({ changed: true, to: "needs_info" });
    expect(decideConsole("not_started", "needs_info", ok)).toMatchObject({ error: "state_conflict" });
    for (const d of ["approved", "rejected", "needs_info"] as const)
      expect(decideConsole(d, d, { requestedInfo: undefined, profileComplete: false })).toEqual({ changed: false });
  });
  it("console needs_info needs requested_info; approval needs a complete declaration", () => {
    expect(decideConsole("pending", "needs_info", { requestedInfo: undefined, profileComplete: true })).toMatchObject({
      error: "requested_info_required",
    });
    expect(decideConsole("pending", "needs_info", { requestedInfo: "  ", profileComplete: true })).toMatchObject({
      error: "requested_info_required",
    });
    expect(decideConsole("pending", "approved", { requestedInfo: undefined, profileComplete: false })).toMatchObject({
      error: "profile_incomplete",
    });
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
  it("reconciliation diffs are high in live mode and never reviews", () => {
    expect(severityOf("reconciliation_diff", true)).toBe("high");
    expect(severityOf("reconciliation_diff", false)).toBe("low");
    expect(isReview("reconciliation_diff", { type: "reconciliation_run" })).toBe(false);
    expect(isReview("screening_hit", { type: "reconciliation_run" })).toBe(false);
  });
  it("console assignment and closing", () => {
    expect(assignCase("open", "usr_1")).toEqual({ ok: true, to: "investigating" });
    expect(assignCase("investigating", "usr_1")).toEqual({ ok: true, to: "investigating" });
    expect(assignCase("open", null)).toEqual({ ok: true, to: "open" });
    expect(assignCase("investigating", null)).toEqual({ ok: true, to: "investigating" });
    expect(assignCase("closed", "usr_1")).toMatchObject({ ok: false });
    expect(assignCase("closed", null)).toMatchObject({ ok: false });
    expect(closeCase("open")).toEqual({ ok: true, to: "closed" });
    expect(closeCase("investigating")).toEqual({ ok: true, to: "closed" });
    expect(closeCase("closed")).toMatchObject({ ok: false });
  });
  it("renders stored resolutions, timeline actions and severity ranks", () => {
    expect(resolutionOf(null)).toBeNull();
    expect(resolutionOf("false_positive")).toBe("false_positive");
    expect(resolutionOf("checked the registry, fine")).toBe("other");
    expect(timelineAction("opened")).toBe("opened");
    expect(timelineAction("assigned")).toBe("assigned");
    expect(timelineAction("unassigned")).toBe("unassigned");
    expect(timelineAction("closed")).toBe("closed");
    expect(timelineAction("investigating")).toBe("assigned");
    expect(timelineAction("note")).toBe("commented");
    expect(timelineAction("commented")).toBe("commented");
    expect(["low", "medium", "high", "critical", "bogus"].map(severityRank)).toEqual([1, 2, 3, 4, 0]);
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
