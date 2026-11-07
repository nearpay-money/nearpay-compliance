import { newId } from "@nearpay-internal/ids";
import { describe, expect, it } from "vitest";
import { emptyProfile, mergeProfile, missingFields, profileFromJson } from "../../src/domain/kyb-case/profile.js";
import { checkOperator } from "../../src/domain/ops/principal.js";
import {
  actionApplies,
  approvalAction,
  approve,
  reject,
  requestAction,
  sweep,
} from "../../src/domain/ops-approval/approval.js";
import { normalizeBlocklistSubject, SubjectError } from "../../src/domain/screening/subject.js";

const complete = {
  legal_name: "  Acme   Trading Ltd ",
  country_of_incorporation: "gb",
  registration_number: "01234567",
  business_type: "company" as const,
  business_address: { line1: "1 High St", city: "London", country: "gb", postal_code: "N1 1AA" },
  representative: { name: "Jane Doe", title: "Director" },
  expected_monthly_volume: "under_10k" as const,
};

describe("KYB profile", () => {
  it("starts empty with every required field missing (website is optional)", () => {
    expect(missingFields(emptyProfile())).toEqual([
      "legal_name",
      "country_of_incorporation",
      "registration_number",
      "business_type",
      "business_address",
      "representative",
      "expected_monthly_volume",
    ]);
  });
  it("merges a partial update, normalising text and codes, and reports changed fields", () => {
    const { profile, changed } = mergeProfile(emptyProfile(), complete);
    expect(profile).toMatchObject({
      legal_name: "Acme Trading Ltd",
      country_of_incorporation: "GB",
      website: null,
      business_address: {
        line1: "1 High St",
        line2: null,
        city: "London",
        postal_code: "N1 1AA",
        region: null,
        country: "GB",
      },
    });
    expect(missingFields(profile)).toEqual([]);
    expect(changed).not.toContain("website");
    expect(mergeProfile(profile, {}).changed).toEqual([]);
    expect(mergeProfile(profile, { legal_name: "Acme Trading Ltd" }).changed).toEqual([]);
  });
  it("null clears, absent keeps, blank text clears", () => {
    const { profile } = mergeProfile(emptyProfile(), { ...complete, website: "https://acme.example" });
    const cleared = mergeProfile(profile, {
      website: null,
      representative: null,
      business_address: null,
      legal_name: "   ",
    });
    expect(cleared.profile).toMatchObject({
      website: null,
      representative: null,
      business_address: null,
      legal_name: null,
    });
    expect(cleared.changed.sort()).toEqual(["business_address", "legal_name", "representative", "website"]);
    expect(missingFields(cleared.profile)).toEqual(["legal_name", "business_address", "representative"]);
    const other = mergeProfile(profile, {
      country_of_incorporation: null,
      business_type: null,
      registration_number: null,
      expected_monthly_volume: null,
    });
    expect(missingFields(other.profile)).toEqual([
      "country_of_incorporation",
      "registration_number",
      "business_type",
      "expected_monthly_volume",
    ]);
  });
  it("parses stored JSON defensively", () => {
    expect(profileFromJson(null)).toEqual(emptyProfile());
    expect(profileFromJson("x")).toEqual(emptyProfile());
    expect(profileFromJson({ legal_name: "A", extra: 1 })).toEqual({ ...emptyProfile(), legal_name: "A" });
  });
});

