/**
 * Ops actions (compliance LLD §5, §5.1, FR-CMP-04): account suspension, blocklist, screening and
 * re-screening, geo policy. The ops CLI (`node dist/ops.js …`) and the console routes share these use
 * cases; every action records its actor and emits its events in the same transaction, and console
 * writes are also operator actions (`ops_actions` + `evt.compliance.ops_action.recorded`).
 */
import { enqueueJob, sql, withTx } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { normalizePolicy, PolicyError } from "../domain/geo-policy/policy.js";
import { type Operator, singlePersonAllowed } from "../domain/ops-approval/approval.js";
import { normalizeBlocklistSubject, SubjectError } from "../domain/screening/subject.js";
import { apiActor, openCase } from "./cases.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";
import { operatorActor, recordOpsAction } from "./ops-actions.js";
import { type Page, pageOf } from "./paging.js";
import { screen } from "./screening.js";

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/**
 * Sets the suspension flag of an account in `tx` and emits `account.suspended|reinstated`; a no-op
 * when it is already in that state. Used by the two-person approval (console) and the ops CLI.
 */
export async function applySuspension(
  c: Compliance,
  tx: Tx,
  accountUuid: string,
  suspended: boolean,
  reason: string,
  actor: string,
): Promise<{ changed: boolean }> {
  const row = await tx
    .selectFrom("account_flags")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .forUpdate()
    .executeTakeFirst();
  if ((row?.suspended ?? false) === suspended) return { changed: false };
  const now = await dbNow(tx);
  const version = (row?.version ?? 0) + 1;
  await tx
    .insertInto("account_flags")
    .values({ account_id: accountUuid, suspended, reason, actor, version, updated_at: now })
    .onConflict((oc) => oc.column("account_id").doUpdateSet({ suspended, reason, actor, version, updated_at: now }))
    .execute();
  await emitEvent(tx, {
    subject: suspended ? "evt.compliance.account.suspended" : "evt.compliance.account.reinstated",
    aggregate: { type: "account", id: fromUuid("acct", accountUuid), version },
    accountUuid,
    livemode: null,
    object: { account_id: fromUuid("acct", accountUuid), reason },
  });
  c.log.warn({ acct: fromUuid("acct", accountUuid), suspended, actor }, "account suspension changed");
  return { changed: true };
}

/**
 * Ops CLI `account-suspend` / `account-reinstate`: single-person, only when `NP_ENV` is `local` or
 * `test`. On any other value (`server`, an unknown stage, a mistyped one) the two-person rule applies and
 * the console is the only path. `env` has no default: a caller must say where it runs.
 */
export async function setAccountSuspended(
  c: Compliance,
  accountId: string,
  suspended: boolean,
  reason: string,
  actor: string,
  env: string,
): Promise<{ changed: boolean }> {
  if (!singlePersonAllowed(env)) throw new ApiError("two_person_required");
  return withTx(c.db, (tx) => applySuspension(c, tx, toUuid(accountId, "acct"), suspended, reason, actor));
}

// ---------------------------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------------------------

/**
 * Blocks a monitored destination: `evt.compliance.destination.blocked` (identity disables it) and a
 * `screening_hit` case. Idempotent per destination while it stays inactive.
 */
export async function blockDestination(
  c: Compliance,
  tx: Tx,
  d: { destination_id: string; account_id: string; livemode: boolean; source_version: number },
  reason: string,
  actor: string,
): Promise<void> {
  const sd = fromUuid("sd", d.destination_id);
  const acct = fromUuid("acct", d.account_id);
  await tx
    .updateTable("monitored_destinations")
    .set({ active: false, updated_at: await dbNow(tx) })
    .where("destination_id", "=", d.destination_id)
    .execute();
  await emitEvent(tx, {
    subject: "evt.compliance.destination.blocked",
    aggregate: { type: "settlement_destination", id: sd, version: d.source_version },
    accountUuid: d.account_id,
    livemode: d.livemode,
    object: { destination_id: sd, account_id: acct, reason },
  });
  await openCase(c, tx, {
    kind: "screening_hit",
    subject: { type: "settlement_destination", id: sd },
    accountId: acct,
    livemode: d.livemode,
    actor,
    note: reason,
  });
}

