/**
 * Compliance cases (compliance LLD §3, §5, §5.1, §6): opened by consumers (post-screen hits, held
 * executions, audit mismatches), by ops (blocklist hits) and by services (`createInternalCase`:
 * payments' reconciliation diffs); one open case per (kind, subject). Cases about a payment are
 * reviews and emit `evt.compliance.review.opened` / `.closed` in the same transaction. Operators work
 * cases in the console (assign, comment, close); every console write is also an operator action.
 */
import { type Selectable, sql, withTx } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import {
  assignCase,
  type CaseKind,
  type CaseStatus,
  type CaseSubject,
  closeCase,
  isReview,
  type Resolution,
  resolutionOf,
  type Severity,
  severityOf,
  severityRank,
  timelineAction,
  transitionCase,
} from "../domain/case/case.js";
import type { Operator } from "../domain/ops-approval/approval.js";
import type { CasesTable } from "../infra/db/schema.js";
import { accountNames } from "./account-names.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";
import { operatorActor, recordOpsAction } from "./ops-actions.js";
import { type Page, pageOf } from "./paging.js";

export interface OpenCaseInput {
  kind: CaseKind;
  subject: CaseSubject;
  accountId: string | null;
  livemode: boolean;
  actor: string;
  note?: string;
  severity?: Severity;
  /** Payment intent of an `execution` subject (`Execution.reference.payment_intent`). */
  paymentIntent?: string | null;
}

type CaseRow = Selectable<CasesTable>;

function reviewOf(row: {
  id: string;
  account_id: string | null;
  kind: string;
  subject: { type: string; id: string };
  status: string;
  created_at: Date;
  closed_at: Date | null;
  payment_intent: string | null;
}) {
  return {
    id: fromUuid("case", row.id),
    object: "review" as const,
    account_id: fromUuid("acct", row.account_id as string),
    subject: row.subject,
    reason: row.kind,
    status: row.status === "closed" ? "closed" : "open",
    opened_at: row.created_at.toISOString(),
    closed_at: row.closed_at ? row.closed_at.toISOString() : null,
    payment_intent: row.payment_intent,
  };
}

async function note(c: Compliance, tx: Tx, caseId: string, actor: string, action: string, text?: string | null) {
  await tx
    .insertInto("case_events")
    .values({
      id: uuidv7(),
      case_id: caseId,
      actor,
      action,
      note_enc: text ? c.cipher.encrypt(text, `case:${caseId}`) : null,
    })
    .execute();
}

/** Opens a case unless one is already open for (kind, subject). Returns the open case and whether it is new. */
export async function openCase(c: Compliance, tx: Tx, i: OpenCaseInput): Promise<{ id: string; created: boolean }> {
  const id = uuidv7();
  const accountUuid = i.accountId ? toUuid(i.accountId, "acct") : null;
  const severity = i.severity ?? severityOf(i.kind, i.livemode);
  const paymentIntent = i.paymentIntent ?? null;
  const inserted = await sql<{ id: string; created_at: Date }>`
    insert into cases (id, account_id, livemode, kind, subject, severity, status, payment_intent)
    values (${id}, ${accountUuid}, ${i.livemode}, ${i.kind}, ${JSON.stringify(i.subject)}::jsonb, ${severity}, 'open',
      ${paymentIntent})
    on conflict (kind, (subject->>'type'), (subject->>'id')) where status <> 'closed' do nothing
    returning id, created_at`.execute(tx);
  const row = inserted.rows[0];
  if (!row) {
    const existing = await tx
      .selectFrom("cases")
      .select("id")
      .where("kind", "=", i.kind)
      .where(sql<string>`subject->>'type'`, "=", i.subject.type)
      .where(sql<string>`subject->>'id'`, "=", i.subject.id)
      .where("status", "<>", "closed")
      .executeTakeFirstOrThrow();
    return { id: existing.id, created: false };
  }
  await note(c, tx, id, i.actor, "opened", i.note);
  if (accountUuid && isReview(i.kind, i.subject)) {
    await emitEvent(tx, {
      subject: "evt.compliance.review.opened",
      aggregate: { type: "case", id: fromUuid("case", id), version: 0 },
      accountUuid,
      livemode: i.livemode,
      object: reviewOf({
        id,
        account_id: accountUuid,
        kind: i.kind,
        subject: i.subject,
        status: "open",
        created_at: row.created_at,
        closed_at: null,
        payment_intent: paymentIntent,
      }),
    });
  }
  c.log.warn({ case: fromUuid("case", id), kind: i.kind, subject: i.subject, severity }, "compliance case opened");
  return { id, created: true };
}

