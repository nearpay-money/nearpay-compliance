/**
 * Stage 2 routes over HTTP (LLD §5, §5.1): the self-declared KYB profile (dashboard), the identity read,
 * payments' reconciliation cases, open onboarding (NP_KYB_MODE=auto, ADR-0024) and every console route —
 * Businesses list and decisions (manual mode and abuse), cases, blocklist,
 * screening and re-screening, merchant suspension with the two-person rule — with their operator actions.
 */
import { sql, withTx } from "@nearpay-internal/db";
import { fromUuid, newId, toUuid } from "@nearpay-internal/ids";
import { getInternalOpsOperator } from "@nearpay-internal/spec";
import { mockError } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rememberAccountName } from "../../src/app/account-names.js";
import { openCase } from "../../src/app/cases.js";
import { autoDecidePending, createKybCase } from "../../src/app/kyb.js";
import { expireApprovals } from "../../src/app/suspension.js";
import {
  consoleToken,
  LISTED_EVM,
  mintServiceToken,
  newOperator,
  OWNER,
  outboxOf,
  type Stack,
  sessionToken,
  startStack,
} from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  await s.importSample();
});
afterAll(async () => {
  await s?.stop();
});

async function req(
  method: "GET" | "POST" | "PATCH",
  url: string,
  o: { body?: unknown; token: string; key?: string },
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  const r = await s.api.app.inject({
    method,
    url,
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
    headers: { "x-nearpay-token": o.token, ...(o.key ? { "idempotency-key": o.key } : {}) },
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: r.headers };
}

const alice = newOperator("ops");
const bob = newOperator("ops_admin");
const carol = newOperator("ops_admin");

const COMPLETE = {
  legal_name: "Acme Trading Ltd",
  country_of_incorporation: "GB",
  registration_number: "01234567",
  business_type: "company",
  website: "https://acme.example",
  business_address: { line1: "1 High Street", city: "London", postal_code: "N1 1AA", country: "GB" },
  representative: { name: "Jane Doe", title: "Director" },
  expected_monthly_volume: "under_10k",
};

const opsActions = async (targetId: string) =>
  (await outboxOf(s, "evt.compliance.ops_action.recorded")).filter(
    (e) => (e.data.object.target as { id: string }).id === targetId,
  );

async function submittedAccount(): Promise<string> {
  const acct = newId("acct");
  await withTx(s.admin.db, (tx) => createKybCase(tx, acct, "Acme"));
  expect((await req("PATCH", "/v1/account/kyb", { body: COMPLETE, token: await sessionToken(acct) })).status).toBe(200);
  const sub = await req("POST", "/v1/account/kyb/submit", {
    body: { declaration: true },
    token: await sessionToken(acct, "owner", { stepUp: true }),
  });
  expect(sub.status).toBe(200);
  return acct;
}

// =============================================================================================
// KYB — owner
// =============================================================================================

describe("KYB profile (dashboard)", () => {
  it("reads an account without a case as not_started with an empty profile", async () => {
    const r = await req("GET", "/v1/account/kyb", { token: await sessionToken(newId("acct"), "admin") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "kyb_case",
      status: "not_started",
      vendor_flow_url: null,
      editable: true,
      requested_info: null,
      submitted_at: null,
      profile: { legal_name: null, business_address: null },
    });
  });

  it("stores partial updates encrypted and audits field names only", async () => {
    const acct = newId("acct");
    const token = await sessionToken(acct);
    const r = await req("PATCH", "/v1/account/kyb", { body: { legal_name: "Jane Doe Trading" }, token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "not_started", profile: { legal_name: "Jane Doe Trading", website: null } });
    const r2 = await req("PATCH", "/v1/account/kyb", {
      body: { website: "https://jd.example", legal_name: null },
      token,
    });
    expect(r2.body).toMatchObject({ profile: { legal_name: null, website: "https://jd.example" } });
    const row = await s.admin.db
      .selectFrom("kyb_cases")
      .selectAll()
      .where("account_id", "=", toUuid(acct, "acct"))
      .executeTakeFirstOrThrow();
    expect(row.profile_enc?.includes(Buffer.from("jd.example"))).toBe(false);
    const t = await s.admin.db
      .selectFrom("kyb_case_transitions")
      .select(["cause", "evidence", "actor"])
      .where("kyb_case_id", "=", row.id)
      .orderBy("created_at")
      .execute();
    expect(t).toEqual([
      { cause: "profile_updated", evidence: { fields: ["legal_name"] }, actor: `user:${OWNER}` },
      { cause: "profile_updated", evidence: { fields: ["legal_name", "website"] }, actor: `user:${OWNER}` },
    ]);
    expect(JSON.stringify(t)).not.toContain("Jane");
  });

  it("only the owner edits and submits; admins read", async () => {
    const acct = newId("acct");
    expect((await req("PATCH", "/v1/account/kyb", { body: {}, token: await sessionToken(acct, "admin") })).status).toBe(
      403,
    );
    expect((await req("GET", "/v1/account/kyb", { token: await sessionToken(acct, "developer") })).status).toBe(403);
    expect(
      (
        await req("POST", "/v1/account/kyb/submit", {
          body: { declaration: true },
          token: await sessionToken(acct, "admin", { stepUp: true }),
        })
      ).status,
    ).toBe(403);
  });

  it("submission needs step-up, the declaration and every required field; auto mode approves it at once", async () => {
    const acct = newId("acct");
    const token = await sessionToken(acct, "owner", { stepUp: true });
    expect(
      (await req("POST", "/v1/account/kyb/submit", { body: { declaration: true }, token: await sessionToken(acct) }))
        .status,
    ).toBe(401);
    expect((await req("POST", "/v1/account/kyb/submit", { body: { declaration: false }, token })).status).toBe(400);
    await req("PATCH", "/v1/account/kyb", { body: { legal_name: "Acme", website: "https://a.example" }, token });
    const incomplete = await req("POST", "/v1/account/kyb/submit", { body: { declaration: true }, token });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body).toMatchObject({ error: { code: "kyb_profile_incomplete" } });
    expect((incomplete.body.error as { message: string }).message).toContain("country_of_incorporation");
    expect((incomplete.body.error as { message: string }).message).not.toContain("website");
    expect((incomplete.body.error as { message: string }).message).not.toContain("registration_number");

    await req("PATCH", "/v1/account/kyb", { body: COMPLETE, token });
    const ok = await req("POST", "/v1/account/kyb/submit", { body: { declaration: true }, token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "approved", editable: false });
    expect(typeof ok.body.submitted_at).toBe("number");
    expect(typeof ok.body.decided_at).toBe("number");
    const ev = (await outboxOf(s, "evt.compliance.kyb.submitted")).filter((e) => e.aggregate.id === acct);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.data.object).toMatchObject({ account_id: acct, status: "pending" });
    expect(JSON.stringify(ev[0])).not.toContain("Acme Trading");
    const approved = (await outboxOf(s, "evt.compliance.kyb.approved")).filter((e) => e.aggregate.id === acct);
    expect(approved).toHaveLength(1);
    expect(approved[0]?.aggregate.version).toBeGreaterThan(ev[0]?.aggregate.version ?? Infinity);

    expect((await req("POST", "/v1/account/kyb/submit", { body: { declaration: true }, token })).status).toBe(409);
    expect((await req("PATCH", "/v1/account/kyb", { body: { legal_name: "X" }, token })).status).toBe(409);
    const row = await s.admin.db
      .selectFrom("kyb_cases")
      .select(["declared_by"])
      .where("account_id", "=", toUuid(acct, "acct"))
      .executeTakeFirstOrThrow();
    expect(row.declared_by).toBe(toUuid(OWNER, "usr"));
  });

  it("identity reads the declared details (compliance.read); others are refused", async () => {
    const acct = await submittedAccount();
    const r = await req("GET", `/internal/kyb_cases/${acct}`, { token: await mintServiceToken("identity") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      account_id: acct,
      status: "approved",
      profile: { legal_name: "Acme Trading Ltd", country_of_incorporation: "GB" },
    });
    expect(typeof r.body.decided_at).toBe("string");
    expect((await req("GET", `/internal/kyb_cases/${acct}`, { token: await mintServiceToken("notify") })).status).toBe(
      403,
    );
    expect(
      (await req("GET", `/internal/kyb_cases/${newId("acct")}`, { token: await mintServiceToken("identity") })).status,
    ).toBe(404);
  });
});

