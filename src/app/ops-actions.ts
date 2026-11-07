/**
 * Operator actions (compliance LLD §5.1 "Unified console audit trail", INV-9, T-12). Every console write
 * calls `recordOpsAction` inside its own transaction: an append-only `ops_actions` row (with the
 * encrypted note, if any) and `evt.compliance.ops_action.recorded` in the outbox. The event carries ids
 * only — no notes, emails or addresses; identity copies it into `audit_events`.
 */
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import type { Operator } from "../domain/ops-approval/approval.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";

export interface OpsActionInput {
  /** `<object>.<verb>`, e.g. `case.closed`, `blocklist_entry.added`. */
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly accountUuid: string | null;
  readonly approvalUuid?: string | null;
  /** Internal note kept (encrypted) in `ops_actions` only; never published. */
  readonly note?: string;
}

/** Actor string stored on Stage 1 tables (`decided_by`, `case_events.actor`, …) for an operator. */
export const operatorActor = (op: Operator): string => `ops:${op.sub}`;

export async function recordOpsAction(c: Compliance, tx: Tx, op: Operator, a: OpsActionInput): Promise<string> {
  const id = uuidv7();
  const now = await dbNow(tx);
  await tx
    .insertInto("ops_actions")
    .values({
      id,
      actor_sub: toUuid(op.sub, "usr"),
      actor_role: op.role,
      action: a.action,
      target_type: a.target.type,
      target_id: a.target.id,
      account_id: a.accountUuid,
      approval_id: a.approvalUuid ?? null,
      note_enc: a.note ? c.cipher.encrypt(a.note, `ops_action:${id}`) : null,
      created_at: now,
    })
    .execute();
  await emitEvent(tx, {
    subject: "evt.compliance.ops_action.recorded",
    // The outbox keys aggregates by prefixed id and `ops_action` has no prefix of its own: the action uuid goes
    // out as `aud_…` (the audit event identity records; sentinel and rails do the same). `object.id` is the uuid.
    aggregate: { type: "ops_action", id: fromUuid("aud", id), version: 1 },
    accountUuid: a.accountUuid,
    livemode: null,
    object: {
      id,
      actor: { sub: op.sub, ops_role: op.role },
      action: a.action,
      target: a.target,
      account_id: a.accountUuid ? fromUuid("acct", a.accountUuid) : null,
      approval: a.approvalUuid ? fromUuid("opa", a.approvalUuid) : null,
      occurred_at: now.toISOString(),
    },
  });
  c.log.info({ action: a.action, target: a.target, operator: op.sub, role: op.role }, "operator action");
  return id;
}