// ---------------------------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------------------------

function blocklistSubject(subjectType: "address" | "near_account", subject: string, chain?: string) {
  try {
    return normalizeBlocklistSubject(subjectType, subject, chain);
  } catch (e) {
    if (e instanceof SubjectError)
      throw new ApiError("address_invalid", {
        params: { address: subject, chain: chain ?? "any chain" },
        param: e.param,
      });
    throw e;
  }
}

/**
 * Writes a blocklist entry in `tx`, invalidates cached allows of the subject and blocks every active live
 * destination with that address (`destination.blocked` + `screening_hit` case). `create` refuses an
 * existing entry (console, `409 state_conflict`); `upsert` replaces its reason (ops CLI, Stage 1).
 */
async function writeBlocklistEntry(
  c: Compliance,
  tx: Tx,
  i: { subjectType: "address" | "near_account"; norm: string; chain: string | null; reason: string; actor: string },
  mode: "create" | "upsert",
) {
  const id = uuidv7();
  const q = tx.insertInto("blocklist").values({
    id,
    subject_type: i.subjectType,
    subject: i.norm,
    chain: i.chain,
    reason: i.reason,
    created_by: i.actor,
  });
  const row = await (mode === "create"
    ? q.onConflict((oc) => oc.columns(["subject_type", "subject"]).doNothing())
    : q.onConflict((oc) =>
        oc.columns(["subject_type", "subject"]).doUpdateSet({ reason: i.reason, created_by: i.actor }),
      )
  )
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new ApiError("state_conflict", { params: { object: "blocklist_entry", state: "already listed" } });
  const now = await dbNow(tx);
  await tx
    .updateTable("screenings")
    .set({ expires_at: now })
    .where("subject_norm", "=", i.norm)
    .where("decision", "=", "allow")
    .where("expires_at", ">", now)
    .execute();
  const hits = await tx
    .selectFrom("monitored_destinations")
    .selectAll()
    .where("address_norm", "=", i.norm)
    .where("active", "=", true)
    .where("livemode", "=", true)
    .forUpdate()
    .execute();
  for (const d of hits) await blockDestination(c, tx, d, `blocklist: ${i.reason}`, i.actor);
  c.log.warn({ subject_type: i.subjectType, actor: i.actor, destinations: hits.length }, "blocklist entry added");
  return { row, destinationsBlocked: hits.length };
}

/** Ops CLI `blocklist-add`: adds (or re-reasons) an entry and blocks matching live destinations. */
export async function addToBlocklist(
  c: Compliance,
  i: { subjectType: "address" | "near_account"; subject: string; chain?: string; reason: string; actor: string },
): Promise<{ subject: string; destinationsBlocked: number }> {
  const { norm, chain } = blocklistSubject(i.subjectType, i.subject, i.chain);
  return withTx(c.db, async (tx) => {
    const r = await writeBlocklistEntry(c, tx, { ...i, norm, chain }, "upsert");
    return { subject: norm, destinationsBlocked: r.destinationsBlocked };
  });
}

/** Ops CLI `blocklist-remove`. */
export async function removeFromBlocklist(
  c: Compliance,
  subjectType: "address" | "near_account",
  subject: string,
  chain?: string,
) {
  const { norm } = blocklistSubject(subjectType, subject, chain);
  const r = await c.db
    .deleteFrom("blocklist")
    .where("subject_type", "=", subjectType)
    .where("subject", "=", norm)
    .executeTakeFirst();
  return { removed: Number(r.numDeletedRows) };
}

type BlocklistRow = {
  id: string;
  subject_type: string;
  subject: string;
  chain: string | null;
  reason: string;
  created_by: string;
  created_at: Date;
};

