/**
 * The `worker` process against real NATS JetStream and Postgres: the domain consumers (LLD §6), the
 * outbox relay, the recurring jobs (LLD §7) and the events compliance produces.
 */
import { publish } from "@nearpay-internal/bus";
import { sql } from "@nearpay-internal/db";
import { fromUuid, newId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import {
  account,
  agentPayment,
  domainEvent,
  type EventProbe,
  execution,
  internalSettlementDestination,
} from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToBlocklist, createOpsRescreen, setAccountSuspended, setGeoPolicy } from "../../src/app/admin.js";
import { listCases, updateCase } from "../../src/app/cases.js";
import { decideKyb, submitKyb, updateKybProfile } from "../../src/app/kyb.js";
import { createSuspensionRequest } from "../../src/app/suspension.js";
import { rescreenDestinations } from "../../src/workers/jobs.js";
import { CLEAN_EVM, eventually, LISTED_EVM, type Stack, startStack } from "../support/stack.js";

const BASE = "eip155:8453";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

let s: Stack;
let probe: EventProbe;
beforeAll(async () => {
  s = await startStack({ worker: true });
  await s.importSample();
  probe = await s.probe();
});
afterAll(async () => {
  await probe?.close();
  await s?.stop();
});

const casesFor = async (subjectId: string) =>
  (await listCases(s.compliance, { all: true })).filter((c) => (c.subject as { id: string }).id === subjectId);

describe("evt.identity.account.created", () => {
  it("creates the KYB placeholder once, even when the event is delivered twice", async () => {
    const a = account();
    const e = domainEvent("evt.identity.account.created", a, { accountUuid: toUuid(a.id, "acct") });
    await s.publishEvent(e);
    await publish(s.bus as never, e.subject, e, `${e.id}-redelivered`); // same event id, new message id
    const row = await eventually(() =>
      s.admin.db.selectFrom("kyb_cases").selectAll().where("account_id", "=", toUuid(a.id, "acct")).executeTakeFirst(),
    );
    expect(row.status).toBe("not_started");
    expect(row.account_display_name).toBe(a.display_name);
    await eventually(async () => {
      const n = await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", e.id).execute();
      return n.length === 1;
    });
  });
});

