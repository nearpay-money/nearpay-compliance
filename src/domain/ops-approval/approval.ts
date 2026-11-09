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
 * An approval therefore involves two distinct operators — while the platform has two or more operators who
 * can approve (`ops_admin`) — and never happens after expiry.
 *
 * **Adaptive rule (single-operator platforms, LLD §5.1).** The request records the number of active
 * `ops_admin` operators identity signed into the token (`requestedAdmins`; unknown = two-person). When it
 * was at most one, and still is at completion, the requester may approve their own request — only after
 * the wait (`NP_OPS_SINGLE_OPERATOR_DELAY_S`), with a user verification performed after it (`authAt`) and
 * a written reason. Revoking the other operator mid-action does not help (the request keeps its count);
 * adding a second one re-enables the rule (the count at completion).
 */

export type OpsRole = "ops" | "ops_admin";
export type SuspensionAction = "suspend" | "reinstate";
export type ApprovalAction = "account.suspend" | "account.reinstate";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Operator {
  readonly sub: string;
  readonly role: OpsRole;
  /** Active `ops_admin` operators when identity minted the token (claim `ops_admins`); absent = unknown. */
  readonly activeAdmins?: number;
  /** Unix seconds of the operator's last user verification (claim `ops_auth_at`); absent = unknown. */
  readonly authAt?: number;
}

export interface Approval {
  readonly action: ApprovalAction;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly expiresAt: number;
  /** When the request was made (ms). */
  readonly requestedAt?: number;
  /** Active approvers when it was made; null/absent = unknown (two-person). */
  readonly requestedAdmins?: number | null;
}

/** Minimum length of the written reason of a single-operator completion (trimmed). */
export const SINGLE_OPERATOR_REASON_MIN = 20;
export const DEFAULT_SINGLE_OPERATOR_DELAY_SECONDS = 300;

const single = (n: number | null | undefined): boolean => n !== null && n !== undefined && n <= 1;

/** The request was made on a single-operator platform. */
export function madeBySingleOperator(a: Approval): boolean {
  return single(a.requestedAdmins) && a.requestedAt !== undefined;
}

/** When the requester may complete it alone (ms), or null when two persons are needed. */
export function singleOperatorAvailableAt(a: Approval, delaySeconds: number): number | null {
  return madeBySingleOperator(a) ? (a.requestedAt as number) + delaySeconds * 1000 : null;
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
  | { readonly kind: "approved" | "rejected"; readonly singleOperator?: boolean }
  | { readonly kind: "refuse"; readonly error: "step_up_required" | "reason_required"; readonly reason: string }
  | { readonly kind: "expire"; readonly reason: "expired" | "state_changed" }
  | { readonly kind: "refuse"; readonly error: "approver_conflict"; readonly reason: string }
  | { readonly kind: "refuse"; readonly error: "state_conflict"; readonly reason: string };

export function approve(
  a: Approval,
  approver: Operator,
  o: { suspended: boolean; now: number; delaySeconds?: number; note?: string | undefined },
): DecideStep {
  if (a.status !== "pending") return { kind: "refuse", error: "state_conflict", reason: `the request is ${a.status}` };
  if (approver.role !== "ops_admin")
    return { kind: "refuse", error: "approver_conflict", reason: "the approver must hold ops_admin." };
  const self = approver.sub === a.requestedBy;
  if (self && !(madeBySingleOperator(a) && single(approver.activeAdmins)))
    return { kind: "refuse", error: "approver_conflict", reason: "the requester cannot approve their own request." };
  if (o.now >= a.expiresAt) return { kind: "expire", reason: "expired" };
  if (!actionApplies(a.action, o.suspended)) return { kind: "expire", reason: "state_changed" };
  if (!self) return { kind: "approved" };
  // single-operator platform: the requester completes it alone under the guards
  const availableAt = singleOperatorAvailableAt(a, o.delaySeconds ?? DEFAULT_SINGLE_OPERATOR_DELAY_SECONDS) as number;
  if (o.now < availableAt)
    return {
      kind: "refuse",
      error: "approver_conflict",
      reason: `you are the only operator, so you can complete your own request from ${new Date(availableAt).toISOString()}.`,
    };
  if (approver.authAt === undefined || approver.authAt * 1000 < availableAt)
    return {
      kind: "refuse",
      error: "step_up_required",
      reason: "completing your own request needs a new confirmation after the wait.",
    };
  if ((o.note ?? "").trim().length < SINGLE_OPERATOR_REASON_MIN)
    return {
      kind: "refuse",
      error: "reason_required",
      reason: `completing your own request needs a written reason (at least ${SINGLE_OPERATOR_REASON_MIN} characters).`,
    };
  return { kind: "approved", singleOperator: true };
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