function renderBlocklistEntry(r: BlocklistRow) {
  return {
    id: fromUuid("bl", r.id),
    object: "blocklist_entry" as const,
    subject_type: r.subject_type as "address" | "near_account",
    chain: r.chain,
    subject: r.subject,
    reason: r.reason,
    created_by: apiActor(r.created_by),
    created: Math.floor(r.created_at.getTime() / 1000),
  };
}

/** `listOpsBlocklist`: newest first; `subject` is normalised by form before matching. */
export async function listOpsBlocklist(
  c: Compliance,
  f: {
    limit: number;
    starting_after?: string | undefined;
    ending_before?: string | undefined;
    subject_type?: string | undefined;
    subject?: string | undefined;
  },
  url: string,
): Promise<Page<ReturnType<typeof renderBlocklistEntry>>> {
  let q = c.db.selectFrom("blocklist").selectAll();
  if (f.subject_type) q = q.where("subject_type", "=", f.subject_type);
  if (f.subject) {
    let norm = f.subject.trim();
    try {
      norm = normalizeBlocklistSubject("address", norm).norm;
    } catch {
      // not an address form: match as given
    }
    q = q.where((eb) => eb.or([eb("subject", "=", norm), eb("subject", "=", f.subject?.trim().toLowerCase() ?? norm)]));
  }
  const cursorId = f.starting_after ?? f.ending_before;
  const backwards = f.starting_after === undefined && f.ending_before !== undefined;
  if (cursorId !== undefined) {
    const param = backwards ? "ending_before" : "starting_after";
    if (!isId("bl", cursorId)) throw ApiError.invalid(`${cursorId} is not a blocklist entry id`, param);
    const pos = sql`(select created_at, id from blocklist where id = ${toUuid(cursorId, "bl")}::uuid)`;
    q = q.where(backwards ? sql<boolean>`(created_at, id) > ${pos}` : sql<boolean>`(created_at, id) < ${pos}`);
  }
  const rows = await q
    .orderBy("created_at", backwards ? "asc" : "desc")
    .orderBy("id", backwards ? "asc" : "desc")
    .limit(f.limit + 1)
    .execute();
  return pageOf(rows, f.limit, backwards, url, renderBlocklistEntry);
}

/** `addOpsBlocklistEntry` (step-up): a new entry; an existing one is `409 state_conflict`. */
export async function addOpsBlocklistEntry(
  c: Compliance,
  op: Operator,
  i: { subject_type: "address" | "near_account"; chain?: string | undefined; subject: string; reason: string },
) {
  const { norm, chain } = blocklistSubject(i.subject_type, i.subject, i.chain);
  return withTx(c.db, async (tx) => {
    const { row } = await writeBlocklistEntry(
      c,
      tx,
      { subjectType: i.subject_type, norm, chain, reason: i.reason, actor: operatorActor(op) },
      "create",
    );
    await recordOpsAction(c, tx, op, {
      action: "blocklist_entry.added",
      target: { type: "blocklist_entry", id: fromUuid("bl", row.id) },
      accountUuid: null,
      note: i.reason,
    });
    return renderBlocklistEntry(row);
  });
}

/**
 * `removeOpsBlocklistEntry` (ops_admin, step-up). Destinations already disabled by a hit stay disabled;
 * sanctions-list entries are not blocklist entries and cannot be removed here.
 */
export async function removeOpsBlocklistEntry(c: Compliance, op: Operator, entryId: string, reason: string) {
  if (!isId("bl", entryId)) throw ApiError.invalid(`${entryId} is not a blocklist entry id`, "id");
  await withTx(c.db, async (tx) => {
    const row = await tx
      .deleteFrom("blocklist")
      .where("id", "=", toUuid(entryId, "bl"))
      .returningAll()
      .executeTakeFirst();
    if (!row) throw ApiError.missing("blocklist_entry", entryId, "id");
    await recordOpsAction(c, tx, op, {
      action: "blocklist_entry.removed",
      target: { type: "blocklist_entry", id: entryId },
      accountUuid: null,
      note: reason,
    });
    c.log.warn({ entry: entryId, operator: op.sub }, "blocklist entry removed");
  });
}