// =============================================================================================
// KYB — console
// =============================================================================================

describe("open onboarding (NP_KYB_MODE=auto, ADR-0024)", () => {
  const transitions = async (acct: string) =>
    s.admin.db
      .selectFrom("kyb_case_transitions as t")
      .innerJoin("kyb_cases as k", "k.id", "t.kyb_case_id")
      .select(["t.from_state", "t.to_state", "t.cause", "t.actor", "t.evidence"])
      .where("k.account_id", "=", toUuid(acct, "acct"))
      .orderBy("t.created_at")
      .orderBy("t.id")
      .execute();

  it("activates a complete business without a register number: decided by the system, fully audited", async () => {
    const acct = newId("acct");
    await withTx(s.admin.db, (tx) => createKybCase(tx, acct, "No Register"));
    const { registration_number: _, ...noRegister } = COMPLETE;
    const token = await sessionToken(acct, "owner", { stepUp: true });
    expect((await req("PATCH", "/v1/account/kyb", { body: noRegister, token })).status).toBe(200);
    const r = await req("POST", "/v1/account/kyb/submit", { body: { declaration: true }, token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "approved", profile: { registration_number: null } });

    expect((await transitions(acct)).slice(-2)).toEqual([
      {
        from_state: "not_started",
        to_state: "pending",
        cause: "owner_submitted",
        actor: `user:${OWNER}`,
        evidence: { declaration: true },
      },
      {
        from_state: "pending",
        to_state: "approved",
        cause: "auto_decision",
        actor: "system",
        evidence: { reason: "auto-approved: open onboarding (ADR-0024)" },
      },
    ]);
    const ops = await req("GET", `/ops/kyb_cases/${acct}`, { token: await consoleToken(alice, { stepUp: false }) });
    expect(ops.body).toMatchObject({
      status: "approved",
      decided_by: "system",
      declared_by: OWNER,
      decision_reason: "auto-approved: open onboarding (ADR-0024)",
      profile: { registration_number: null },
    });
    expect((ops.body.history as { status: string; actor: string }[]).slice(-1)[0]).toMatchObject({
      status: "approved",
      actor: "system",
    });
    const ev = (await outboxOf(s, "evt.compliance.kyb.approved")).filter((e) => e.aggregate.id === acct);
    expect(ev[0]?.data.object).toMatchObject({
      account_id: acct,
      status: "approved",
      reason: "auto-approved: open onboarding (ADR-0024)",
    });
    // an automatic decision is not an operator action
    expect(await opsActions(acct)).toHaveLength(0);
  });

  it("a business in a blocked country is rejected automatically (geo_blocked); live mode never turns on", async () => {
    for (const [over, reason] of [
      [{ country_of_incorporation: "IR" }, "auto-rejected: geo_blocked (country of incorporation IR)"],
      [
        { business_address: { line1: "1 Main", city: "Pyongyang", country: "KP" } },
        "auto-rejected: geo_blocked (business address country KP)",
      ],
      [
        { business_address: { line1: "1 Main", city: "Simferopol", region: "UA-43", country: "UA" } },
        "auto-rejected: geo_blocked (business address region UA-43)",
      ],
    ] as const) {
      const acct = newId("acct");
      const token = await sessionToken(acct, "owner", { stepUp: true });
      await req("PATCH", "/v1/account/kyb", { body: { ...COMPLETE, ...over }, token });
      const r = await req("POST", "/v1/account/kyb/submit", { body: { declaration: true }, token });
      expect(r.body).toMatchObject({ status: "rejected", editable: false });
      expect(JSON.stringify(r.body)).not.toContain("geo_blocked"); // internal reason stays off the owner view
      const ev = (await outboxOf(s, "evt.compliance.kyb.rejected")).filter((e) => e.aggregate.id === acct);
      expect(ev).toHaveLength(1);
      expect(ev[0]?.data.object).toMatchObject({ status: "rejected", reason });
      expect((await outboxOf(s, "evt.compliance.kyb.approved")).filter((e) => e.aggregate.id === acct)).toHaveLength(0);
      expect((await transitions(acct)).at(-1)).toMatchObject({ to_state: "rejected", actor: "system" });
    }
  });

  it("operators can still reject an active business for abuse and reverse it", async () => {
    const acct = await submittedAccount();
    const token = await consoleToken(bob);
    const decide = (body: Record<string, unknown>) => req("POST", `/ops/kyb_cases/${acct}/decision`, { body, token });
    expect((await decide({ decision: "rejected", reason: "fraud reports" })).body).toMatchObject({
      status: "rejected",
      decided_by: bob.sub,
    });
    expect((await outboxOf(s, "evt.compliance.kyb.rejected")).filter((e) => e.aggregate.id === acct)).toHaveLength(1);
    expect((await opsActions(acct)).map((a) => a.data.object.action)).toEqual(["kyb_case.rejected"]);
    expect((await decide({ decision: "approved", reason: "reports withdrawn" })).body).toMatchObject({
      status: "approved",
    });
  });

  it("manual mode keeps the review; switching back to auto decides what is pending", async () => {
    s.setKybMode("manual");
    try {
      const acct = await submittedAccount();
      expect((await req("GET", "/v1/account/kyb", { token: await sessionToken(acct) })).body).toMatchObject({
        status: "pending",
      });
      expect(await autoDecidePending(s.compliance)).toEqual({ decided: 0 });
      s.setKybMode("auto");
      const r = await autoDecidePending(s.compliance);
      expect(r.decided).toBeGreaterThanOrEqual(1);
      expect((await req("GET", "/v1/account/kyb", { token: await sessionToken(acct) })).body).toMatchObject({
        status: "approved",
      });
      expect((await transitions(acct)).at(-1)).toMatchObject({ cause: "auto_decision", actor: "system" });
    } finally {
      s.setKybMode("auto");
    }
  });
});