describe("settlement destinations", () => {
  it("monitors activated destinations and ignores stale versions", async () => {
    const d = internalSettlementDestination({
      livemode: true,
      chain: BASE,
      address: CLEAN_EVM,
      address_norm: CLEAN_EVM,
      asset_id: USDC_BASE,
      type: "chain_address",
    });
    const uuid = toUuid(d.id, "sd");
    await s.publishEvent(
      domainEvent("evt.identity.settlement_destination.activated", d, { version: 2, livemode: true }),
    );
    await eventually(() =>
      s.admin.db.selectFrom("monitored_destinations").selectAll().where("destination_id", "=", uuid).executeTakeFirst(),
    );
    await s.publishEvent(
      domainEvent("evt.identity.settlement_destination.disabled", d, { version: 3, livemode: true }),
    );
    await eventually(async () => {
      const r = await s.admin.db
        .selectFrom("monitored_destinations")
        .selectAll()
        .where("destination_id", "=", uuid)
        .executeTakeFirst();
      return r?.active === false && r.source_version === 3;
    });
    // a late re-delivery of the older activation must not re-activate it
    const stale = domainEvent("evt.identity.settlement_destination.activated", d, { version: 2, livemode: true });
    await s.publishEvent(stale);
    await eventually(
      async () =>
        (await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", stale.id).execute()).length ===
        1,
    );
    const r = await s.admin.db
      .selectFrom("monitored_destinations")
      .selectAll()
      .where("destination_id", "=", uuid)
      .executeTakeFirstOrThrow();
    expect(r).toMatchObject({
      active: false,
      source_version: 3,
      account_id: toUuid(d.account, "acct"),
      livemode: true,
    });
  });
});

describe("post-screening after settlement (LLD §6, §12)", () => {
  it("a listed refund address opens a post_screen_hit review and publishes review.opened", async () => {
    const x = execution({ livemode: true, state: "succeeded", origin: { refund_to: LISTED_EVM, chain: BASE } });
    const e = domainEvent("evt.rails.execution.settled", x, {
      livemode: true,
      accountUuid: toUuid(x.account_id, "acct"),
    });
    await s.publishEvent(e);
    await publish(s.bus as never, e.subject, e, `${e.id}-again`);
    const opened = await probe.next(
      "evt.compliance.review.opened",
      (ev) => (ev.data.object as { subject: { id: string } }).subject.id === x.id,
    );
    expect(opened.data.object).toMatchObject({
      object: "review",
      subject: { type: "execution", id: x.id },
      reason: "post_screen_hit",
      status: "open",
    });
    expect(opened.livemode).toBe(true);
    expect(opened.account_id).toBe(toUuid(x.account_id, "acct"));
    const cases = await casesFor(x.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      kind: "post_screen_hit",
      severity: "high",
      status: "open",
      account_id: x.account_id,
    });
    expect(cases[0]?.events[0]?.note).toBe(`post-screening block: ${LISTED_EVM}`);
  });

  it("a clean refund address opens nothing", async () => {
    const x = execution({ livemode: true, state: "succeeded", origin: { refund_to: CLEAN_EVM, chain: BASE } });
    const e = domainEvent("evt.rails.execution.settled", x, { livemode: true });
    await s.publishEvent(e);
    await eventually(
      async () =>
        (await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", e.id).execute()).length === 1,
    );
    expect(await casesFor(x.id)).toEqual([]);
    const fresh = await s.admin.db
      .selectFrom("screenings")
      .selectAll()
      .where("subject_norm", "=", CLEAN_EVM)
      .where("context", "=", "payment")
      .execute();
    expect(fresh.length).toBeGreaterThanOrEqual(1);
  });

  it("an Intents refund account is screened as a NEAR account (eth-implicit matches EVM listings)", async () => {
    const x = execution({
      livemode: true,
      state: "succeeded",
      origin: { refund_to: LISTED_EVM, refund_type: "intents", chain: "near:mainnet" },
    });
    await s.publishEvent(domainEvent("evt.rails.execution.settled", x, { livemode: true }));
    await eventually(async () => (await casesFor(x.id)).length === 1);
  });

  it("an agent payment's listed payer opens a review on the agent payment", async () => {
    const p = agentPayment({ livemode: true, payer: LISTED_EVM });
    const acct = uuidv7();
    await s.publishEvent(domainEvent("evt.agentpay.agent_payment.settled", p, { livemode: true, accountUuid: acct }));
    const opened = await probe.next(
      "evt.compliance.review.opened",
      (ev) => (ev.data.object as { subject: { id: string } }).subject.id === p.id,
    );
    expect(opened.data.object).toMatchObject({
      subject: { type: "agent_payment", id: p.id },
      reason: "post_screen_hit",
    });
    expect((await casesFor(p.id))[0]).toMatchObject({ account_id: fromUuid("acct", acct) });
  });

  it("test-mode payments are screened with the magic rules only", async () => {
    const p = agentPayment({ livemode: false, payer: LISTED_EVM });
    const e = domainEvent("evt.agentpay.agent_payment.settled", p, { livemode: false });
    await s.publishEvent(e);
    await eventually(
      async () =>
        (await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", e.id).execute()).length === 1,
    );
    expect(await casesFor(p.id)).toEqual([]);
    const magic = agentPayment({ livemode: false, payer: "sanctioned.testnet" });
    await s.publishEvent(domainEvent("evt.agentpay.agent_payment.settled", magic, { livemode: false }));
    await eventually(async () => (await casesFor(magic.id)).length === 1);
    expect((await casesFor(magic.id))[0]).toMatchObject({ severity: "low", livemode: false });
  });
});

describe("holds and audit findings", () => {
  it("a review of an execution carries its payment intent (Execution.reference, Stage 2)", async () => {
    const pi = newId("pi");
    const x = execution({
      livemode: true,
      state: "held",
      held_reason: "evidence_timeout",
      reference: { payment_intent: pi, payment_attempt: null, refund: null, refund_leg: null },
    } as never);
    await s.publishEvent(domainEvent("evt.rails.execution.held", x, { livemode: true }));
    const opened = await probe.next(
      "evt.compliance.review.opened",
      (ev) => (ev.data.object as { subject: { id: string } }).subject.id === x.id,
    );
    expect(opened.data.object).toMatchObject({ reason: "held_execution", payment_intent: pi });
  });

  it("a held execution opens a held_execution review", async () => {
    const x = execution({ livemode: true, state: "held", held_reason: "evidence_timeout" });
    await s.publishEvent(domainEvent("evt.rails.execution.held", x, { livemode: true }));
    const opened = await probe.next(
      "evt.compliance.review.opened",
      (ev) => (ev.data.object as { subject: { id: string } }).subject.id === x.id,
    );
    expect(opened.data.object).toMatchObject({ reason: "held_execution" });
    expect((await casesFor(x.id))[0]).toMatchObject({ kind: "held_execution", severity: "high" });
    expect((await casesFor(x.id))[0]?.events[0]?.note).toBe("execution held: evidence_timeout");
  });

  it("a live audit mismatch is a critical case; a pass opens nothing", async () => {
    const finding = (result: string) => ({
      id: newId("fnd"),
      execution_id: newId("ex"),
      account_id: newId("acct"),
      livemode: true,
      check_kind: "settlement_transfer",
      result,
      details: {},
    });
    const bad = finding("mismatch");
    const ok = finding("pass");
    const okEvent = domainEvent("evt.sentinel.audit_finding.created", ok, { livemode: true });
    await s.publishEvent(okEvent);
    await s.publishEvent(domainEvent("evt.sentinel.audit_finding.created", bad, { livemode: true }));
    await eventually(async () => (await casesFor(bad.execution_id)).length === 1);
    expect((await casesFor(bad.execution_id))[0]).toMatchObject({ kind: "audit_mismatch", severity: "critical" });
    await eventually(
      async () =>
        (await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", okEvent.id).execute())
          .length === 1,
    );
    expect(await casesFor(ok.execution_id)).toEqual([]);
  });

  it("closing a review publishes review.closed", async () => {
    const x = execution({ livemode: true, state: "held", held_reason: "unknown_status" });
    await s.publishEvent(domainEvent("evt.rails.execution.held", x, { livemode: true }));
    const [c] = await eventually(async () => {
      const cs = await casesFor(x.id);
      return cs.length ? cs : null;
    });
    await updateCase(s.compliance, c?.id as string, "investigating", "ops:test");
    await updateCase(s.compliance, c?.id as string, "closed", "ops:test", "provider confirmed the refund");
    const closed = await probe.next(
      "evt.compliance.review.closed",
      (ev) => (ev.data.object as { subject: { id: string } }).subject.id === x.id,
    );
    expect(closed.data.object).toMatchObject({ status: "closed", reason: "held_execution" });
    // a new hold on the same execution after closing opens a new case
    await s.publishEvent(domainEvent("evt.rails.execution.held", x, { livemode: true, version: 9 }));
    await eventually(async () => (await casesFor(x.id)).length === 2);
  });
});

describe("events compliance produces reach the bus (outbox relay)", () => {
  it("kyb.<decision>, account.suspended/reinstated and policy.updated", async () => {
    const a = account();
    await s.publishEvent(domainEvent("evt.identity.account.created", a, { accountUuid: toUuid(a.id, "acct") }));
    await eventually(() =>
      s.admin.db.selectFrom("kyb_cases").select("id").where("account_id", "=", toUuid(a.id, "acct")).executeTakeFirst(),
    );
    await decideKyb(s.compliance, a.id, "needs_info", "upload the registry extract", "ops:test");
    const kyb = await probe.next("evt.compliance.kyb.needs_info", (e) => e.aggregate.id === a.id);
    expect(kyb.data.object).toMatchObject({
      account_id: a.id,
      status: "needs_info",
      reason: "upload the registry extract",
    });

    expect(await setAccountSuspended(s.compliance, a.id, true, "fraud report", "ops:test")).toEqual({ changed: true });
    expect(await setAccountSuspended(s.compliance, a.id, true, "again", "ops:test")).toEqual({ changed: false });
    await probe.next("evt.compliance.account.suspended", (e) => e.aggregate.id === a.id);
    await setAccountSuspended(s.compliance, a.id, false, "cleared", "ops:test");
    const back = await probe.next("evt.compliance.account.reinstated", (e) => e.aggregate.id === a.id);
    expect(back.aggregate.version).toBe(2);

    await setGeoPolicy(
      s.compliance,
      { blockedCountries: ["CU", "IR", "KP", "SY", "RU"], blockedRegions: ["UA-43"] },
      "ops:test",
    );
    const pol = await probe.next("evt.compliance.policy.updated");
    expect(pol.aggregate.id).toMatch(/^pol_/);
    expect(pol.data.object).toEqual({
      version: "2",
      blocked_countries: ["CU", "IR", "KP", "RU", "SY"],
      blocked_regions: ["UA-43"],
    });
  });
});

describe("Stage 2 events reach the bus", () => {
  it("kyb.submitted, account.action_requested and ops_action.recorded (ids only)", async () => {
    const acct = newId("acct");
    const owner = newId("usr");
    await updateKybProfile(
      s.compliance,
      acct,
      {
        legal_name: "Bus Test Ltd",
        country_of_incorporation: "DE",
        registration_number: "HRB 1",
        business_type: "company",
        business_address: { line1: "Hauptstr. 1", city: "Berlin", country: "DE" },
        representative: { name: "Max Muster", title: "Geschäftsführer" },
        expected_monthly_volume: "10k_to_100k",
      },
      `user:${owner}`,
    );
    await submitKyb(s.compliance, acct, owner);
    const sub = await probe.next("evt.compliance.kyb.submitted", (e) => e.aggregate.id === acct);
    expect(sub.data.object).toMatchObject({ account_id: acct, status: "pending" });
    expect(JSON.stringify(sub)).not.toContain("Bus Test");

    const op = { sub: newId("usr"), role: "ops" as const };
    const req = await createSuspensionRequest(s.compliance, op, acct, "suspend", "chargeback ring");
    const requested = await probe.next("evt.compliance.account.action_requested", (e) => e.aggregate.id === req.id);
    expect(requested.data.object).toMatchObject({ id: req.id, status: "pending", action: "account.suspend" });
    const action = await probe.next(
      "evt.compliance.ops_action.recorded",
      (e) => (e.data.object as { approval: string | null }).approval === req.id,
    );
    expect(action.data.object).toMatchObject({
      actor: { sub: op.sub, ops_role: "ops" },
      action: "ops_approval.requested",
      target: { type: "ops_approval", id: req.id },
      account_id: acct,
    });
    expect(action.aggregate.type).toBe("ops_action");
    expect(JSON.stringify(action)).not.toContain("chargeback");
  });
});

describe("blocking destinations", () => {
  const monitor = async (address: string, livemode = true) => {
    const d = internalSettlementDestination({
      livemode,
      chain: BASE,
      address,
      address_norm: address,
      asset_id: USDC_BASE,
      type: "chain_address",
    });
    await s.publishEvent(domainEvent("evt.identity.settlement_destination.activated", d, { version: 1, livemode }));
    await eventually(() =>
      s.admin.db
        .selectFrom("monitored_destinations")
        .select("destination_id")
        .where("destination_id", "=", toUuid(d.id, "sd"))
        .executeTakeFirst(),
    );
    return d;
  };

  it("a blocklist entry blocks matching live destinations at once (destination.blocked + case)", async () => {
    const addr = "0x4444444444444444444444444444444444444444";
    const live = await monitor(addr);
    const test = await monitor(addr, false);
    const r = await addToBlocklist(s.compliance, {
      subjectType: "address",
      subject: addr,
      chain: BASE,
      reason: "court order",
      actor: "ops:test",
    });
    expect(r).toEqual({ subject: addr, destinationsBlocked: 1 });
    const blocked = await probe.next("evt.compliance.destination.blocked", (e) => e.aggregate.id === live.id);
    expect(blocked.data.object).toEqual({
      destination_id: live.id,
      account_id: live.account,
      reason: "blocklist: court order",
    });
    expect((await casesFor(live.id))[0]).toMatchObject({ kind: "screening_hit", severity: "high" });
    expect(await casesFor(test.id)).toEqual([]);
  });

  it("the daily re-screen blocks a destination whose address became listed", async () => {
    const addr = "0x5555555555555555555555555555555555555555";
    const d = await monitor(addr);
    await s.admin.db
      .insertInto("sanctions_entries")
      .values({ chain_family: "evm", address_norm: addr, source: "ofac_sdn", currency: "ETH" })
      .execute();
    const r = await rescreenDestinations(s.compliance);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    await probe.next("evt.compliance.destination.blocked", (e) => e.aggregate.id === d.id);
    const row = await s.admin.db
      .selectFrom("monitored_destinations")
      .selectAll()
      .where("destination_id", "=", toUuid(d.id, "sd"))
      .executeTakeFirstOrThrow();
    expect(row.active).toBe(false);
    expect(row.last_screened_at).not.toBeNull();
    // a second run in the same pass screens nothing new and blocks nothing twice
    const again = await rescreenDestinations(s.compliance);
    expect(again.blocked).toBe(0);
    expect(await casesFor(d.id)).toHaveLength(1);
  });

  it("a console re-screen job runs for one account only", async () => {
    const addr = "0x6767676767676767676767676767676767676767";
    const mine = await monitor(addr);
    await s.admin.db
      .insertInto("sanctions_entries")
      .values({ chain_family: "evm", address_norm: addr, source: "ofac_sdn", currency: "ETH" })
      .execute();
    const op = { sub: newId("usr"), role: "ops" as const };
    const other = await createOpsRescreen(s.compliance, op, newId("acct"));
    expect(other.destinations).toBe(0);
    const r = await createOpsRescreen(s.compliance, op, mine.account);
    expect(r.destinations).toBe(1);
    await probe.next("evt.compliance.destination.blocked", (e) => e.aggregate.id === mine.id);
    await eventually(async () => {
      const j = await s.admin.db
        .selectFrom("jobs")
        .select("done_at")
        .where("id", "=", toUuid(r.job_id, "job"))
        .executeTakeFirstOrThrow();
      return j.done_at !== null;
    });
  });
});

describe("recurring jobs", () => {
  it("are scheduled once per slot and run by the job worker", async () => {
    const rows = await eventually(async () => {
      const r = await s.admin.db.selectFrom("jobs").select(["kind", "dedupe_key", "done_at"]).execute();
      const kinds = new Set(r.filter((j) => j.done_at).map((j) => j.kind));
      return [
        "sanctions.refresh",
        "destinations.rescreen",
        "purge.screenings",
        "ops_approvals.expire",
        "kit.purge",
      ].every((k) => kinds.has(k))
        ? r
        : null;
    }, 20_000);
    // console re-screens (`createOpsRescreen`) are extra jobs with their own dedupe keys
    for (const k of ["sanctions.refresh", "destinations.rescreen", "purge.screenings", "ops_approvals.expire"])
      expect(rows.filter((j) => j.kind === k && !j.dedupe_key?.includes(":ops:"))).toHaveLength(1);
  });

  it("purge.screenings deletes screenings past the policy retention", async () => {
    const old = uuidv7();
    await sql`insert into screenings (id, subject_type, chain, subject_norm, context, livemode, decision, reasons, provider, expires_at, created_at)
      values (${old}, 'address', ${BASE}, '0xold', 'payment', true, 'allow', '{}', 'local_list', now(), now() - interval '6 years')`.execute(
      s.admin.db,
    );
    const { jobHandlers } = await import("../../src/workers/jobs.js");
    const ctx = { id: "j", kind: "purge.screenings", attempt: 1, extendLease: async () => {} };
    await jobHandlers(s.compliance, { sanctionsRefresh: false, sanctionsSourceUrl: "", sanctionsTimeoutMs: 1_000 })[
      "purge.screenings"
    ]?.(null, ctx);
    expect(
      await s.admin.db.selectFrom("screenings").select("id").where("id", "=", old).executeTakeFirst(),
    ).toBeUndefined();
    expect((await s.admin.db.selectFrom("screenings").select("id").execute()).length).toBeGreaterThan(0);
  });
});

describe("metrics", () => {
  it("the worker exports the list age and open cases", async () => {
    const text = await (await fetch(`http://127.0.0.1:${s.worker?.metricsPort}/metrics`)).text();
    const age = /^nearpay_compliance_sanctions_list_age_hours (\S+)$/m.exec(text)?.[1];
    expect(Number(age)).toBeGreaterThanOrEqual(0);
    expect(Number(age)).toBeLessThan(1);
    expect(text).toMatch(/nearpay_compliance_cases_open\{kind="audit_mismatch",severity="critical"\} 1/);
    expect(text).toMatch(/nearpay_compliance_consumer_lag/);
  });
});
