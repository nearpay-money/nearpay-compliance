/**
 * KYB cases (compliance LLD §5–§6): created when identity creates an account, started by the owner
 * from the dashboard, decided by ops (Stage 1 manual path: ops CLI or the ops route). A decision
 * writes the case, a transition and the `evt.compliance.kyb.<decision>` outbox row in one transaction.
 */
import { withTx } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import {
  decideKyb as decideStep,
  type KybDecision,
  type KybStatus,
  kybSubject,
  startKyb as startStep,
} from "../domain/kyb-case/kyb.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";

/** Locks the account's case, creating it (`not_started`) when the account event has not arrived yet. */
async function lockCase(tx: Tx, accountUuid: string) {
  await tx
    .insertInto("kyb_cases")
    .values({ id: uuidv7(), account_id: accountUuid, status: "not_started" })
    .onConflict((oc) => oc.column("account_id").doNothing())
    .execute();
  return tx
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

async function transition(
  tx: Tx,
  row: { id: string; status: string; version: number },
  to: KybStatus,
  cause: string,
  actor: string,
  extra: { decision_reason?: string; decided_by?: string; decided_at?: Date } = {},
) {
  const now = await dbNow(tx);
  const updated = await tx
    .updateTable("kyb_cases")
    .set({ status: to, version: row.version + 1, updated_at: now, ...extra })
    .where("id", "=", row.id)
    .where("version", "=", row.version)
    .returningAll()
    .executeTakeFirstOrThrow();
  await tx
    .insertInto("kyb_case_transitions")
    .values({ id: uuidv7(), kyb_case_id: row.id, from_state: row.status, to_state: to, cause, actor })
    .execute();
  return updated;
}

/** `evt.identity.account.created`: open the KYB placeholder. */
export async function createKybCase(tx: Tx, accountId: string): Promise<void> {
  await tx
    .insertInto("kyb_cases")
    .values({ id: uuidv7(), account_id: toUuid(accountId, "acct"), status: "not_started" })
    .onConflict((oc) => oc.column("account_id").doNothing())
    .execute();
}

/** `POST /v1/account/kyb`: start (or return) the account's case. Stage 1 has no vendor flow. */
export async function startKyb(c: Compliance, accountId: string, actor: string) {
  return withTx(c.db, async (tx) => {
    const row = await lockCase(tx, toUuid(accountId, "acct"));
    const step = startStep(row.status as KybStatus);
    const current = step.changed ? await transition(tx, row, step.to, "owner_started", actor) : row;
    return { object: "kyb_case" as const, status: current.status as KybStatus, vendor_flow_url: null };
  });
}

/** Ops decision (`POST /internal/kyb_cases/{id}/decision`, ops CLI `kyb-decide`). */
export async function decideKyb(
  c: Compliance,
  accountId: string,
  decision: KybDecision,
  reason: string,
  actor: string,
): Promise<{ account_id: `acct_${string}`; status: KybStatus; decided_at: string }> {
  return withTx(c.db, async (tx) => {
    const accountUuid = toUuid(accountId, "acct");
    // A decision needs the case (created by account.created or the owner's start): a mistyped
    // account id must not mint a decision for an account that does not exist.
    const row = await tx
      .selectFrom("kyb_cases")
      .selectAll()
      .where("account_id", "=", accountUuid)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw ApiError.missing("kyb_case", accountId, "id");
    const step = decideStep(row.status as KybStatus, decision);
    if (!step.changed) {
      return {
        account_id: fromUuid("acct", accountUuid),
        status: row.status as KybStatus,
        decided_at: (row.decided_at ?? row.updated_at).toISOString(),
      };
    }
    const now = await dbNow(tx);
    const updated = await transition(tx, row, step.to, "ops_decision", actor, {
      decision_reason: reason,
      decided_by: actor,
      decided_at: now,
    });
    await emitEvent(tx, {
      subject: kybSubject(decision),
      aggregate: { type: "kyb_case", id: fromUuid("acct", accountUuid), version: updated.version },
      accountUuid,
      livemode: null,
      object: { account_id: fromUuid("acct", accountUuid), status: updated.status, reason },
      previous: { status: row.status },
    });
    c.log.info({ acct: fromUuid("acct", accountUuid), decision, actor }, "kyb decided");
    return {
      account_id: fromUuid("acct", accountUuid),
      status: updated.status as KybStatus,
      decided_at: now.toISOString(),
    };
  });
}

export async function getKybCase(c: Compliance, accountId: string) {
  return c.db
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", toUuid(accountId, "acct"))
    .executeTakeFirst();
}