// ---------------------------------------------------------------------------------------------
// Screening and re-screening (console)
// ---------------------------------------------------------------------------------------------

/** `createOpsScreening`: an uncached lookup (stored, never served from or written to the cache). */
export async function createOpsScreening(
  c: Compliance,
  op: Operator,
  i: { subject_type: "address" | "near_account"; chain?: string | undefined; subject: string; livemode: boolean },
) {
  const r = await screen(
    c,
    { subject_type: i.subject_type, chain: i.chain, subject: i.subject, context: "ops", livemode: i.livemode },
    { fresh: true, uncached: true, requestedBy: operatorActor(op) },
  );
  await withTx(c.db, (tx) =>
    recordOpsAction(c, tx, op, {
      action: "screening.created",
      target: { type: "screening", id: r.screening_id },
      accountUuid: null,
    }),
  );
  return r;
}

export const RESCREEN_JOB = "destinations.rescreen";

/** `createOpsRescreen`: queues the re-screening job for one account's active live destinations, or all. */
export async function createOpsRescreen(c: Compliance, op: Operator, accountId: string | undefined) {
  const accountUuid = accountId ? toUuid(accountId, "acct") : null;
  return withTx(c.db, async (tx) => {
    let q = tx
      .selectFrom("monitored_destinations")
      .select(sql<string>`count(*)::text`.as("n"))
      .where("active", "=", true)
      .where("livemode", "=", true);
    if (accountUuid) q = q.where("account_id", "=", accountUuid);
    const n = Number((await q.executeTakeFirstOrThrow()).n);
    const job = await enqueueJob(tx, {
      kind: RESCREEN_JOB,
      payload: { account_id: accountUuid, requested_by: op.sub },
      dedupeKey: `${RESCREEN_JOB}:ops:${uuidv7()}`,
    });
    await recordOpsAction(c, tx, op, {
      action: "rescreen.queued",
      target: { type: "job", id: fromUuid("job", job.id) },
      accountUuid,
    });
    return { job_id: fromUuid("job", job.id), destinations: n };
  });
}

// ---------------------------------------------------------------------------------------------
// Geo policy
// ---------------------------------------------------------------------------------------------

export async function getGeoPolicy(c: Compliance) {
  const p = await c.db.selectFrom("policies").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
  return {
    blocked_countries: p.blocked_countries.map((x) => x.trim()),
    blocked_regions: p.blocked_regions,
    version: String(p.version),
  };
}

/** Replaces the blocked countries/regions; emits `evt.compliance.policy.updated` (payments refreshes). */
export async function setGeoPolicy(
  c: Compliance,
  input: { blockedCountries: string[]; blockedRegions: string[] },
  actor: string,
) {
  let p: ReturnType<typeof normalizePolicy>;
  try {
    p = normalizePolicy(input);
  } catch (e) {
    if (e instanceof PolicyError) throw ApiError.invalid(e.message);
    throw e;
  }
  return withTx(c.db, async (tx) => {
    const row = await tx
      .selectFrom("policies")
      .selectAll()
      .where("id", "=", "default")
      .forUpdate()
      .executeTakeFirstOrThrow();
    const updated = await tx
      .updateTable("policies")
      .set({
        blocked_countries: p.blockedCountries,
        blocked_regions: p.blockedRegions,
        version: row.version + 1,
        updated_at: await dbNow(tx),
      })
      .where("id", "=", "default")
      .returningAll()
      .executeTakeFirstOrThrow();
    const object = {
      version: String(updated.version),
      blocked_countries: p.blockedCountries,
      blocked_regions: p.blockedRegions,
    };
    await emitEvent(tx, {
      subject: "evt.compliance.policy.updated",
      aggregate: { type: "policy", id: fromUuid("pol", updated.uid), version: updated.version },
      accountUuid: null,
      livemode: null,
      object,
      previous: { blocked_countries: row.blocked_countries.map((x) => x.trim()), blocked_regions: row.blocked_regions },
    });
    c.log.warn({ actor, ...object }, "geo policy updated");
    return object;
  });
}
