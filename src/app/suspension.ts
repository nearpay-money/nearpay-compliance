/**
 * Merchant suspension with the two-person rule (compliance LLD §5.1, spec `OpsApproval`, T-12).
 *
 * A request changes nothing. The approval of a second operator — an `ops_admin` with a different
 * operator id, checked on the verified principal — executes it in the transaction that records the
 * approval: `ops_approvals` row approved, `account_flags`, `evt.compliance.account.suspended|reinstated`
 * and the operator action. The rules are in `domain/ops-approval/approval.ts`; the database repeats the
 * different-approver rule (check constraint) and allows one pending request per account (unique index).
 */
import { type Selectable, withTx } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import {
  type Approval,
  approve,
  type DecideStep,
  type Operator,
  reject,
  requestAction,
  SINGLE_OPERATOR_REASON_MIN,
  type SuspensionAction,
  singleOperatorAvailableAt,
  sweep,
} from "../domain/ops-approval/approval.js";
import type { OpsApprovalsTable } from "../infra/db/schema.js";
import { applySuspension } from "./admin.js";
import { apiActor } from "./cases.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";
import { recordOpsAction } from "./ops-actions.js";

type ApprovalRow = Selectable<OpsApprovalsTable>;

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function accountUuidOf(accountId: string): string {
  if (!isId("acct", accountId)) throw ApiError.invalid(`${accountId} is not an account id`, "id");
  return toUuid(accountId, "acct");
}

/**
 * `OpsApproval` view. Extension (an open object; not yet in the spec): `single_operator` is present only for
 * requests made on a single-operator platform — when the requester may complete it alone, or that they did.
 */
export function renderApproval(r: ApprovalRow, delaySeconds?: number) {
  const at = singleOperatorAvailableAt(domainApproval(r), delaySeconds ?? 0);
  return {
    ...(at !== null || r.single_operator
      ? {
          single_operator: {
            used: r.single_operator,
            available_at: at !== null && r.status === "pending" ? Math.ceil(at / 1000) : null,
            reason_min_length: SINGLE_OPERATOR_REASON_MIN,
          },
        }
      : {}),
    id: fromUuid("opa", r.id),
    object: "ops_approval" as const,
    action: r.action,
    target: { type: "account" as const, id: fromUuid("acct", r.account_id) },
    reason: r.reason,
    status: r.status,
    requested_by: { id: fromUuid("usr", r.requested_by), role: r.requested_role },
    requested_at: unix(r.requested_at),
    decided_by: r.decided_by && r.decided_role ? { id: fromUuid("usr", r.decided_by), role: r.decided_role } : null,
    decided_at: r.decided_at ? unix(r.decided_at) : null,
    decision_note: r.decision_note,
    expires_at: unix(r.expires_at),
  };
}

function domainApproval(r: ApprovalRow): Approval {
  return {
    action: r.action,
    status: r.status,
    requestedBy: fromUuid("usr", r.requested_by),
    expiresAt: r.expires_at.getTime(),
    requestedAt: r.requested_at.getTime(),
    requestedAdmins: r.requested_admins,
  };
}

async function isSuspended(db: Compliance["db"] | Tx, accountUuid: string, lock = false): Promise<boolean> {
  let q = db.selectFrom("account_flags").select("suspended").where("account_id", "=", accountUuid);
  if (lock) q = q.forUpdate();
  return (await q.executeTakeFirst())?.suspended ?? false;
}

/** Marks pending requests past their expiry `expired` (in `tx`); returns how many. */
async function expireDue(tx: Tx, now: Date, accountUuid?: string): Promise<number> {
  let q = tx
    .updateTable("ops_approvals")
    .set({ status: "expired" })
    .where("status", "=", "pending")
    .where("expires_at", "<=", now);
  if (accountUuid) q = q.where("account_id", "=", accountUuid);
  const r = await q.executeTakeFirst();
  return Number(r.numUpdatedRows);
}

async function suspensionView(c: Compliance, db: Compliance["db"] | Tx, accountUuid: string) {
  const now = await dbNow(db);
  const flags = await db
    .selectFrom("account_flags")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .executeTakeFirst();
  const pending = (await db
    .selectFrom("ops_approvals")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .executeTakeFirst()) as ApprovalRow | undefined;
  return {
    object: "merchant_suspension" as const,
    account_id: fromUuid("acct", accountUuid),
    suspended: flags?.suspended ?? false,
    reason: flags?.reason ?? null,
    actor: flags ? flags.actor.split("+").map(apiActor).join("+") : null,
    updated_at: flags ? unix(flags.updated_at) : null,
    pending_request: pending ? renderApproval(pending, c.singleOperatorDelaySeconds) : null,
  };
}