describe("two-person approval", () => {
  const alice = { sub: newId("usr"), role: "ops" as const };
  const bob = { sub: newId("usr"), role: "ops_admin" as const };
  const carol = { sub: newId("usr"), role: "ops_admin" as const };
  const now = 1_800_000_000_000;
  const pending = (over = {}) => ({
    action: "account.suspend" as const,
    status: "pending" as const,
    requestedBy: alice.sub,
    expiresAt: now + 3_600_000,
    ...over,
  });

  it("requests only change something and only one at a time", () => {
    expect(approvalAction("suspend")).toBe("account.suspend");
    expect(approvalAction("reinstate")).toBe("account.reinstate");
    expect(actionApplies("account.suspend", false)).toBe(true);
    expect(actionApplies("account.suspend", true)).toBe(false);
    expect(actionApplies("account.reinstate", true)).toBe(true);
    expect(requestAction("suspend", { suspended: false, pendingExists: false, now, ttlSeconds: 86_400 })).toEqual({
      ok: true,
      action: "account.suspend",
      expiresAt: now + 86_400_000,
    });
    expect(requestAction("suspend", { suspended: true, pendingExists: false, now, ttlSeconds: 60 })).toEqual({
      ok: false,
      reason: "already_in_state",
    });
    expect(requestAction("reinstate", { suspended: true, pendingExists: true, now, ttlSeconds: 60 })).toEqual({
      ok: false,
      reason: "pending_exists",
    });
  });
  it("approval needs a different ops_admin, before expiry, while the action still applies", () => {
    expect(approve(pending(), bob, { suspended: false, now })).toEqual({ kind: "approved" });
    expect(approve(pending({ requestedBy: bob.sub }), bob, { suspended: false, now })).toMatchObject({
      kind: "refuse",
      error: "approver_conflict",
    });
    expect(approve(pending(), { sub: newId("usr"), role: "ops" }, { suspended: false, now })).toMatchObject({
      error: "approver_conflict",
    });
    expect(approve(pending(), carol, { suspended: false, now: now + 3_600_000 })).toEqual({
      kind: "expire",
      reason: "expired",
    });
    expect(approve(pending(), carol, { suspended: true, now })).toEqual({ kind: "expire", reason: "state_changed" });
    for (const status of ["approved", "rejected", "expired"] as const)
      expect(approve(pending({ status }), carol, { suspended: false, now })).toMatchObject({ error: "state_conflict" });
  });
  it("rejection needs ops_admin (the requester may withdraw) and a pending, unexpired request", () => {
    expect(reject(pending({ requestedBy: bob.sub }), bob, { now })).toEqual({ kind: "rejected" });
    expect(reject(pending(), alice, { now })).toMatchObject({ error: "approver_conflict" });
    expect(reject(pending(), bob, { now: now + 3_600_000 })).toEqual({ kind: "expire", reason: "expired" });
    expect(reject(pending({ status: "approved" }), bob, { now })).toMatchObject({ error: "state_conflict" });
  });
  it("the sweep expires only pending requests past expiry", () => {
    expect(sweep(pending(), now)).toBe(false);
    expect(sweep(pending(), now + 3_600_000)).toBe(true);
    expect(sweep(pending({ status: "approved" }), now + 3_600_000)).toBe(false);
  });
});

describe("ops principal", () => {
  const sub = newId("usr");
  const route = { opsRoles: ["ops", "ops_admin"], stepUp: true };
  const t = 1_800_000_000;
  it("accepts an operator with a listed role and a fresh step-up", () => {
    expect(checkOperator({ ptype: "ops", sub, ops_role: "ops", step_up_until: t + 60 }, route, t)).toEqual({
      ok: true,
      operator: { sub, role: "ops" },
    });
    expect(checkOperator({ ptype: "ops", sub, ops_role: "ops" }, { opsRoles: ["ops"] }, t)).toMatchObject({ ok: true });
  });
  it("refuses everything else, fail closed", () => {
    expect(checkOperator(null, route, t)).toMatchObject({ error: "permission_denied" });
    expect(checkOperator({ ptype: "service", sub }, route, t)).toMatchObject({ error: "permission_denied" });
    expect(checkOperator({ ptype: "ops", sub: "usr_alice", ops_role: "ops" }, route, t)).toMatchObject({
      error: "permission_denied",
    });
    expect(checkOperator({ ptype: "ops", sub }, route, t)).toMatchObject({ error: "permission_denied" });
    expect(checkOperator({ ptype: "ops", sub, ops_role: "root" }, route, t)).toMatchObject({
      error: "permission_denied",
    });
    expect(
      checkOperator({ ptype: "ops", sub, ops_role: "ops", step_up_until: t + 60 }, { opsRoles: ["ops_admin"] }, t),
    ).toMatchObject({
      error: "permission_denied",
    });
    expect(checkOperator({ ptype: "ops", sub, ops_role: "ops" }, {}, t)).toMatchObject({ error: "permission_denied" });
    expect(checkOperator({ ptype: "ops", sub, ops_role: "ops", step_up_until: t }, route, t)).toMatchObject({
      error: "step_up_required",
    });
    expect(checkOperator({ ptype: "ops", sub, ops_role: "ops" }, route, t)).toMatchObject({
      error: "step_up_required",
    });
  });
});

describe("blocklist subjects", () => {
  it("normalises by form without a chain, like a screening subject with one", () => {
    expect(normalizeBlocklistSubject("address", "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toEqual({
      norm: "0xabcdef0123456789abcdef0123456789abcdef01",
      chain: null,
    });
    expect(normalizeBlocklistSubject("address", "BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH").norm).toBe(
      "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    );
    expect(normalizeBlocklistSubject("address", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf")).toEqual({
      norm: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      chain: null,
    });
    expect(normalizeBlocklistSubject("near_account", "Bad.NEAR")).toEqual({ norm: "bad.near", chain: null });
    expect(normalizeBlocklistSubject("address", "0xABCDEF0123456789ABCDEF0123456789ABCDEF01", "eip155:8453")).toEqual({
      norm: "0xabcdef0123456789abcdef0123456789abcdef01",
      chain: "eip155:8453",
    });
  });
  it("refuses malformed subjects", () => {
    for (const bad of ["", " 0x1", "a b", "x".repeat(257)])
      expect(() => normalizeBlocklistSubject("address", bad)).toThrow(SubjectError);
    expect(() => normalizeBlocklistSubject("address", "0x12", "eip155:1")).toThrow(SubjectError);
  });
});
