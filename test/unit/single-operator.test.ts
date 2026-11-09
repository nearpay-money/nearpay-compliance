/**
 * Adaptive two-person rule for suspend/reinstate (domain/ops-approval/approval.ts, LLD §5.1
 * "Single-operator platforms"), the extra claims and the counter.
 */
import { newId } from "@nearpay-internal/ids";
import { createMetrics } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import { registerSingleOperatorCounter } from "../../src/app/single-operator-metrics.js";
import { checkSingleOperatorDelay } from "../../src/config.js";
import { checkOperator } from "../../src/domain/ops/principal.js";
import {
  type Approval,
  approve,
  madeBySingleOperator,
  type Operator,
  SINGLE_OPERATOR_REASON_MIN,
  singleOperatorAvailableAt,
} from "../../src/domain/ops-approval/approval.js";

const owner = newId("usr");
const T0 = 1_800_000_000_000;
const DELAY_S = 300;
const REASON = "only operator; fraud confirmed by chain analysis";
const pending = (o: Partial<Approval> = {}): Approval => ({
  action: "account.suspend",
  status: "pending",
  requestedBy: owner,
  expiresAt: T0 + 86_400_000,
  requestedAt: T0,
  requestedAdmins: 1,
  ...o,
});
const me = (authAtMs: number, activeAdmins?: number): Operator => ({
  sub: owner,
  role: "ops_admin",
  ...(activeAdmins !== undefined ? { activeAdmins } : {}),
  authAt: Math.floor(authAtMs / 1000),
});
const after = T0 + DELAY_S * 1000 + 1_000;
const opts = (now: number, note: string | undefined = REASON) => ({
  suspended: false,
  now,
  delaySeconds: DELAY_S,
  note,
});

describe("adaptive two-person rule (suspend/reinstate)", () => {
  it("one approver when requested and now: the requester completes it after the wait, re-verified, with a reason", () => {
    expect(approve(pending(), me(after, 1), opts(after))).toEqual({ kind: "approved", singleOperator: true });
  });

  it("requested with two or more approvers: refused even if only one is left now (revoked mid-action)", () => {
    expect(approve(pending({ requestedAdmins: 2 }), me(after, 1), opts(after))).toMatchObject({
      error: "approver_conflict",
    });
  });

  it("a second approver added since: the rule is back on", () => {
    expect(approve(pending(), me(after, 2), opts(after))).toMatchObject({ error: "approver_conflict" });
  });

  it("unknown counts fail closed", () => {
    expect(approve(pending(), me(after), opts(after))).toMatchObject({ error: "approver_conflict" });
    expect(approve(pending({ requestedAdmins: null }), me(after, 1), opts(after))).toMatchObject({
      error: "approver_conflict",
    });
    expect(approve(pending({ requestedAt: undefined }), me(after, 1), opts(after))).toMatchObject({
      error: "approver_conflict",
    });
  });

  it("before the wait: refused naming when; a verification from before it ended does not count", () => {
    const early = T0 + DELAY_S * 1000 - 1;
    expect(approve(pending(), me(early, 1), opts(early))).toMatchObject({ error: "approver_conflict" });
    expect(approve(pending(), me(T0 + 1_000, 1), opts(after))).toMatchObject({ error: "step_up_required" });
    expect(approve(pending(), { sub: owner, role: "ops_admin", activeAdmins: 1 }, opts(after))).toMatchObject({
      error: "step_up_required",
    });
  });

  it("needs a written reason of the minimum length", () => {
    for (const note of [undefined, " ", "y".repeat(SINGLE_OPERATOR_REASON_MIN - 1)])
      expect(approve(pending(), me(after, 1), { ...opts(after), note })).toMatchObject({ error: "reason_required" });
  });

  it("a zero wait is allowed for account actions (still re-verified and with a reason)", () => {
    expect(approve(pending(), me(T0 + 1, 1), { suspended: false, now: T0 + 1, delaySeconds: 0, note: REASON })).toEqual(
      { kind: "approved", singleOperator: true },
    );
  });

  it("expiry and a changed account state still win; plain ops never approve", () => {
    expect(approve(pending({ expiresAt: after }), me(after, 1), opts(after))).toEqual({
      kind: "expire",
      reason: "expired",
    });
    expect(approve(pending(), me(after, 1), { ...opts(after), suspended: true })).toEqual({
      kind: "expire",
      reason: "state_changed",
    });
    expect(approve(pending(), { ...me(after, 1), role: "ops" }, opts(after))).toMatchObject({
      error: "approver_conflict",
    });
  });

  it("a different operator approves through the two-person path", () => {
    expect(approve(pending({ requestedAdmins: 2 }), { sub: newId("usr"), role: "ops_admin" }, opts(T0 + 1))).toEqual({
      kind: "approved",
    });
  });

  it("availability is reported only for single-operator requests", () => {
    expect(singleOperatorAvailableAt(pending(), DELAY_S)).toBe(T0 + DELAY_S * 1000);
    expect(singleOperatorAvailableAt(pending({ requestedAdmins: 3 }), DELAY_S)).toBeNull();
    expect(madeBySingleOperator(pending({ requestedAdmins: 0 }))).toBe(true);
  });
});

describe("extra claims", () => {
  const route = { opsRoles: ["ops_admin"], stepUp: true };
  const t = 1_800_000_000;
  it("carries identity's ops_admins / ops_auth_at; malformed values count as absent", () => {
    expect(
      checkOperator(
        { ptype: "ops", sub: owner, ops_role: "ops_admin", step_up_until: t + 60, ops_admins: 1, ops_auth_at: t - 5 },
        route,
        t,
      ),
    ).toEqual({ ok: true, operator: { sub: owner, role: "ops_admin", activeAdmins: 1, authAt: t - 5 } });
    expect(
      checkOperator(
        { ptype: "ops", sub: owner, ops_role: "ops_admin", step_up_until: t + 60, ops_admins: "1", ops_auth_at: -1 },
        route,
        t,
      ),
    ).toEqual({ ok: true, operator: { sub: owner, role: "ops_admin" } });
  });
});

it("the wait must end before the request expires", () => {
  expect(() => checkSingleOperatorDelay({ opsSingleOperatorDelayS: 300, opsApprovalTtlSeconds: 86_400 })).not.toThrow();
  expect(() => checkSingleOperatorDelay({ opsSingleOperatorDelayS: 600, opsApprovalTtlSeconds: 600 })).toThrow(
    /NP_OPS_SINGLE_OPERATOR_DELAY_S/,
  );
});

it("exports nearpay_ops_single_operator_actions_total{action}", async () => {
  const m = createMetrics("compliance", { defaultMetrics: false });
  registerSingleOperatorCounter(m)("account.suspend");
  expect(await m.render()).toContain('nearpay_ops_single_operator_actions_total{action="account.suspend"} 1');
});
