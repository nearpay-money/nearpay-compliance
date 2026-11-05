/**
 * Ops actions (compliance LLD §5, FR-CMP-04): account suspension, blocklist edits, geo policy. In
 * Stage 1 they run in-process through the ops CLI (`node dist/ops.js …`, platform §3); every action is
 * recorded with its actor and emits its event in the same transaction.
 */
import { withTx } from "@nearpay-internal/db";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { normalizePolicy, PolicyError } from "../domain/geo-policy/policy.js";
import { normalizeSubject, SubjectError, type SubjectType } from "../domain/screening/subject.js";
import { openCase } from "./cases.js";
import { type Compliance, dbNow, emitEvent, type Tx } from "./context.js";

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/** Suspends or reinstates an account; a no-op when it is already in that state. */
export async function setAccountSuspended(
  c: Compliance,
  accountId: string,
  suspended: boolean,
  reason: string,
  actor: string,
): Promise<{ changed: boolean }> {
  return withTx(c.db, async (tx) => {
    const uuid = toUuid(accountId, "acct");
    const row = await tx
      .selectFrom("account_flags")
      .selectAll()
      .where("account_id", "=", uuid)
      .forUpdate()
      .executeTakeFirst();
    if ((row?.suspended ?? false) === suspended) return { changed: false };
    const now = await dbNow(tx);
    const version = (row?.version ?? 0) + 1;
    await tx
      .insertInto("account_flags")
      .values({ account_id: uuid, suspended, reason, actor, version, updated_at: now })
      .onConflict((oc) => oc.column("account_id").doUpdateSet({ suspended, reason, actor, version, updated_at: now }))
      .execute();
    await emitEvent(tx, {
      subject: suspended ? "evt.compliance.account.suspended" : "evt.compliance.account.reinstated",
      aggregate: { type: "account", id: fromUuid("acct", uuid), version },
      accountUuid: uuid,
      livemode: null,
      object: { account_id: fromUuid("acct", uuid), reason },
    });
    c.log.warn({ acct: accountId, suspended, actor }, "account suspension changed");
    return { changed: true };
  });
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

/** Adds a subject to the blocklist and blocks every active live destination with that address. */
export async function addToBlocklist(
  c: Compliance,
  i: { subjectType: SubjectType; subject: string; chain?: string; reason: string; actor: string },
): Promise<{ subject: string; destinationsBlocked: number }> {
  let norm: string;
  try {
    norm = normalizeSubject(i.subjectType, i.subject, i.chain).norm;
  } catch (e) {
    if (e instanceof SubjectError) throw ApiError.invalid(e.message, e.param);
    throw e;
  }
  return withTx(c.db, async (tx) => {
    await tx
      .insertInto("blocklist")
      .values({ subject_type: i.subjectType, subject: norm, reason: i.reason, created_by: i.actor })
      .onConflict((oc) =>
        oc.columns(["subject_type", "subject"]).doUpdateSet({ reason: i.reason, created_by: i.actor }),
      )
      .execute();
    const hits = await tx
      .selectFrom("monitored_destinations")
      .selectAll()
      .where("address_norm", "=", norm)
      .where("active", "=", true)
      .where("livemode", "=", true)
      .forUpdate()
      .execute();
    for (const d of hits) await blockDestination(c, tx, d, `blocklist: ${i.reason}`, i.actor);
    c.log.warn({ subject_type: i.subjectType, actor: i.actor, destinations: hits.length }, "blocklist entry added");
    return { subject: norm, destinationsBlocked: hits.length };
  });
}

export async function removeFromBlocklist(c: Compliance, subjectType: SubjectType, subject: string, chain?: string) {
  const norm = normalizeSubject(subjectType, subject, chain).norm;
  const r = await c.db
    .deleteFrom("blocklist")
    .where("subject_type", "=", subjectType)
    .where("subject", "=", norm)
    .executeTakeFirst();
  return { removed: Number(r.numDeletedRows) };
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
