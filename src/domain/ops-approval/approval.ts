/**
 * Two-person rule for merchant suspension (compliance LLD §5.1, spec `OpsApproval`, security T-12). Pure.
 *
 * Nothing changes on a request: the second operator's approval executes the action in the same
 * transaction. Server-side rules, decided on the verified ops principal only:
 *
 * | from    | command | guard                                                         | to       |
 * |---------|---------|---------------------------------------------------------------|----------|
 * | —       | request | action differs from the account state; no pending request     | pending  |
 * | pending | approve | now < expires_at; approver is ops_admin AND a different `sub`; | approved |
 * |         |         | the action still differs from the account state               |          |
 * | pending | approve | now ≥ expires_at, or the account state already matches        | expired  |
 * | pending | reject  | now < expires_at; decider is ops_admin (requester may withdraw)| rejected |
 * | pending | reject  | now ≥ expires_at                                              | expired  |
 * | pending | sweep   | now ≥ expires_at                                              | expired  |
 * | other   | any     | —                                                             | refused  |
 *
 * An approval therefore always involves two distinct operators, and never happens after expiry.
 */

export type OpsRole = "ops" | "ops_admin";
export type SuspensionAction = "suspend" | "reinstate";
export type ApprovalAction = "account.suspend" | "account.reinstate";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Operator {
  readonly sub: string;
  readonly role: OpsRole;
}

export interface Approval {
  readonly action: ApprovalAction;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly expiresAt: number;
}

export const DEFAULT_TTL_SECONDS = 24 * 3600;

/** The only `NP_ENV` values on which the single-person suspension commands (ops CLI) are allowed. */
export const SINGLE_PERSON_ENVS: ReadonlySet<string> = new Set(["local", "test"]);

/**
 * Allow-list, fail closed: `server`, an unknown stage, an empty or mistyped value all require the
 * two-person console path (audit finding 2, stage 2).
 */
export function singlePersonAllowed(env: string): boolean {
  return SINGLE_PERSON_ENVS.has(env);
}

export const approvalAction = (a: SuspensionAction): ApprovalAction =>
  a === "suspend" ? "account.suspend" : "account.reinstate";

/** Whether executing `action` would change an account whose suspension state is `suspended`. */
export function actionApplies(action: ApprovalAction, suspended: boolean): boolean {
  return action === "account.suspend" ? !suspended : suspended;
}

export type RequestStep =
  | { readonly ok: true; readonly action: ApprovalAction; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: "already_in_state" | "pending_exists" };

export function requestAction(
  action: SuspensionAction,
  o: { suspended: boolean; pendingExists: boolean; now: number; ttlSeconds: number },
): RequestStep {
  const a = approvalAction(action);
  if (!actionApplies(a, o.suspended)) return { ok: false, reason: "already_in_state" };
  if (o.pendingExists) return { ok: false, reason: "pending_exists" };
  return { ok: true, action: a, expiresAt: o.now + o.ttlSeconds * 1000 };
}

export type DecideStep =
  | { readonly kind: "approved" | "rejected" }
  | { readonly kind: "expire"; readonly reason: "expired" | "state_changed" }
  | { readonly kind: "refuse"; readonly error: "approver_conflict"; readonly reason: string }
  | { readonly kind: "refuse"; readonly error: "state_conflict"; readonly reason: string };

export function approve(a: Approval, approver: Operator, o: { suspended: boolean; now: number }): DecideStep {
  if (a.status !== "pending") return { kind: "refuse", error: "state_conflict", reason: `the request is ${a.status}` };
  if (approver.role !== "ops_admin")
    return { kind: "refuse", error: "approver_conflict", reason: "the approver must hold ops_admin." };
  if (approver.sub === a.requestedBy)
    return { kind: "refuse", error: "approver_conflict", reason: "the requester cannot approve their own request." };
  if (o.now >= a.expiresAt) return { kind: "expire", reason: "expired" };
  if (!actionApplies(a.action, o.suspended)) return { kind: "expire", reason: "state_changed" };
  return { kind: "approved" };
}

export function reject(a: Approval, decider: Operator, o: { now: number }): DecideStep {
  if (a.status !== "pending") return { kind: "refuse", error: "state_conflict", reason: `the request is ${a.status}` };
  if (decider.role !== "ops_admin")
    return { kind: "refuse", error: "approver_conflict", reason: "rejecting needs ops_admin." };
  if (o.now >= a.expiresAt) return { kind: "expire", reason: "expired" };
  return { kind: "rejected" };
}

/** Background sweep: a pending request past its expiry becomes `expired`. */
export function sweep(a: Approval, now: number): boolean {
  return a.status === "pending" && now >= a.expiresAt;
}