/** `getOpsMerchantSuspension`. */
export async function getMerchantSuspension(c: Compliance, accountId: string) {
  return suspensionView(c, c.db, accountUuidOf(accountId));
}

/** `createOpsSuspensionRequest` (step-up): a pending request that expires after the configured TTL. */
export async function createSuspensionRequest(
  c: Compliance,
  op: Operator,
  accountId: string,
  action: SuspensionAction,
  reason: string,
) {
  const accountUuid = accountUuidOf(accountId);
  return withTx(c.db, async (tx) => {
    const now = await dbNow(tx);
    const suspended = await isSuspended(tx, accountUuid, true);
    await expireDue(tx, now, accountUuid);
    const pending = await tx
      .selectFrom("ops_approvals")
      .select("id")
      .where("account_id", "=", accountUuid)
      .where("status", "=", "pending")
      .executeTakeFirst();
    const step = requestAction(action, {
      suspended,
      pendingExists: pending !== undefined,
      now: now.getTime(),
      ttlSeconds: c.opsApprovalTtlSeconds,
    });
    if (!step.ok)
      throw new ApiError("state_conflict", {
        params: {
          object: "account",
          state: step.reason === "pending_exists" ? "awaiting a second operator" : suspended ? "suspended" : "active",
        },
      });
    const id = uuidv7();
    const row = (await tx
      .insertInto("ops_approvals")
      .values({
        id,
        action: step.action,
        account_id: accountUuid,
        reason,
        status: "pending",
        requested_by: toUuid(op.sub, "usr"),
        requested_role: op.role,
        requested_at: now,
        expires_at: new Date(step.expiresAt),
        requested_admins: op.activeAdmins ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as ApprovalRow;
    const view = renderApproval(row, c.singleOperatorDelaySeconds);
    await emitEvent(tx, {
      subject: "evt.compliance.account.action_requested",
      aggregate: { type: "ops_approval", id: view.id, version: 1 },
      accountUuid,
      livemode: null,
      object: view,
    });
    await recordOpsAction(c, tx, op, {
      action: "ops_approval.requested",
      target: { type: "ops_approval", id: view.id },
      accountUuid,
      approvalUuid: id,
      note: reason,
    });
    c.log.warn({ acct: accountId, action: step.action, operator: op.sub }, "suspension requested");
    return view;
  });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/**
 * Locks the request (path account and request must match) and applies a decision. An expiry is
 * committed before the `409` is raised, so a stale request does not stay `pending`.
 */
async function decide<T>(
  c: Compliance,
  _op: Operator,
  accountId: string,
  requestId: string,
  rule: (a: Approval, suspended: boolean, now: number) => DecideStep,
  execute: (tx: Tx, row: ApprovalRow, now: Date, step: DecideStep) => Promise<T>,
): Promise<T> {
  const accountUuid = accountUuidOf(accountId);
  if (!isId("opa", requestId)) throw ApiError.invalid(`${requestId} is not an ops approval id`, "request");
  const outcome: Outcome<T> = await withTx(c.db, async (tx): Promise<Outcome<T>> => {
    const suspended = await isSuspended(tx, accountUuid, true);
    const row = (await tx
      .selectFrom("ops_approvals")
      .selectAll()
      .where("id", "=", toUuid(requestId, "opa"))
      .where("account_id", "=", accountUuid)
      .forUpdate()
      .executeTakeFirst()) as ApprovalRow | undefined;
    if (!row) throw ApiError.missing("ops_approval", requestId, "request");
    const now = await dbNow(tx);
    const step = rule(domainApproval(row), suspended, now.getTime());
    switch (step.kind) {
      case "refuse":
        return {
          ok: false,
          error:
            step.error === "approver_conflict"
              ? new ApiError("approver_conflict", { params: { reason: step.reason } })
              : step.error === "step_up_required"
                ? new ApiError("step_up_required")
                : step.error === "reason_required"
                  ? ApiError.invalid(step.reason, "note")
                  : new ApiError("state_conflict", { params: { object: "ops_approval", state: row.status } }),
        };
      case "expire":
        await tx.updateTable("ops_approvals").set({ status: "expired" }).where("id", "=", row.id).execute();
        c.log.warn({ request: requestId, reason: step.reason }, "suspension request expired");
        return {
          ok: false,
          error: new ApiError("state_conflict", {
            params: {
              object: "ops_approval",
              state: step.reason === "expired" ? "expired" : "expired (the account state changed)",
            },
          }),
        };
      default:
        return { ok: true, value: await execute(tx, row, now, step) };
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * `approveOpsSuspensionRequest` (ops_admin ≠ requester, step-up): approves and executes in one transaction.
 * On a single-operator platform the requester may approve under the domain guards: the row is marked
 * `single_operator`, the operator action is `ops_approval.approved_single_operator` and
 * `nearpay_ops_single_operator_actions_total{action}` counts it.
 */
export async function approveSuspensionRequest(
  c: Compliance,
  op: Operator,
  accountId: string,
  requestId: string,
  note: string | undefined,
) {
  let single: { action: string } | null = null;
  const view = await decide(
    c,
    op,
    accountId,
    requestId,
    (a, suspended, now) =>
      approve(a, op, { suspended, now, delaySeconds: c.singleOperatorDelaySeconds, note: note ?? undefined }),
    async (tx, row, now, step) => {
      const solo = step.kind === "approved" && step.singleOperator === true;
      if (solo) single = { action: row.action };
      await tx
        .updateTable("ops_approvals")
        .set({
          status: "approved",
          decided_by: toUuid(op.sub, "usr"),
          decided_role: op.role,
          decided_at: now,
          decision_note: note ?? null,
          single_operator: solo,
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();
      const requester = fromUuid("usr", row.requested_by);
      await applySuspension(
        c,
        tx,
        row.account_id,
        row.action === "account.suspend",
        row.reason,
        `ops:${requester}+ops:${op.sub}`,
      );
      await recordOpsAction(c, tx, op, {
        action: solo ? "ops_approval.approved_single_operator" : "ops_approval.approved",
        target: { type: "ops_approval", id: fromUuid("opa", row.id) },
        accountUuid: row.account_id,
        approvalUuid: row.id,
        ...(note ? { note } : {}),
        ...(solo ? { singleOperator: true, details: { single_operator: true, approval_action: row.action } } : {}),
      });
      return suspensionView(c, tx, row.account_id);
    },
  );
  const done = single as { action: string } | null;
  if (done) {
    c.metrics.singleOperatorAction(done.action);
    c.log.warn(
      { acct: accountId, request: requestId, operator: op.sub, action: done.action, single_operator: true },
      "ALERT two-person action completed by a single operator (one active ops_admin)",
    );
  }
  return view;
}

/** `rejectOpsSuspensionRequest` (ops_admin; the requester may withdraw): executes nothing. */
export async function rejectSuspensionRequest(
  c: Compliance,
  op: Operator,
  accountId: string,
  requestId: string,
  note: string,
) {
  return decide(
    c,
    op,
    accountId,
    requestId,
    (a, _suspended, now) => reject(a, op, { now }),
    async (tx, row, now) => {
      const updated = (await tx
        .updateTable("ops_approvals")
        .set({
          status: "rejected",
          decided_by: toUuid(op.sub, "usr"),
          decided_role: op.role,
          decided_at: now,
          decision_note: note,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow()) as ApprovalRow;
      await recordOpsAction(c, tx, op, {
        action: "ops_approval.rejected",
        target: { type: "ops_approval", id: fromUuid("opa", row.id) },
        accountUuid: row.account_id,
        approvalUuid: row.id,
        note,
      });
      return renderApproval(updated, c.singleOperatorDelaySeconds);
    },
  );
}

/** Job `ops_approvals.expire`: pending requests past their expiry become `expired`. */
export async function expireApprovals(c: Compliance): Promise<number> {
  return withTx(c.db, async (tx) => {
    const now = await dbNow(tx);
    // the pure rule decides; the update is the same predicate in SQL
    const due = (await tx
      .selectFrom("ops_approvals")
      .selectAll()
      .where("status", "=", "pending")
      .where("expires_at", "<=", now)
      .forUpdate()
      .execute()) as ApprovalRow[];
    const ids = due.filter((r) => sweep(domainApproval(r), now.getTime())).map((r) => r.id);
    if (ids.length === 0) return 0;
    await tx.updateTable("ops_approvals").set({ status: "expired" }).where("id", "in", ids).execute();
    c.log.info({ expired: ids.length }, "suspension requests expired");
    return ids.length;
  });
}
