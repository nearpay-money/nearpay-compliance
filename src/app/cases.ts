/**
 * Compliance cases (compliance LLD §3, §6): opened by consumers (post-screen hits, held executions,
 * audit mismatches) and ops (blocklist hits); one open case per (kind, subject). Cases about a payment
 * are reviews and emit `evt.compliance.review.opened` / `.closed` in the same transaction.
 */
import { sql, withTx } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import {
  type CaseKind,
  type CaseStatus,
  type CaseSubject,
  isReview,
  type Severity,
  severityOf,
  transitionCase,
} from "../domain/case/case.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";

export interface OpenCaseInput {
  kind: CaseKind;
  subject: CaseSubject;
  accountId: string | null;
  livemode: boolean;
  actor: string;
  note?: string;
  severity?: Severity;
}

function reviewOf(row: {
  id: string;
  account_id: string | null;
  kind: string;
  subject: { type: string; id: string };
  status: string;
  created_at: Date;
  closed_at: Date | null;
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
  };
}

async function note(c: Compliance, tx: Tx, caseId: string, actor: string, action: string, text?: string) {
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
  const inserted = await sql<{ id: string; created_at: Date }>`
    insert into cases (id, account_id, livemode, kind, subject, severity, status)
    values (${id}, ${accountUuid}, ${i.livemode}, ${i.kind}, ${JSON.stringify(i.subject)}::jsonb, ${severity}, 'open')
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

/** Moves a case to `investigating` or `closed` (with a resolution); closing a review emits `review.closed`. */
export async function updateCase(
  c: Compliance,
  caseId: string,
  to: Exclude<CaseStatus, "open">,
  actor: string,
  text?: string,
) {
  return withTx(c.db, async (tx) => {
    const uuid = caseUuid(caseId);
    const row = await tx.selectFrom("cases").selectAll().where("id", "=", uuid).forUpdate().executeTakeFirst();
    if (!row) throw ApiError.missing("case", caseId);
    const step = transitionCase(row.status as CaseStatus, to);
    if (!step.ok) throw new ApiError("state_conflict", { params: { object: "case", state: row.status } });
    const now = await dbNow(tx);
    const updated = await tx
      .updateTable("cases")
      .set({
        status: to,
        version: row.version + 1,
        ...(to === "closed" ? { closed_at: now, resolution: text ?? "closed" } : {}),
      })
      .where("id", "=", uuid)
      .returningAll()
      .executeTakeFirstOrThrow();
    await note(c, tx, uuid, actor, to, text);
    const subject = updated.subject;
    if (to === "closed" && updated.account_id && isReview(updated.kind as CaseKind, subject as CaseSubject)) {
      await emitEvent(tx, {
        subject: "evt.compliance.review.closed",
        aggregate: { type: "case", id: fromUuid("case", uuid), version: updated.version },
        accountUuid: updated.account_id,
        livemode: updated.livemode,
        object: reviewOf(updated),
        previous: { status: "open" },
      });
    }
    return updated;
  });
}

/** Adds an encrypted note to a case. */
export async function addCaseNote(c: Compliance, caseId: string, actor: string, text: string): Promise<void> {
  await withTx(c.db, async (tx) => {
    const uuid = caseUuid(caseId);
    const row = await tx.selectFrom("cases").select("id").where("id", "=", uuid).executeTakeFirst();
    if (!row) throw ApiError.missing("case", caseId);
    await note(c, tx, uuid, actor, "note", text);
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
