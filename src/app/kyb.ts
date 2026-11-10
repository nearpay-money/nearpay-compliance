/**
 * KYB cases (compliance LLD §5, ADR-0020 decision 3, ADR-0024): self-declared minimum business details.
 * Created when identity creates an account (or on the owner's first visit), edited and submitted by the
 * owner from the dashboard. `NP_KYB_MODE=auto` (default, open onboarding): the system decides the
 * submission in the same transaction (approved; rejected on a geo-policy hit) — no NearPay approval step;
 * the `kyb.auto_decide` job sweeps any case left `pending` (e.g. submitted while the mode was `manual`).
 * `manual`: ops decide in the console (`decideOpsKybCase`) or with the Stage 1 manual path (ops CLI,
 * `POST /internal/kyb_cases/{id}/decision`). Both paths stay available in auto mode for abuse (reject).
 *
 * Every state change writes the case, a transition and its outbox row in one transaction. The profile
 * is personal data (a sole proprietor's legal name, the representative): envelope-encrypted at rest,
 * never on the bus; identity reads the approved details through `getInternalKybCase`.
 */
import { type Selectable, sql, withTx } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { autoDecide, type KybMode, SYSTEM_ACTOR } from "../domain/kyb-case/auto.js";
import {
  decideConsole,
  decideKyb as decideStep,
  isEditable,
  type KybDecision,
  type KybStatus,
  kybSubject,
  submitKyb as submitStep,
} from "../domain/kyb-case/kyb.js";
import {
  emptyProfile,
  type KybProfile,
  type KybProfileUpdate,
  mergeProfile,
  missingFields,
  profileFromJson,
} from "../domain/kyb-case/profile.js";
import type { Operator } from "../domain/ops-approval/approval.js";
import type { KybCasesTable } from "../infra/db/schema.js";
import { apiActor } from "./cases.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";
import { operatorActor, recordOpsAction } from "./ops-actions.js";
import { type Page, pageOf } from "./paging.js";
import { currentPolicy } from "./screening.js";

/** `NP_KYB_MODE` (absent → `auto`, open onboarding). */
export const kybModeOf = (c: Pick<Compliance, "kybMode">): KybMode => c.kybMode ?? "auto";

type KybRow = Selectable<KybCasesTable>;

const unix = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);

function accountUuidOf(accountId: string, param = "id"): string {
  if (!isId("acct", accountId)) throw ApiError.invalid(`${accountId} is not an account id`, param);
  return toUuid(accountId, "acct");
}

function readProfile(c: Compliance, row: Pick<KybRow, "id" | "profile_enc">): KybProfile {
  if (!row.profile_enc) return emptyProfile();
  return profileFromJson(JSON.parse(c.cipher.decrypt(row.profile_enc, `kyb:${row.id}`).toString("utf8")));
}

function writeProfile(c: Compliance, caseUuid: string, p: KybProfile): Buffer {
  return c.cipher.encrypt(JSON.stringify(p), `kyb:${caseUuid}`);
}

/** Locks the account's case, creating it (`not_started`) when the account event has not arrived yet. */
async function lockCase(tx: Tx, accountUuid: string): Promise<KybRow> {
  await tx
    .insertInto("kyb_cases")
    .values({ id: uuidv7(), account_id: accountUuid, status: "not_started" })
    .onConflict((oc) => oc.column("account_id").doNothing())
    .execute();
  return (await tx
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .forUpdate()
    .executeTakeFirstOrThrow()) as KybRow;
}