function caseUuid(caseId: string): string {
  if (!isId("case", caseId)) throw ApiError.invalid(`${caseId} is not a case id`, "case");
  return toUuid(caseId, "case");
}

async function lockCase(tx: Tx, caseId: string): Promise<CaseRow> {
  const row = await tx
    .selectFrom("cases")
    .selectAll()
    .where("id", "=", caseUuid(caseId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw ApiError.missing("case", caseId);
  return row as CaseRow;
}

async function emitReviewClosed(tx: Tx, updated: CaseRow) {
  if (updated.account_id && isReview(updated.kind, updated.subject)) {
    await emitEvent(tx, {
      subject: "evt.compliance.review.closed",
      aggregate: { type: "case", id: fromUuid("case", updated.id), version: updated.version },
      accountUuid: updated.account_id,
      livemode: updated.livemode,
      object: reviewOf(updated),
      previous: { status: "open" },
    });
  }
}

/** Stage 1 ops CLI: moves a case to `investigating` or `closed` (free-text resolution). */
export async function updateCase(
  c: Compliance,
  caseId: string,
  to: Exclude<CaseStatus, "open">,
  actor: string,
  text?: string,
) {
  return withTx(c.db, async (tx) => {
    const row = await lockCase(tx, caseId);
    const step = transitionCase(row.status as CaseStatus, to);
    if (!step.ok) throw new ApiError("state_conflict", { params: { object: "case", state: row.status } });
    const now = await dbNow(tx);
    const updated = (await tx
      .updateTable("cases")
      .set({
        status: to,
        version: row.version + 1,
        ...(to === "closed" ? { closed_at: now, resolution: text ?? "closed" } : {}),
      })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as CaseRow;
    await note(c, tx, row.id, actor, to, text);
    if (to === "closed") await emitReviewClosed(tx, updated);
    return updated;
  });
}

/** Adds an encrypted note to a case (ops CLI). */
export async function addCaseNote(c: Compliance, caseId: string, actor: string, text: string): Promise<void> {
  await withTx(c.db, async (tx) => {
    const uuid = caseUuid(caseId);
    const row = await tx.selectFrom("cases").select("id").where("id", "=", uuid).executeTakeFirst();
    if (!row) throw ApiError.missing("case", caseId);
    await note(c, tx, uuid, actor, "note", text);
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering (`ComplianceCase`)
// ---------------------------------------------------------------------------------------------

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** API actor of a stored actor: `ops:usr_…`/`user:usr_…` → `usr_…`; `ops:<cli actor>` → `cli:<actor>`. */
export function apiActor(stored: string): string {
  const [kind, rest] = stored.includes(":")
    ? [stored.slice(0, stored.indexOf(":")), stored.slice(stored.indexOf(":") + 1)]
    : ["", stored];
  if ((kind === "ops" || kind === "user") && isId("usr", rest)) return rest;
  if (kind === "ops" && rest) return `cli:${rest}`;
  return "system";
}

async function timeline(c: Compliance, db: Compliance["db"] | Tx, caseUuidValue: string) {
  const events = await db
    .selectFrom("case_events")
    .selectAll()
    .where("case_id", "=", caseUuidValue)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return events.map((e) => ({
    actor: apiActor(e.actor),
    action: timelineAction(e.action),
    note: e.note_enc ? c.cipher.decrypt(e.note_enc, `case:${caseUuidValue}`).toString("utf8") : null,
    at: unix(e.created_at),
  }));
}

export function renderCase(
  row: CaseRow,
  events?: Awaited<ReturnType<typeof timeline>>,
  accountDisplayName: string | null = null,
) {
  return {
    id: fromUuid("case", row.id),
    object: "compliance_case" as const,
    account_id: row.account_id ? fromUuid("acct", row.account_id) : null,
    // spec 0.2.1: from identity's account events; null for platform cases and unknown accounts
    account_display_name: row.account_id ? accountDisplayName : null,
    livemode: row.livemode,
    kind: row.kind as CaseKind,
    subject: row.subject,
    severity: row.severity as Severity,
    status: row.status as CaseStatus,
    assignee: row.assignee ? fromUuid("usr", row.assignee) : null,
    resolution: resolutionOf(row.resolution),
    review: row.account_id !== null && isReview(row.kind, row.subject),
    created: unix(row.created_at),
    closed_at: row.closed_at ? unix(row.closed_at) : null,
    ...(events ? { events } : {}),
  };
}

export type RenderedCase = ReturnType<typeof renderCase>;

// ---------------------------------------------------------------------------------------------
// Console (ops routes) and services
// ---------------------------------------------------------------------------------------------

export interface CaseFilters {
  limit: number;
  starting_after?: string | undefined;
  ending_before?: string | undefined;
  status?: string | undefined;
  kind?: string | undefined;
  severity?: string | undefined;
  account?: string | undefined;
  assignee?: string | undefined;
  livemode?: "true" | "false" | undefined;
  /** Spec 0.2.1: exact `subject.id` (index `cases_subject_id`). */
  subject?: string | undefined;
  "created[gte]"?: number | undefined;
  "created[lte]"?: number | undefined;
}

const RANK = sql<number>`case severity when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`;

/**
 * Console queue (`listOpsCases`): not closed by default; highest severity first, then oldest, then id.
 * Cursors are case ids; the position of the cursor case decides where the page starts.
 */
export async function listOpsCases(c: Compliance, f: CaseFilters, url: string): Promise<Page<RenderedCase>> {
  let q = c.db.selectFrom("cases").selectAll();
  q = f.status ? q.where("status", "=", f.status) : q.where("status", "<>", "closed");
  if (f.kind) q = q.where("kind", "=", f.kind);
  if (f.severity) q = q.where("severity", "=", f.severity);
  if (f.account) q = q.where("account_id", "=", toUuid(f.account, "acct"));
  if (f.assignee) q = q.where("assignee", "=", toUuid(f.assignee, "usr"));
  if (f.livemode) q = q.where("livemode", "=", f.livemode === "true");
  if (f.subject) q = q.where(sql<string>`subject->>'id'`, "=", f.subject);
  if (f["created[gte]"] !== undefined) q = q.where("created_at", ">=", new Date(f["created[gte]"] * 1000));
  if (f["created[lte]"] !== undefined) q = q.where("created_at", "<", new Date((f["created[lte]"] + 1) * 1000));
  const cursorId = f.starting_after ?? f.ending_before;
  const backwards = f.starting_after === undefined && f.ending_before !== undefined;
  if (cursorId !== undefined) {
    if (!isId("case", cursorId))
      throw ApiError.invalid(`${cursorId} is not a case id`, backwards ? "ending_before" : "starting_after");
    const cur = await c.db
      .selectFrom("cases")
      .select(["id", "severity", "created_at"])
      .where("id", "=", toUuid(cursorId, "case"))
      .executeTakeFirst();
    if (!cur) throw ApiError.missing("case", cursorId, backwards ? "ending_before" : "starting_after");
    const r = severityRank(cur.severity);
    // compare timestamps in the database (microseconds), never through a JS Date (milliseconds)
    const pos = sql`(select created_at, id from cases where id = ${cur.id}::uuid)`;
    q = backwards
      ? q.where(sql<boolean>`(${RANK} > ${r} or (${RANK} = ${r} and (created_at, id) < ${pos}))`)
      : q.where(sql<boolean>`(${RANK} < ${r} or (${RANK} = ${r} and (created_at, id) > ${pos}))`);
  }
  const ordered = backwards
    ? q.orderBy(RANK, "asc").orderBy("created_at", "desc").orderBy("id", "desc")
    : q.orderBy(RANK, "desc").orderBy("created_at", "asc").orderBy("id", "asc");
  const rows = (await ordered.limit(f.limit + 1).execute()) as CaseRow[];
  const names = await accountNames(
    c.db,
    rows.flatMap((r) => (r.account_id ? [r.account_id] : [])),
  );
  return pageOf(rows, f.limit, backwards, url, (r) =>
    renderCase(r, undefined, r.account_id ? (names.get(r.account_id) ?? null) : null),
  );
}

async function nameOf(db: Compliance["db"] | Tx, row: CaseRow): Promise<string | null> {
  if (!row.account_id) return null;
  return (await accountNames(db, [row.account_id])).get(row.account_id) ?? null;
}

export async function getOpsCase(c: Compliance, caseId: string): Promise<RenderedCase> {
  const row = await c.db.selectFrom("cases").selectAll().where("id", "=", caseUuid(caseId)).executeTakeFirst();
  if (!row) throw ApiError.missing("case", caseId);
  return renderCase(row as CaseRow, await timeline(c, c.db, row.id), await nameOf(c.db, row as CaseRow));
}

async function rendered(c: Compliance, tx: Tx, row: CaseRow) {
  return renderCase(row, await timeline(c, tx, row.id), await nameOf(tx, row));
}

/**
 * Spec 0.2.1: the assignee must be an active console operator (identity `getInternalOpsOperator`).
 * Unknown or revoked → `400 invalid_request` (`assignee`); identity unavailable → fail closed (no
 * assignment): `api_error` (retryable, `Retry-After`) — the catalogue has no generic 503 code (CR).
 */
async function assertActiveOperator(c: Compliance, assignee: string): Promise<void> {
  let o: Awaited<ReturnType<NonNullable<Compliance["operators"]>["operator"]>>;
  try {
    if (!c.operators) throw new Error("no identity client in this process");
    o = await c.operators.operator(assignee);
  } catch (e) {
    c.log.error({ err: e }, "identity operator check failed; case not assigned");
    throw new ApiError("api_error", {
      message: "The assignee could not be checked right now; retry with the same Idempotency-Key.",
      headers: { "Retry-After": "5" },
      cause: e,
    });
  }
  if (!o?.active) throw ApiError.invalid(`${assignee} is not an active console operator`, "assignee");
}

/** `assignOpsCase`: assign (open → investigating) or unassign. */
export async function assignOpsCase(c: Compliance, op: Operator, caseId: string, assignee: string | null) {
  return withTx(c.db, async (tx) => {
    const row = await lockCase(tx, caseId);
    const step = assignCase(row.status as CaseStatus, assignee);
    if (!step.ok) throw new ApiError("state_conflict", { params: { object: "case", state: row.status } });
    const assigneeUuid = assignee ? toUuid(assignee, "usr") : null;
    if (assigneeUuid === row.assignee && step.to === row.status) return rendered(c, tx, row);
    if (assignee) await assertActiveOperator(c, assignee);
    const updated = (await tx
      .updateTable("cases")
      .set({ assignee: assigneeUuid, status: step.to, version: row.version + 1 })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as CaseRow;
    const action = assignee ? "assigned" : "unassigned";
    await note(c, tx, row.id, operatorActor(op), action, assignee);
    await recordOpsAction(c, tx, op, {
      action: `case.${action}`,
      target: { type: "compliance_case", id: fromUuid("case", row.id) },
      accountUuid: row.account_id,
    });
    return rendered(c, tx, updated);
  });
}

/** `commentOpsCase`: an encrypted note on the timeline (also on closed cases: the log is append-only). */
export async function commentOpsCase(c: Compliance, op: Operator, caseId: string, text: string) {
  return withTx(c.db, async (tx) => {
    const row = await lockCase(tx, caseId);
    await note(c, tx, row.id, operatorActor(op), "commented", text);
    await recordOpsAction(c, tx, op, {
      action: "case.commented",
      target: { type: "compliance_case", id: fromUuid("case", row.id) },
      accountUuid: row.account_id,
    });
    return rendered(c, tx, row);
  });
}

/** `closeOpsCase`: records the resolution; a merchant-visible review emits `review.closed`. */
export async function closeOpsCase(c: Compliance, op: Operator, caseId: string, resolution: Resolution, text: string) {
  return withTx(c.db, async (tx) => {
    const row = await lockCase(tx, caseId);
    const step = closeCase(row.status as CaseStatus);
    if (!step.ok) throw new ApiError("state_conflict", { params: { object: "case", state: row.status } });
    const now = await dbNow(tx);
    const updated = (await tx
      .updateTable("cases")
      .set({ status: "closed", resolution, closed_at: now, version: row.version + 1 })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as CaseRow;
    await note(c, tx, row.id, operatorActor(op), "closed", text);
    await emitReviewClosed(tx, updated);
    await recordOpsAction(c, tx, op, {
      action: "case.closed",
      target: { type: "compliance_case", id: fromUuid("case", row.id) },
      accountUuid: row.account_id,
    });
    return rendered(c, tx, updated);
  });
}

/**
 * `createInternalCase` (payments → compliance): a `reconciliation_diff` case for a reconciliation run.
 * Never a merchant review. An open case for the same run is returned as is (one open case per kind
 * and subject); the route's Idempotency-Key (`rcn:<run id>`) makes a retried call replay.
 */
export async function createInternalCase(
  c: Compliance,
  caller: string,
  i: {
    kind: "reconciliation_diff";
    account_id: string;
    livemode: boolean;
    subject: { type: "reconciliation_run"; id: string };
    severity?: Severity | undefined;
    note: string;
  },
) {
  return withTx(c.db, async (tx) => {
    const { id } = await openCase(c, tx, {
      kind: i.kind,
      subject: i.subject,
      accountId: i.account_id,
      livemode: i.livemode,
      actor: `service:${caller}`,
      note: i.note,
      severity: i.severity ?? "high",
    });
    const row = (await tx.selectFrom("cases").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as CaseRow;
    return rendered(c, tx, row);
  });
}

/** Cases with their decrypted notes (ops CLI). */
export async function listCases(c: Compliance, o: { all?: boolean; limit?: number } = {}) {
  let q = c.db
    .selectFrom("cases")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(o.limit ?? 100);
  if (!o.all) q = q.where("status", "<>", "closed");
  const rows = await q.execute();
  const events = rows.length
    ? await c.db
        .selectFrom("case_events")
        .selectAll()
        .where(
          "case_id",
          "in",
          rows.map((r) => r.id),
        )
        .orderBy("created_at")
        .execute()
    : [];
  return rows.map((r) => ({
    id: fromUuid("case", r.id),
    account_id: r.account_id ? fromUuid("acct", r.account_id) : null,
    livemode: r.livemode,
    kind: r.kind,
    subject: r.subject,
    severity: r.severity,
    status: r.status,
    resolution: r.resolution,
    opened_at: r.created_at.toISOString(),
    closed_at: r.closed_at?.toISOString() ?? null,
    events: events
      .filter((e) => e.case_id === r.id)
      .map((e) => ({
        at: e.created_at.toISOString(),
        actor: e.actor,
        action: e.action,
        note: e.note_enc ? c.cipher.decrypt(e.note_enc, `case:${r.id}`).toString("utf8") : null,
      })),
  }));
}