describe("Businesses list and decisions in manual mode (console)", () => {
  beforeAll(() => s.setKybMode("manual"));
  afterAll(() => s.setKybMode("auto"));

  it("lists pending cases oldest submission first, with cursors", async () => {
    const a = await submittedAccount();
    const b = await submittedAccount();
    const token = await consoleToken(alice, { stepUp: false });
    const all = await req("GET", "/ops/kyb_cases?limit=100", { token });
    expect(all.status).toBe(200);
    const ids = (all.body.data as { account_id: string }[]).map((x) => x.account_id);
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect((all.body.data as { status: string }[]).every((x) => x.status === "pending")).toBe(true);
    const page = await req("GET", `/ops/kyb_cases?limit=1&starting_after=${a}`, { token });
    expect((page.body.data as { account_id: string }[])[0]?.account_id).toBe(ids[ids.indexOf(a) + 1]);
    const back = await req("GET", `/ops/kyb_cases?limit=1&ending_before=${b}`, { token });
    expect((back.body.data as { account_id: string }[])[0]?.account_id).toBe(ids[ids.indexOf(b) - 1]);
    const one = await req("GET", `/ops/kyb_cases?account=${a}`, { token });
    expect(one.body.data).toHaveLength(1);
    expect((one.body.data as Record<string, unknown>[])[0]).toMatchObject({
      account_display_name: "Acme",
      declared_by: OWNER,
      profile: { legal_name: "Acme Trading Ltd" },
    });
    expect((await req("GET", "/ops/kyb_cases", { token: await mintServiceToken("identity") })).status).toBe(403);
  });

  it("approves only from pending, with step-up, audited with ids only", async () => {
    const acct = await submittedAccount();
    const body = { decision: "approved", reason: "registry extract checked" };
    expect(
      (
        await req("POST", `/ops/kyb_cases/${acct}/decision`, {
          body,
          token: await consoleToken(alice, { stepUp: false }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await req("POST", `/ops/kyb_cases/${acct}/decision`, { body, token: await consoleToken(alice, { role: null }) }))
        .status,
    ).toBe(403);
    const token = await consoleToken(alice);
    const r = await req("POST", `/ops/kyb_cases/${acct}/decision`, { body, token, key: `kyb-${acct}` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "ops_kyb_case",
      status: "approved",
      decided_by: alice.sub,
      decision_reason: "registry extract checked",
    });
    expect((r.body.history as { status: string }[]).map((h) => h.status)).toEqual([
      "not_started",
      "pending",
      "approved",
    ]);
    const replay = await req("POST", `/ops/kyb_cases/${acct}/decision`, { body, token, key: `kyb-${acct}` });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(r.body);
    expect((await req("POST", `/ops/kyb_cases/${acct}/decision`, { body, token })).status).toBe(200); // repeat: no-op
    expect((await outboxOf(s, "evt.compliance.kyb.approved")).filter((e) => e.aggregate.id === acct)).toHaveLength(1);
    const actions = await opsActions(acct);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.data.object).toMatchObject({
      actor: { sub: alice.sub, ops_role: "ops" },
      action: "kyb_case.approved",
      target: { type: "kyb_case", id: acct },
      account_id: acct,
      approval: null,
    });
    expect(JSON.stringify(actions[0])).not.toContain("registry extract");
  });

  it("needs_info carries requested_info to the merchant; a rejection can be reversed", async () => {
    const acct = await submittedAccount();
    const token = await consoleToken(bob);
    const decide = (body: Record<string, unknown>) => req("POST", `/ops/kyb_cases/${acct}/decision`, { body, token });
    expect((await decide({ decision: "needs_info", reason: "unclear" })).status).toBe(400);
    const ni = await decide({ decision: "needs_info", reason: "unclear", requested_info: "Add your VAT number" });
    expect(ni.body).toMatchObject({ status: "needs_info", requested_info: "Add your VAT number" });
    const ev = (await outboxOf(s, "evt.compliance.kyb.needs_info")).filter((e) => e.aggregate.id === acct);
    expect(ev[0]?.data.object).toMatchObject({ requested_info: "Add your VAT number" });
    const owner = await req("GET", "/v1/account/kyb", { token: await sessionToken(acct) });
    expect(owner.body).toMatchObject({ status: "needs_info", editable: true, requested_info: "Add your VAT number" });
    expect(JSON.stringify(owner.body)).not.toContain("unclear");
    expect((await decide({ decision: "approved", reason: "x" })).status).toBe(409);
    expect((await decide({ decision: "rejected", reason: "x" })).status).toBe(409);
    // the merchant resubmits from needs_info
    const sub = await req("POST", "/v1/account/kyb/submit", {
      body: { declaration: true },
      token: await sessionToken(acct, "owner", { stepUp: true }),
    });
    expect(sub.body).toMatchObject({ status: "pending", requested_info: null });
    expect((await decide({ decision: "rejected", reason: "fake registry" })).body).toMatchObject({
      status: "rejected",
    });
    expect((await decide({ decision: "approved", reason: "registry extract checked" })).body).toMatchObject({
      status: "approved",
    });
  });

  it("refuses to approve a Stage 1 pending case without declared details", async () => {
    const acct = newId("acct");
    await withTx(s.admin.db, (tx) => createKybCase(tx, acct));
    await s.admin.db
      .updateTable("kyb_cases")
      .set({ status: "pending" })
      .where("account_id", "=", toUuid(acct, "acct"))
      .execute();
    const r = await req("POST", `/ops/kyb_cases/${acct}/decision`, {
      body: { decision: "approved", reason: "x" },
      token: await consoleToken(alice),
    });
    expect(r.status).toBe(409);
    expect((await req("GET", `/ops/kyb_cases/${newId("acct")}`, { token: await consoleToken(alice) })).status).toBe(
      404,
    );
  });
});

// =============================================================================================
// Cases
// =============================================================================================

describe("cases (console) and createInternalCase", () => {
  async function held(livemode = true) {
    const acct = newId("acct");
    const ex = newId("ex");
    const pi = newId("pi");
    const { id } = await withTx(s.admin.db, (tx) =>
      openCase(s.compliance, tx, {
        kind: "held_execution",
        subject: { type: "execution", id: ex },
        accountId: acct,
        livemode,
        actor: "compliance",
        note: "execution held: evidence_timeout",
        paymentIntent: pi,
      }),
    );
    return { id: fromUuid("case", id), acct, ex, pi };
  }

  it("lists open cases by severity, then oldest; filters and pages", async () => {
    const test1 = await held(false);
    const live1 = await held(true);
    const live2 = await held(true);
    const token = await consoleToken(alice, { stepUp: false });
    const r = await req("GET", "/ops/cases?limit=100", { token });
    const ids = (r.body.data as { id: string; severity: string }[]).map((x) => x.id);
    expect(ids.indexOf(live1.id)).toBeLessThan(ids.indexOf(live2.id));
    expect(ids.indexOf(live2.id)).toBeLessThan(ids.indexOf(test1.id));
    const ranks = (r.body.data as { severity: string }[]).map((x) =>
      ["low", "medium", "high", "critical"].indexOf(x.severity),
    );
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    const next = await req("GET", `/ops/cases?limit=1&starting_after=${live1.id}`, { token });
    expect((next.body.data as { id: string }[])[0]?.id).toBe(ids[ids.indexOf(live1.id) + 1]);
    const prev = await req("GET", `/ops/cases?limit=1&ending_before=${live2.id}`, { token });
    expect((prev.body.data as { id: string }[])[0]?.id).toBe(ids[ids.indexOf(live2.id) - 1]);
    const filtered = await req("GET", `/ops/cases?account=${live1.acct}&livemode=true&kind=held_execution`, { token });
    expect((filtered.body.data as { id: string }[]).map((x) => x.id)).toEqual([live1.id]);
    expect((await req("GET", `/ops/cases?severity=low&livemode=false&limit=100`, { token })).body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: test1.id })]),
    );
  });

  it("spec 0.2.1: subject filter (exact subject.id) and account_display_name", async () => {
    const live = await held(true);
    const other = await held(true);
    await withTx(s.admin.db, (tx) => rememberAccountName(tx, live.acct, "Subject Shop", 4));
    const token = await consoleToken(alice, { stepUp: false });
    const r = await req("GET", `/ops/cases?subject=${live.ex}&status=open`, { token });
    expect(r.status).toBe(200);
    const data = r.body.data as Record<string, unknown>[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: live.id, account_display_name: "Subject Shop" });
    expect((await req("GET", `/ops/cases?subject=${live.ex.slice(0, -1)}`, { token })).body.data).toEqual([]);
    const one = await req("GET", `/ops/cases/${other.id}`, { token });
    expect(one.body.account_display_name).toBeNull(); // no account event seen yet
    expect((await req("GET", `/ops/cases/${live.id}`, { token })).body.account_display_name).toBe("Subject Shop");
    const idx = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where indexname = 'cases_subject_id'`.execute(s.admin.db);
    expect(idx.rows[0]?.indexdef).toContain("(subject ->> 'id'::text)");
  });

  it("spec 0.2.1: the assignee must be an active operator (identity); identity down fails closed", async () => {
    const c = await held();
    const token = await consoleToken(alice);
    const assign = (assignee: string) => req("POST", `/ops/cases/${c.id}/assign`, { body: { assignee }, token });
    const revoked = newId("usr");
    const unknown = newId("usr");
    s.identity.on(getInternalOpsOperator, async (ctx) => {
      if (ctx.params.id === unknown) mockError("resource_missing", { params: { object: "ops_operator", id: unknown } });
      return {
        user_id: ctx.params.id,
        role: "ops" as const,
        active: ctx.params.id !== revoked,
        created_at: new Date().toISOString(),
        revoked_at: ctx.params.id === revoked ? new Date().toISOString() : null,
      };
    });
    try {
      for (const u of [revoked, unknown]) {
        const r = await assign(u);
        expect(r.status).toBe(400);
        expect(r.body.error).toMatchObject({ code: "invalid_request", param: "assignee" });
      }
      // the call carried compliance's service token (scope identity.operators.read, checked by the mock)
      const call = s.identity.callsTo(getInternalOpsOperator).at(-1);
      expect(call?.principal?.sub).toBe("compliance");
      s.identity.on(getInternalOpsOperator, async () => mockError("api_error"));
      const down = await assign(bob.sub);
      expect(down.status).toBeGreaterThanOrEqual(500);
      expect(down.body.error).toMatchObject({ code: "api_error" });
      expect(down.headers["retry-after"]).toBe("5");
      const row = await s.admin.db
        .selectFrom("cases")
        .select(["assignee", "status"])
        .where("id", "=", toUuid(c.id, "case"))
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ assignee: null, status: "open" });
    } finally {
      s.identity.on(getInternalOpsOperator, async (ctx) => ({
        user_id: ctx.params.id,
        role: "ops" as const,
        active: true,
        created_at: new Date().toISOString(),
        revoked_at: null,
      }));
    }
  });

  it("assigns, comments and closes a review with a timeline, review.closed and operator actions", async () => {
    const c = await held();
    const token = await consoleToken(alice);
    const got = await req("GET", `/ops/cases/${c.id}`, { token });
    expect(got.body).toMatchObject({
      id: c.id,
      object: "compliance_case",
      kind: "held_execution",
      status: "open",
      review: true,
      assignee: null,
      events: [{ actor: "system", action: "opened", note: "execution held: evidence_timeout" }],
    });
    const assigned = await req("POST", `/ops/cases/${c.id}/assign`, { body: { assignee: bob.sub }, token });
    expect(assigned.body).toMatchObject({ status: "investigating", assignee: bob.sub });
    const unassigned = await req("POST", `/ops/cases/${c.id}/assign`, { body: { assignee: null }, token });
    expect(unassigned.body).toMatchObject({ status: "investigating", assignee: null });
    const commented = await req("POST", `/ops/cases/${c.id}/comments`, {
      body: { note: "called the merchant" },
      token,
    });
    expect((commented.body.events as { action: string; actor: string }[]).at(-1)).toMatchObject({
      action: "commented",
      actor: alice.sub,
    });
    const closed = await req("POST", `/ops/cases/${c.id}/close`, {
      body: { resolution: "merchant_contacted", note: "refund confirmed" },
      token,
    });
    expect(closed.body).toMatchObject({ status: "closed", resolution: "merchant_contacted" });
    expect((closed.body.events as { action: string }[]).map((e) => e.action)).toEqual([
      "opened",
      "assigned",
      "unassigned",
      "commented",
      "closed",
    ]);
    const reviewClosed = (await outboxOf(s, "evt.compliance.review.closed")).filter((e) => e.aggregate.id === c.id);
    expect(reviewClosed[0]?.data.object).toMatchObject({ id: c.id, status: "closed", payment_intent: c.pi });
    const opened = (await outboxOf(s, "evt.compliance.review.opened")).filter((e) => e.aggregate.id === c.id);
    expect(opened[0]?.data.object).toMatchObject({ payment_intent: c.pi });
    expect((await opsActions(c.id)).map((e) => e.data.object.action)).toEqual([
      "case.assigned",
      "case.unassigned",
      "case.commented",
      "case.closed",
    ]);
    expect(JSON.stringify(await opsActions(c.id))).not.toContain("refund confirmed");
    expect(
      (await req("POST", `/ops/cases/${c.id}/close`, { body: { resolution: "other", note: "x" }, token })).status,
    ).toBe(409);
    expect((await req("POST", `/ops/cases/${c.id}/assign`, { body: { assignee: bob.sub }, token })).status).toBe(409);
    expect((await req("POST", `/ops/cases/${c.id}/comments`, { body: { note: "late note" }, token })).status).toBe(200);
    expect((await req("GET", `/ops/cases/${newId("case")}`, { token })).status).toBe(404);
  });

  it("payments opens one reconciliation_diff case per run, never a review; keys replay", async () => {
    const acct = newId("acct");
    const run = newId("rcn");
    const body = {
      kind: "reconciliation_diff",
      account_id: acct,
      livemode: true,
      subject: { type: "reconciliation_run", id: run },
      note: "2 diffs: missing_evidence ×1, amount_mismatch ×1",
    };
    const token = await mintServiceToken("payments");
    const a = await req("POST", "/internal/cases", { body, token, key: `rcn:${run}` });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      object: "compliance_case",
      kind: "reconciliation_diff",
      severity: "high",
      review: false,
      status: "open",
      subject: { type: "reconciliation_run", id: run },
    });
    const b = await req("POST", "/internal/cases", { body, token, key: `rcn:${run}` });
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body.id).toBe(a.body.id);
    const c = await req("POST", "/internal/cases", { body: { ...body, severity: "critical" }, token });
    expect(c.body.id).toBe(a.body.id); // one open case per kind and subject
    expect(
      (await req("POST", "/internal/cases", { body: { ...body, note: "other" }, token, key: `rcn:${run}` })).status,
    ).toBe(409);
    expect((await outboxOf(s, "evt.compliance.review.opened")).some((e) => e.aggregate.id === a.body.id)).toBe(false);
    expect((await req("POST", "/internal/cases", { body, token: await mintServiceToken("identity") })).status).toBe(
      403,
    );
  });
});

// =============================================================================================
// Blocklist, screening, re-screening
// =============================================================================================

describe("blocklist, screening and re-screening (console)", () => {
  const addr = "0x4444444444444444444444444444444444444444";

  it("adds an entry (step-up): blocks screening at once, invalidates cached allows, disables matching destinations", async () => {
    const svc = await mintServiceToken("rails");
    const first = await req("POST", "/internal/screenings", {
      body: { subject_type: "address", chain: "eip155:8453", subject: addr, context: "payment", livemode: true },
      token: svc,
    });
    expect(first.body).toMatchObject({ decision: "allow", provider: "local" });
    const sd = newId("sd");
    const acct = newId("acct");
    await s.admin.db
      .insertInto("monitored_destinations")
      .values({
        destination_id: toUuid(sd, "sd"),
        account_id: toUuid(acct, "acct"),
        livemode: true,
        chain: "eip155:8453",
        address_norm: addr,
        asset_id: "nep141:x",
        type: "chain_address",
        active: true,
        source_version: 1,
      })
      .execute();

    const body = {
      subject_type: "address",
      subject: addr.toUpperCase().replace("0X", "0x"),
      reason: "law enforcement request",
    };
    expect(
      (await req("POST", "/ops/blocklist", { body, token: await consoleToken(alice, { stepUp: false }) })).status,
    ).toBe(401);
    const added = await req("POST", "/ops/blocklist", { body, token: await consoleToken(alice) });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      object: "blocklist_entry",
      subject_type: "address",
      chain: null,
      subject: addr,
      created_by: alice.sub,
    });
    expect(String(added.body.id)).toMatch(/^bl_/);
    expect((await req("POST", "/ops/blocklist", { body, token: await consoleToken(alice) })).status).toBe(409);
    const invalid = await req("POST", "/ops/blocklist", {
      body: { subject_type: "address", chain: "eip155:1", subject: "0x12", reason: "x" },
      token: await consoleToken(alice),
    });
    expect(invalid.body).toMatchObject({ error: { code: "address_invalid" } });

    const after = await req("POST", "/internal/screenings", {
      body: { subject_type: "address", chain: "eip155:8453", subject: addr, context: "payment", livemode: true },
      token: svc,
    });
    expect(after.body).toMatchObject({ decision: "block", reasons: ["blocklist"], cached: false });
    const cachedAllows = await s.admin.db
      .selectFrom("screenings")
      .select("id")
      .where("subject_norm", "=", addr)
      .where("decision", "=", "allow")
      .where("expires_at", ">", new Date())
      .execute();
    expect(cachedAllows).toEqual([]);
    expect((await outboxOf(s, "evt.compliance.destination.blocked")).some((e) => e.aggregate.id === sd)).toBe(true);
    expect((await opsActions(added.body.id as string))[0]?.data.object).toMatchObject({
      action: "blocklist_entry.added",
      account_id: null,
    });

    const list = await req("GET", `/ops/blocklist?subject=${addr.toUpperCase().replace("0X", "0x")}`, {
      token: await consoleToken(alice, { stepUp: false }),
    });
    expect((list.body.data as { id: string }[]).map((x) => x.id)).toEqual([added.body.id]);
  });

  it("removal is ops_admin with step-up; it does not unblock destinations", async () => {
    const added = await req("POST", "/ops/blocklist", {
      body: { subject_type: "near_account", subject: "bad-actor.near", reason: "fraud ring" },
      token: await consoleToken(alice),
    });
    const id = added.body.id as string;
    const remove = (token: string) =>
      req("POST", `/ops/blocklist/${id}/remove`, { body: { reason: "court order lifted" }, token });
    expect((await remove(await consoleToken(alice))).status).toBe(403);
    expect((await remove(await consoleToken(bob, { stepUp: false }))).status).toBe(401);
    const r = await remove(await consoleToken(bob));
    expect(r.status).toBe(204);
    expect((await remove(await consoleToken(bob))).status).toBe(404);
    expect((await opsActions(id)).map((e) => e.data.object.action)).toEqual([
      "blocklist_entry.added",
      "blocklist_entry.removed",
    ]);
    const page = await req("GET", "/ops/blocklist?limit=100", { token: await consoleToken(alice) });
    expect((page.body.data as { id: string }[]).some((x) => x.id === id)).toBe(false);
  });

  it("removal keeps the entry and names the subject in the audit trail (audit finding 10, INV-9)", async () => {
    const subject = "0x6666666666666666666666666666666666666666";
    const added = await req("POST", "/ops/blocklist", {
      body: { subject_type: "address", chain: "eip155:8453", subject, reason: "phishing drainer" },
      token: await consoleToken(alice),
    });
    const id = added.body.id as string;
    const r = await req("POST", `/ops/blocklist/${id}/remove`, {
      body: { reason: "false positive" },
      token: await consoleToken(bob),
    });
    expect(r.status).toBe(204);
    // the row survives as history: subject, chain, who removed it and why
    const row = await s.admin.db
      .selectFrom("blocklist")
      .selectAll()
      .where("id", "=", toUuid(id, "bl"))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      subject_type: "address",
      subject,
      chain: "eip155:8453",
      reason: "phishing drainer",
      removed_by: `ops:${bob.sub}`,
      removal_note: "false positive",
    });
    expect(row.removed_at).toBeInstanceOf(Date);
    // the operator-action rows carry the subject (internal; the published event stays ids-only)
    const actions = await s.admin.db
      .selectFrom("ops_actions")
      .select(["action", "details"])
      .where("target_id", "=", id)
      .orderBy("created_at")
      .execute();
    expect(actions).toEqual([
      { action: "blocklist_entry.added", details: { subject_type: "address", subject, chain: "eip155:8453" } },
      { action: "blocklist_entry.removed", details: { subject_type: "address", subject, chain: "eip155:8453" } },
    ]);
    // a removed entry no longer screens, is not listed, and the subject can be listed again (new id)
    const svc = await mintServiceToken("rails");
    const after = await req("POST", "/internal/screenings", {
      body: { subject_type: "address", chain: "eip155:8453", subject, context: "payment", livemode: true },
      token: svc,
    });
    expect(after.body).toMatchObject({ decision: "allow" });
    const again = await req("POST", "/ops/blocklist", {
      body: { subject_type: "address", chain: "eip155:8453", subject, reason: "drainer is back" },
      token: await consoleToken(alice),
    });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(id);
    const list = await req("GET", `/ops/blocklist?subject=${subject}`, { token: await consoleToken(alice) });
    expect((list.body.data as { id: string }[]).map((x) => x.id)).toEqual([again.body.id]);
    // history cannot be erased or rewritten
    await expect(s.admin.db.deleteFrom("blocklist").where("id", "=", toUuid(id, "bl")).execute()).rejects.toThrow();
    await expect(
      s.admin.db.updateTable("blocklist").set({ removed_at: null }).where("id", "=", toUuid(id, "bl")).execute(),
    ).rejects.toThrow();
  });

  it("an ops screening is a fresh lookup that never feeds the cache", async () => {
    const token = await consoleToken(alice);
    const hit = await req("POST", "/ops/screenings", {
      body: { subject_type: "address", chain: "eip155:1", subject: LISTED_EVM, livemode: true },
      token,
    });
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ decision: "block", reasons: ["sanctions"], cached: false, provider: "local" });
    const clean = "0x5555555555555555555555555555555555555555";
    const lookup = await req("POST", "/ops/screenings", {
      body: { subject_type: "address", chain: "eip155:1", subject: clean, livemode: true },
      token,
    });
    expect(lookup.body).toMatchObject({ decision: "allow", cached: false });
    const row = await s.admin.db
      .selectFrom("screenings")
      .selectAll()
      .where("id", "=", toUuid(lookup.body.screening_id as string, "scr"))
      .executeTakeFirstOrThrow();
    expect(row.expires_at.getTime()).toBe(row.created_at.getTime());
    expect(row.requested_by).toBe(`ops:${alice.sub}`);
    const svc = await req("POST", "/internal/screenings", {
      body: { subject_type: "address", chain: "eip155:1", subject: clean, context: "payment", livemode: true },
      token: await mintServiceToken("rails"),
    });
    expect(svc.body).toMatchObject({ cached: false });
    const sandbox = await req("POST", "/ops/screenings", {
      body: { subject_type: "near_account", subject: "sanctioned.testnet", livemode: false },
      token,
    });
    expect(sandbox.body).toMatchObject({ decision: "block", provider: "sandbox" });
    expect((await opsActions(hit.body.screening_id as string))[0]?.data.object).toMatchObject({
      action: "screening.created",
    });
  });

  it("queues a re-screen job for one account or all", async () => {
    const acct = newId("acct");
    await s.admin.db
      .insertInto("monitored_destinations")
      .values({
        destination_id: toUuid(newId("sd"), "sd"),
        account_id: toUuid(acct, "acct"),
        livemode: true,
        chain: "eip155:8453",
        address_norm: "0x6666666666666666666666666666666666666666",
        asset_id: "nep141:x",
        type: "chain_address",
        active: true,
        source_version: 1,
      })
      .execute();
    const r = await req("POST", "/ops/rescreens", { body: { account: acct }, token: await consoleToken(alice) });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ destinations: 1 });
    const job = await s.admin.db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", toUuid(r.body.job_id as string, "job"))
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({ kind: "destinations.rescreen", payload: { account_id: toUuid(acct, "acct") } });
    const all = await req("POST", "/ops/rescreens", { body: {}, token: await consoleToken(alice) });
    expect(all.body.destinations).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================================
// Merchant suspension — two-person rule
// =============================================================================================

describe("merchant suspension: single-operator platform (adaptive two-person rule)", () => {
  const path = (acct: string) => `/ops/merchants/${acct}`;
  const REASON = "only operator; fraud confirmed by chain analysis";
  const nowS = () => Math.floor(Date.now() / 1000);
  const ask = async (acct: string, opsAdmins?: number) =>
    req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "suspend", reason: "fraud reports" },
      token: await consoleToken(bob, { ...(opsAdmins !== undefined ? { opsAdmins } : {}), authAt: nowS() }),
    });
  const waitPassed = (opa: string) =>
    sql`update ops_approvals set requested_at = requested_at - interval '301 seconds' where id = ${toUuid(opa, "opa")}`.execute(
      s.admin.db,
    );
  const approveAs = async (acct: string, opa: string, o: { opsAdmins?: number; authAt?: number; note?: string }) =>
    req("POST", `${path(acct)}/suspension_requests/${opa}/approve`, {
      body: o.note === undefined ? {} : { note: o.note },
      token: await consoleToken(bob, {
        ...(o.opsAdmins !== undefined ? { opsAdmins: o.opsAdmins } : {}),
        authAt: o.authAt ?? nowS(),
      }),
    });

  it("the only operator completes it after the wait with a new confirmation and a reason; marked single_operator", async () => {
    const acct = newId("acct");
    const r = await ask(acct, 1);
    expect(r.status).toBe(201);
    const opa = r.body.id as string;
    expect(r.body.single_operator).toMatchObject({ used: false, reason_min_length: 20 });

    const early = await approveAs(acct, opa, { opsAdmins: 1, note: REASON });
    expect(early.status).toBe(403);
    expect(early.body).toMatchObject({ error: { code: "approver_conflict" } });

    await waitPassed(opa);
    const stale = await approveAs(acct, opa, { opsAdmins: 1, note: REASON, authAt: nowS() - 302 });
    expect(stale.status).toBe(401);
    expect(stale.body).toMatchObject({ error: { code: "step_up_required" } });
    expect((await approveAs(acct, opa, { opsAdmins: 1, note: "ok" })).status).toBe(400);

    const ok = await approveAs(acct, opa, { opsAdmins: 1, note: REASON });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ suspended: true, actor: `${bob.sub}+${bob.sub}`, pending_request: null });
    const row = await s.admin.db
      .selectFrom("ops_approvals")
      .selectAll()
      .where("id", "=", toUuid(opa, "opa"))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: "approved",
      single_operator: true,
      requested_admins: 1,
      decision_note: REASON,
    });
    expect(row.requested_by).toBe(toUuid(bob.sub, "usr"));
    const actions = await opsActions(opa);
    expect(actions.map((e) => e.data.object.action)).toEqual([
      "ops_approval.requested",
      "ops_approval.approved_single_operator",
    ]);
    expect(actions[1]?.data.object).toMatchObject({ single_operator: true, actor: { sub: bob.sub } });
  });

  it("requested with two approvers: the requester stays refused after the other is revoked", async () => {
    const acct = newId("acct");
    const opa = (await ask(acct, 2)).body.id as string;
    await waitPassed(opa);
    const self = await approveAs(acct, opa, { opsAdmins: 1, note: REASON });
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ error: { code: "approver_conflict" } });
  });

  it("a second operator added since the request re-enables the rule; no claim fails closed", async () => {
    const acct = newId("acct");
    const opa = (await ask(acct, 1)).body.id as string;
    await waitPassed(opa);
    expect((await approveAs(acct, opa, { opsAdmins: 2, note: REASON })).status).toBe(403);
    expect((await approveAs(acct, opa, { note: REASON })).status).toBe(403);
    const acct2 = newId("acct");
    const opa2 = (await ask(acct2)).body.id as string;
    expect((await ask(acct2)).status).toBe(409);
    await waitPassed(opa2);
    expect((await approveAs(acct2, opa2, { opsAdmins: 1, note: REASON })).status).toBe(403);
  });

  it("the database refuses a marked self-approval of a two-person request and an unmarked one", async () => {
    const acct = newId("acct");
    const two = toUuid((await ask(acct, 2)).body.id as string, "opa");
    const self = (extra: ReturnType<typeof sql>) =>
      sql`update ops_approvals set status = 'approved', decided_by = requested_by, decided_role = 'ops_admin',
          decided_at = now() + interval '1 second', decision_note = 'a reason', ${extra} where id = ${two}`.execute(
        s.admin.db,
      );
    await expect(self(sql`single_operator = true`)).rejects.toThrow(/ops_approvals_approver_differs/);
    await sql`update ops_approvals set requested_admins = 1 where id = ${two}`.execute(s.admin.db);
    await expect(self(sql`single_operator = false`)).rejects.toThrow(/ops_approvals_approver_differs/);
  });
});

describe("merchant suspension (two-person rule)", () => {
  const path = (acct: string) => `/ops/merchants/${acct}`;

  it("a request changes nothing; a different ops_admin approves and it executes in one transaction", async () => {
    const acct = newId("acct");
    const read = await req("GET", `${path(acct)}/suspension`, { token: await consoleToken(alice, { stepUp: false }) });
    expect(read.body).toMatchObject({ object: "merchant_suspension", suspended: false, pending_request: null });

    const body = { action: "suspend", reason: "fraud reports" };
    expect(
      (
        await req("POST", `${path(acct)}/suspension_requests`, {
          body,
          token: await consoleToken(alice, { stepUp: false }),
        })
      ).status,
    ).toBe(401);
    const req1 = await req("POST", `${path(acct)}/suspension_requests`, { body, token: await consoleToken(alice) });
    expect(req1.status).toBe(201);
    expect(req1.body).toMatchObject({
      object: "ops_approval",
      action: "account.suspend",
      target: { type: "account", id: acct },
      status: "pending",
      requested_by: { id: alice.sub, role: "ops" },
      decided_by: null,
    });
    expect((req1.body.expires_at as number) - (req1.body.requested_at as number)).toBe(86_400);
    const opa = req1.body.id as string;
    expect((await outboxOf(s, "evt.compliance.account.action_requested")).some((e) => e.aggregate.id === opa)).toBe(
      true,
    );
    expect(
      (await req("POST", `${path(acct)}/suspension_requests`, { body, token: await consoleToken(bob) })).status,
    ).toBe(409);
    expect(
      (await req("GET", `${path(acct)}/suspension`, { token: await consoleToken(bob) })).body.pending_request,
    ).toMatchObject({ id: opa });

    const approveAs = (token: string) =>
      req("POST", `${path(acct)}/suspension_requests/${opa}/approve`, { body: { note: "confirmed" }, token });
    expect((await approveAs(await consoleToken(alice))).status).toBe(403); // ops role
    expect((await approveAs(await consoleToken(bob, { stepUp: false }))).status).toBe(401);
    expect(
      (
        await req("POST", `${path(newId("acct"))}/suspension_requests/${opa}/approve`, {
          body: {},
          token: await consoleToken(bob),
        })
      ).status,
    ).toBe(404);
    const ok = await approveAs(await consoleToken(bob));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      suspended: true,
      reason: "fraud reports",
      actor: `${alice.sub}+${bob.sub}`,
      pending_request: null,
    });
    const suspended = (await outboxOf(s, "evt.compliance.account.suspended")).filter((e) => e.aggregate.id === acct);
    expect(suspended).toHaveLength(1);
    const actions = await opsActions(opa);
    expect(actions.map((e) => [e.data.object.action, (e.data.object.actor as { sub: string }).sub])).toEqual([
      ["ops_approval.requested", alice.sub],
      ["ops_approval.approved", bob.sub],
    ]);
    expect(actions.every((e) => e.data.object.approval === opa)).toBe(true);
    expect((await approveAs(await consoleToken(carol))).status).toBe(409); // already approved
    expect(
      (await req("POST", `${path(acct)}/suspension_requests`, { body, token: await consoleToken(alice) })).status,
    ).toBe(409);
  });

  it("the requester can never approve their own request", async () => {
    const acct = newId("acct");
    const r = await req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "suspend", reason: "test" },
      token: await consoleToken(bob),
    });
    const approve = await req("POST", `${path(acct)}/suspension_requests/${r.body.id}/approve`, {
      body: {},
      token: await consoleToken(bob),
    });
    expect(approve.status).toBe(403);
    expect(approve.body).toMatchObject({ error: { code: "approver_conflict" } });
    // ... but may withdraw it (reject)
    const withdrawn = await req("POST", `${path(acct)}/suspension_requests/${r.body.id}/reject`, {
      body: { note: "opened by mistake" },
      token: await consoleToken(bob, { stepUp: false }),
    });
    expect(withdrawn.body).toMatchObject({
      status: "rejected",
      decided_by: { id: bob.sub },
      decision_note: "opened by mistake",
    });
    expect((await req("GET", `${path(acct)}/suspension`, { token: await consoleToken(bob) })).body).toMatchObject({
      suspended: false,
      pending_request: null,
    });
    expect(
      (
        await req("POST", `${path(acct)}/suspension_requests/${r.body.id}/reject`, {
          body: { note: "x" },
          token: await consoleToken(bob),
        })
      ).status,
    ).toBe(409);
  });

  it("the database refuses an approval by the requester, whatever the code does", async () => {
    const acct = newId("acct");
    const r = await req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "suspend", reason: "test" },
      token: await consoleToken(bob),
    });
    await expect(
      s.admin.db
        .updateTable("ops_approvals")
        .set({
          status: "approved",
          decided_by: toUuid(bob.sub, "usr"),
          decided_role: "ops_admin",
          decided_at: new Date(),
        })
        .where("id", "=", toUuid(r.body.id as string, "opa"))
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      s.admin.db
        .updateTable("ops_approvals")
        .set({ status: "approved", decided_by: toUuid(alice.sub, "usr"), decided_role: "ops", decided_at: new Date() })
        .where("id", "=", toUuid(r.body.id as string, "opa"))
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("an expired request is marked expired and cannot be approved; the sweep expires the rest", async () => {
    const acct = newId("acct");
    const r = await req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "suspend", reason: "test" },
      token: await consoleToken(alice),
    });
    const id = toUuid(r.body.id as string, "opa");
    await sql`update ops_approvals set requested_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = ${id}`.execute(
      s.admin.db,
    );
    const approve = await req("POST", `${path(acct)}/suspension_requests/${r.body.id}/approve`, {
      body: {},
      token: await consoleToken(bob),
    });
    expect(approve.status).toBe(409);
    expect(
      (await s.admin.db.selectFrom("ops_approvals").select("status").where("id", "=", id).executeTakeFirstOrThrow())
        .status,
    ).toBe("expired");
    expect((await req("GET", `${path(acct)}/suspension`, { token: await consoleToken(bob) })).body).toMatchObject({
      suspended: false,
      pending_request: null,
    });
    // a new request is possible again; the sweep expires it once due
    const r2 = await req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "suspend", reason: "again" },
      token: await consoleToken(alice),
    });
    expect(r2.status).toBe(201);
    const id2 = toUuid(r2.body.id as string, "opa");
    await sql`update ops_approvals set requested_at = now() - interval '25 hours', expires_at = now() - interval '1 second' where id = ${id2}`.execute(
      s.admin.db,
    );
    expect(await expireApprovals(s.compliance)).toBeGreaterThanOrEqual(1);
    expect(
      (await s.admin.db.selectFrom("ops_approvals").select("status").where("id", "=", id2).executeTakeFirstOrThrow())
        .status,
    ).toBe("expired");
  });

  it("an action that no longer matches the account state expires the request", async () => {
    const acct = newId("acct");
    const r = await req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "suspend", reason: "x" },
      token: await consoleToken(alice),
    });
    // suspended meanwhile through the local-stack CLI path
    await s.admin.db
      .insertInto("account_flags")
      .values({ account_id: toUuid(acct, "acct"), suspended: true, reason: "cli", actor: "ops:cli@test" })
      .execute();
    const approve = await req("POST", `${path(acct)}/suspension_requests/${r.body.id}/approve`, {
      body: {},
      token: await consoleToken(bob),
    });
    expect(approve.status).toBe(409);
    expect(
      (
        await s.admin.db
          .selectFrom("ops_approvals")
          .select("status")
          .where("id", "=", toUuid(r.body.id as string, "opa"))
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("expired");
    // reinstating needs two operators too
    const re = await req("POST", `${path(acct)}/suspension_requests`, {
      body: { action: "reinstate", reason: "cleared" },
      token: await consoleToken(alice),
    });
    const ok = await req("POST", `${path(acct)}/suspension_requests/${re.body.id}/approve`, {
      body: {},
      token: await consoleToken(carol),
    });
    expect(ok.body).toMatchObject({ suspended: false, actor: `${alice.sub}+${carol.sub}` });
    expect((await outboxOf(s, "evt.compliance.account.reinstated")).some((e) => e.aggregate.id === acct)).toBe(true);
  });
});