async function transition(
  tx: Tx,
  row: KybRow,
  to: KybStatus,
  cause: string,
  actor: string,
  set: Partial<{
    decision_reason: string;
    decided_by: string;
    decided_at: Date;
    profile_enc: Buffer;
    declared_by: string;
    submitted_at: Date;
    requested_info: string | null;
  }> = {},
  evidence: Record<string, unknown> | null = null,
): Promise<KybRow> {
  const now = await dbNow(tx);
  const updated = (await tx
    .updateTable("kyb_cases")
    .set({ status: to, version: row.version + 1, updated_at: now, ...set })
    .where("id", "=", row.id)
    .where("version", "=", row.version)
    .returningAll()
    .executeTakeFirstOrThrow()) as KybRow;
  await tx
    .insertInto("kyb_case_transitions")
    .values({
      id: uuidv7(),
      kyb_case_id: row.id,
      from_state: row.status,
      to_state: to,
      cause,
      actor,
      evidence: evidence ? JSON.stringify(evidence) : null,
    })
    .execute();
  return updated;
}

/** `evt.identity.account.created`: open the KYB placeholder and remember the display name for the queue. */
export async function createKybCase(tx: Tx, accountId: string, displayName?: string): Promise<void> {
  await tx
    .insertInto("kyb_cases")
    .values({
      id: uuidv7(),
      account_id: toUuid(accountId, "acct"),
      status: "not_started",
      account_display_name: displayName ?? null,
    })
    .onConflict((oc) =>
      oc.column("account_id").doUpdateSet((eb) => ({
        account_display_name: eb.fn.coalesce("kyb_cases.account_display_name", eb.ref("excluded.account_display_name")),
      })),
    )
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Owner (dashboard)
// ---------------------------------------------------------------------------------------------

/** The owner's view (`KybCase`); internal decision reasons are never part of it. */
function ownerView(c: Compliance, row: KybRow | null) {
  const status = (row?.status ?? "not_started") as KybStatus;
  return {
    object: "kyb_case" as const,
    status,
    vendor_flow_url: null,
    profile: row ? readProfile(c, row) : emptyProfile(),
    editable: isEditable(status),
    requested_info: status === "needs_info" ? (row?.requested_info ?? null) : null,
    submitted_at: unix(row?.submitted_at ?? null),
    decided_at: unix(row?.decided_at ?? null),
  };
}

export type OwnerKybCase = ReturnType<typeof ownerView>;

/** `POST /v1/account/kyb`: create (or return) the account's case. There is no vendor flow (ADR-0020). */
export async function startKyb(c: Compliance, accountId: string, _actor: string): Promise<OwnerKybCase> {
  return withTx(c.db, async (tx) => ownerView(c, await lockCase(tx, toUuid(accountId, "acct"))));
}

/** `GET /v1/account/kyb`: the case with the declared details (a case not created yet reads as `not_started`). */
export async function getKyb(c: Compliance, accountId: string): Promise<OwnerKybCase> {
  const row = await c.db
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", toUuid(accountId, "acct"))
    .executeTakeFirst();
  return ownerView(c, (row as KybRow | undefined) ?? null);
}

/** `PATCH /v1/account/kyb`: partial update of the draft (only `not_started` / `needs_info`). */
export async function updateKybProfile(
  c: Compliance,
  accountId: string,
  update: KybProfileUpdate,
  actor: string,
): Promise<OwnerKybCase> {
  return withTx(c.db, async (tx) => {
    const row = await lockCase(tx, toUuid(accountId, "acct"));
    const status = row.status as KybStatus;
    if (!isEditable(status)) throw new ApiError("state_conflict", { params: { object: "kyb_case", state: status } });
    const { profile, changed } = mergeProfile(readProfile(c, row), update);
    if (changed.length === 0) return ownerView(c, row);
    // the transition log is the audit trail: field names only, never values (personal data)
    const updated = await transition(
      tx,
      row,
      status,
      "profile_updated",
      actor,
      { profile_enc: writeProfile(c, row.id, profile) },
      { fields: changed },
    );
    return ownerView(c, updated);
  });
}

/** `POST /v1/account/kyb/submit`: the owner declares the details true → `pending`; emits `kyb.submitted`. */
export async function submitKyb(c: Compliance, accountId: string, userId: string): Promise<OwnerKybCase> {
  if (!isId("usr", userId)) throw new ApiError("permission_denied", { params: { action: "submit KYB" } });
  return withTx(c.db, async (tx) => {
    const accountUuid = toUuid(accountId, "acct");
    const row = await lockCase(tx, accountUuid);
    const profile = readProfile(c, row);
    const step = submitStep(row.status as KybStatus, missingFields(profile));
    if (!step.ok && step.reason === "state")
      throw new ApiError("state_conflict", { params: { object: "kyb_case", state: row.status } });
    if (!step.ok)
      throw new ApiError("kyb_profile_incomplete", {
        params: { fields: step.reason === "incomplete" ? step.missing.join(", ") : "" },
      });
    const now = await dbNow(tx);
    const updated = await transition(
      tx,
      row,
      step.to,
      "owner_submitted",
      `user:${userId}`,
      { declared_by: toUuid(userId, "usr"), submitted_at: now, requested_info: null },
      { declaration: true },
    );
    await emitEvent(tx, {
      subject: "evt.compliance.kyb.submitted",
      aggregate: { type: "kyb_case", id: fromUuid("acct", accountUuid), version: updated.version },
      accountUuid,
      livemode: null,
      object: { account_id: fromUuid("acct", accountUuid), status: "pending", submitted_at: now.toISOString() },
      previous: { status: row.status },
    });
    c.log.info({ acct: fromUuid("acct", accountUuid) }, "kyb submitted");
    if (kybModeOf(c) === "manual") return ownerView(c, updated);
    return ownerView(c, await applyAutoDecision(c, tx, updated, profile));
  });
}

/**
 * Open onboarding (ADR-0024): the system's decision on a submitted, complete profile, in the caller's
 * transaction — `approved` (identity turns live mode on from `kyb.approved`) or `rejected` with the
 * `geo_blocked` reason code. Recorded like any decision: actor `system`, reason, transition, event.
 */
async function applyAutoDecision(c: Compliance, tx: Tx, row: KybRow, profile: KybProfile): Promise<KybRow> {
  const policy = await currentPolicy(c);
  const auto = autoDecide(profile, policy);
  const updated = await applyDecision(c, tx, row, auto.decision, auto.reason, SYSTEM_ACTOR, null, "auto_decision");
  if (auto.decision === "rejected")
    c.log.warn({ acct: fromUuid("acct", row.account_id), code: auto.code }, "kyb auto-rejected by the geo policy");
  return updated;
}

/**
 * `kyb.auto_decide` job (auto mode only): decides cases still `pending` with a complete profile — cases
 * submitted while the mode was `manual`, or before this release. Each case in its own transaction.
 */
export async function autoDecidePending(c: Compliance, limit = 200): Promise<{ decided: number }> {
  if (kybModeOf(c) === "manual") return { decided: 0 };
  const ids = await c.db
    .selectFrom("kyb_cases")
    .select("account_id")
    .where("status", "=", "pending")
    .orderBy("updated_at")
    .limit(limit)
    .execute();
  let decided = 0;
  for (const { account_id } of ids) {
    const done = await withTx(c.db, async (tx) => {
      const row = (await tx
        .selectFrom("kyb_cases")
        .selectAll()
        .where("account_id", "=", account_id)
        .forUpdate()
        .executeTakeFirstOrThrow()) as KybRow;
      if (row.status !== "pending") return false;
      const profile = readProfile(c, row);
      // a Stage 1 case started without details stays pending until the owner submits a complete profile
      if (missingFields(profile).length > 0) return false;
      await applyAutoDecision(c, tx, row, profile);
      return true;
    });
    if (done) decided++;
  }
  return { decided };
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

async function lockExisting(tx: Tx, accountUuid: string, accountId: string): Promise<KybRow> {
  // A decision needs the case (created by account.created or the owner): a mistyped account id must
  // not mint a decision for an account that does not exist.
  const row = await tx
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw ApiError.missing("kyb_case", accountId, "id");
  return row as KybRow;
}

async function applyDecision(
  c: Compliance,
  tx: Tx,
  row: KybRow,
  decision: KybDecision,
  reason: string,
  actor: string,
  requestedInfo: string | null,
  cause: "ops_decision" | "auto_decision" = "ops_decision",
): Promise<KybRow> {
  const now = await dbNow(tx);
  const updated = await transition(
    tx,
    row,
    decision,
    cause,
    actor,
    { decision_reason: reason, decided_by: actor, decided_at: now, requested_info: requestedInfo },
    { reason },
  );
  const acct = fromUuid("acct", row.account_id);
  await emitEvent(tx, {
    subject: kybSubject(decision),
    aggregate: { type: "kyb_case", id: acct, version: updated.version },
    accountUuid: row.account_id,
    livemode: null,
    object: {
      account_id: acct,
      status: updated.status,
      reason,
      ...(decision === "needs_info" ? { requested_info: requestedInfo } : {}),
    },
    previous: { status: row.status },
  });
  c.log.info({ acct, decision, actor }, "kyb decided");
  return updated;
}

/** Stage 1 manual decision (`POST /internal/kyb_cases/{id}/decision`, ops CLI `kyb-decide`). */
export async function decideKyb(
  c: Compliance,
  accountId: string,
  decision: KybDecision,
  reason: string,
  actor: string,
): Promise<{ account_id: `acct_${string}`; status: KybStatus; decided_at: string }> {
  return withTx(c.db, async (tx) => {
    const accountUuid = toUuid(accountId, "acct");
    const row = await lockExisting(tx, accountUuid, accountId);
    const step = decideStep(row.status as KybStatus, decision);
    const current = step.changed ? await applyDecision(c, tx, row, decision, reason, actor, null) : row;
    return {
      account_id: fromUuid("acct", accountUuid),
      status: current.status as KybStatus,
      decided_at: (current.decided_at ?? current.updated_at).toISOString(),
    };
  });
}

/** `decideOpsKybCase`: the console decision (state table in `domain/kyb-case/kyb.ts`), audited as an operator action. */
export async function decideOpsKybCase(
  c: Compliance,
  op: Operator,
  accountId: string,
  body: { decision: KybDecision; reason: string; requested_info?: string | undefined },
) {
  return withTx(c.db, async (tx) => {
    const accountUuid = accountUuidOf(accountId);
    const row = await lockExisting(tx, accountUuid, accountId);
    const step = decideConsole(row.status as KybStatus, body.decision, {
      requestedInfo: body.requested_info,
      profileComplete: missingFields(readProfile(c, row)).length === 0,
    });
    if ("error" in step) {
      if (step.error === "requested_info_required")
        throw ApiError.invalid("requested_info is required to ask for more information", "requested_info");
      throw new ApiError("state_conflict", {
        params: {
          object: "kyb_case",
          state: step.error === "profile_incomplete" ? `${row.status} without complete business details` : row.status,
        },
      });
    }
    let current = row;
    if (step.changed) {
      current = await applyDecision(
        c,
        tx,
        row,
        body.decision,
        body.reason,
        operatorActor(op),
        body.decision === "needs_info" ? (body.requested_info?.trim() ?? null) : null,
      );
      await recordOpsAction(c, tx, op, {
        action: `kyb_case.${body.decision}`,
        target: { type: "kyb_case", id: fromUuid("acct", accountUuid) },
        accountUuid,
        note: body.reason,
      });
    }
    return opsView(c, tx, current);
  });
}

// ---------------------------------------------------------------------------------------------
// Console and service reads
// ---------------------------------------------------------------------------------------------

function historyReason(t: { cause: string; evidence: unknown }): string | null {
  const ev = (t.evidence ?? {}) as { reason?: unknown; fields?: unknown };
  if (typeof ev.reason === "string") return ev.reason;
  if (t.cause === "profile_updated" && Array.isArray(ev.fields)) return `details updated: ${ev.fields.join(", ")}`;
  if (t.cause === "owner_submitted") return "details declared and submitted";
  return null;
}

async function opsView(c: Compliance, db: Compliance["db"] | Tx, row: KybRow) {
  const transitions = await db
    .selectFrom("kyb_case_transitions")
    .selectAll()
    .where("kyb_case_id", "=", row.id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return {
    object: "ops_kyb_case" as const,
    account_id: fromUuid("acct", row.account_id),
    account_display_name: row.account_display_name ?? fromUuid("acct", row.account_id),
    status: row.status as KybStatus,
    profile: readProfile(c, row),
    declared_by: row.declared_by ? fromUuid("usr", row.declared_by) : null,
    requested_info: row.requested_info,
    decision_reason: row.decision_reason,
    decided_by: row.decided_by ? apiActor(row.decided_by) : null,
    created: unix(row.created_at) as number,
    submitted_at: unix(row.submitted_at),
    decided_at: unix(row.decided_at),
    history: transitions.map((t) => ({
      status: t.to_state as KybStatus,
      actor: apiActor(t.actor),
      reason: historyReason(t),
      at: unix(t.created_at) as number,
    })),
  };
}

export type OpsKybCaseView = Awaited<ReturnType<typeof opsView>>;

export async function getOpsKybCase(c: Compliance, accountId: string): Promise<OpsKybCaseView> {
  const row = await c.db
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", accountUuidOf(accountId))
    .executeTakeFirst();
  if (!row) throw ApiError.missing("kyb_case", accountId, "id");
  return opsView(c, c.db, row as KybRow);
}

/**
 * Businesses list (`listOpsKybCases`; the console's former review queue): `pending` by default, oldest
 * submission first; the console asks for `approved` / `rejected` in auto mode. Cursors are account ids.
 */
export async function listOpsKybCases(
  c: Compliance,
  f: {
    limit: number;
    starting_after?: string | undefined;
    ending_before?: string | undefined;
    status?: KybStatus | undefined;
    account?: string | undefined;
  },
  url: string,
): Promise<Page<OpsKybCaseView>> {
  const key = sql`coalesce(submitted_at, created_at)`;
  let q = c.db
    .selectFrom("kyb_cases")
    .selectAll()
    .where("status", "=", f.status ?? "pending");
  if (f.account) q = q.where("account_id", "=", accountUuidOf(f.account, "account"));
  const cursorId = f.starting_after ?? f.ending_before;
  const backwards = f.starting_after === undefined && f.ending_before !== undefined;
  if (cursorId !== undefined) {
    const param = backwards ? "ending_before" : "starting_after";
    const cur = await c.db
      .selectFrom("kyb_cases")
      .select("id")
      .where("account_id", "=", accountUuidOf(cursorId, param))
      .executeTakeFirst();
    if (!cur) throw ApiError.missing("kyb_case", cursorId, param);
    const pos = sql`(select coalesce(submitted_at, created_at), id from kyb_cases where id = ${cur.id}::uuid)`;
    q = q.where(backwards ? sql<boolean>`(${key}, id) < ${pos}` : sql<boolean>`(${key}, id) > ${pos}`);
  }
  const rows = (await q
    .orderBy(key, backwards ? "desc" : "asc")
    .orderBy("id", backwards ? "desc" : "asc")
    .limit(f.limit + 1)
    .execute()) as KybRow[];
  const page = pageOf(rows, f.limit, backwards, url, (r) => r);
  return { ...page, data: await Promise.all(page.data.map((r) => opsView(c, c.db, r))) };
}

/** `getInternalKybCase` (identity, on `kyb.approved`): status and declared details. */
export async function getInternalKybCase(c: Compliance, accountId: string) {
  const row = await c.db
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", accountUuidOf(accountId))
    .executeTakeFirst();
  if (!row) throw ApiError.missing("kyb_case", accountId, "id");
  return {
    account_id: fromUuid("acct", row.account_id),
    status: row.status as KybStatus,
    profile: readProfile(c, row as KybRow),
    decided_at: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

/** Ops CLI `kyb-show`. */
export async function getKybCase(c: Compliance, accountId: string) {
  return c.db
    .selectFrom("kyb_cases")
    .selectAll()
    .where("account_id", "=", toUuid(accountId, "acct"))
    .executeTakeFirst();
}
