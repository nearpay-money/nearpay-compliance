/** The `api` process over HTTP: screening, geo policy, KYB start and the manual decision (LLD §4–§5). */

import { sql } from "@nearpay-internal/db";
import { fromUuid, newId, toUuid } from "@nearpay-internal/ids";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKybCase } from "../../src/app/kyb.js";
import {
  CLEAN_EVM,
  LISTED_BTC,
  LISTED_EVM,
  mintServiceToken,
  opsToken,
  type Stack,
  sessionToken,
  startStack,
} from "../support/stack.js";

const BASE = "eip155:8453";
const BTC = "bip122:000000000019d6689c085ae165831e93";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const screenReq = (over: Record<string, unknown> = {}) => ({
  subject_type: "address",
  chain: BASE,
  subject: CLEAN_EVM,
  context: "payment",
  livemode: true,
  ...over,
});
const screen = async (over: Record<string, unknown> = {}, token?: string) =>
  s.call("POST", "/internal/screenings", { body: screenReq(over), ...(token ? { token } : {}) });

const outbox = async (subject: string) =>
  (
    await sql<{
      subject: string;
      envelope: { aggregate: { id: string; version: number }; data: { object: Record<string, unknown> } };
    }>`
      select subject, payload as envelope from outbox where subject = ${subject} order by created_at`.execute(
      s.admin.db,
    )
  ).rows;

describe("POST /internal/screenings", () => {
  describe("before any sanctions list is imported (fail-safe)", () => {
    it("refuses a live payment at the fail-closed threshold with 503 screening_unavailable", async () => {
      const r = await screen({ amount_usd_micros: 1_000_000_000 });
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: { code: "screening_unavailable" } });
    });

    it("allows a smaller one with post-screening required, and does not cache it", async () => {
      const r = await screen({ amount_usd_micros: 999_999_999 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        decision: "allow",
        reasons: ["sanctions_list_unavailable"],
        cached: false,
        post_screen_required: true,
      });
      const again = await screen({ amount_usd_micros: 999_999_999 });
      expect(again.body).toMatchObject({ cached: false });
    });

    it("still blocks blocklisted subjects", async () => {
      await s.admin.db
        .insertInto("blocklist")
        .values({
          subject_type: "address",
          subject: "0x00000000000000000000000000000000000000b1",
          reason: "t",
          created_by: "t",
        })
        .execute();
      const r = await screen({
        subject: "0x00000000000000000000000000000000000000B1",
        amount_usd_micros: 5_000_000_000,
      });
      expect(r.body).toMatchObject({ decision: "block", reasons: ["blocklist"] });
    });
  });

  describe("with the OFAC sample imported", () => {
    beforeAll(async () => {
      await s.importSample();
    });

    it("blocks a listed EVM address in any spelling", async () => {
      const r = await screen({ subject: LISTED_EVM.toUpperCase().replace("0X", "0x") });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ decision: "block", reasons: ["sanctions"], cached: false });
      expect((r.body as { screening_id: string }).screening_id).toMatch(/^scr_/);
    });

    it("blocks a listed bitcoin address", async () => {
      const r = await screen({ chain: BTC, subject: LISTED_BTC });
      expect(r.body).toMatchObject({ decision: "block", reasons: ["sanctions"] });
    });

    it("matches a listed EVM address used as an eth-implicit NEAR account", async () => {
      const r = await screen({ subject_type: "near_account", chain: undefined, subject: LISTED_EVM, context: "x402" });
      expect(r.body).toMatchObject({ decision: "block" });
    });

    it("matches an address on a chain the registry does not know in any family (Tron)", async () => {
      const tron = (
        await s.admin.db
          .selectFrom("sanctions_entries")
          .select("address_norm")
          .where("chain_family", "=", "tron")
          .executeTakeFirstOrThrow()
      ).address_norm;
      const r = await screen({ chain: "tron:mainnet", subject: tron });
      expect(r.body).toMatchObject({ decision: "block", reasons: ["sanctions"] });
    });

    it("allows a clean address and serves the decision from the cache afterwards", async () => {
      const subject = "0x1111111111111111111111111111111111111111";
      const first = await screen({ subject });
      expect(first.body).toMatchObject({ decision: "allow", reasons: [], cached: false, post_screen_required: false });
      const second = await screen({ subject, context: "refund" });
      expect(second.body).toMatchObject({ decision: "allow", cached: true });
      expect((second.body as { screening_id: string }).screening_id).toBe(
        (first.body as { screening_id: string }).screening_id,
      );
      const rows = await s.admin.db.selectFrom("screenings").selectAll().where("subject_norm", "=", subject).execute();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row && row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThan(23 * 3_600_000);
    });

    it("a later list hit wins over a cached allow", async () => {
      const subject = "0x2222222222222222222222222222222222222222";
      expect((await screen({ subject })).body).toMatchObject({ decision: "allow" });
      await s.admin.db
        .insertInto("blocklist")
        .values({ subject_type: "address", subject, reason: "ops", created_by: "t" })
        .execute();
      expect((await screen({ subject })).body).toMatchObject({
        decision: "block",
        reasons: ["blocklist"],
        cached: false,
      });
    });

    it("test mode uses only the magic subject, never the lists (INV-8)", async () => {
      expect((await screen({ livemode: false, subject: LISTED_EVM })).body).toMatchObject({ decision: "allow" });
      expect(
        (
          await screen({
            livemode: false,
            subject_type: "near_account",
            chain: undefined,
            subject: "sanctioned.testnet",
          })
        ).body,
      ).toMatchObject({ decision: "block", reasons: ["sandbox_magic"] });
    });

    it("records the account and context of the screening", async () => {
      const acct = newId("acct");
      const r = await screen({
        subject: "0x3333333333333333333333333333333333333333",
        account_id: acct,
        context: "destination",
      });
      const id = toUuid((r.body as { screening_id: string }).screening_id, "scr");
      const row = await s.admin.db.selectFrom("screenings").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        account_id: toUuid(acct, "acct"),
        context: "destination",
        livemode: true,
        provider: "local",
      });
    });

    it("rejects invalid subjects with the offending parameter", async () => {
      const bad = await screen({ subject: "0x1234" });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: { code: "invalid_request", param: "subject" } });
      const noChain = await screen({ chain: undefined });
      expect(noChain.body).toMatchObject({ error: { code: "invalid_request", param: "chain" } });
    });
  });

  it("requires the compliance.screen scope", async () => {
    expect((await screen({}, await mintServiceToken("payments"))).status).toBe(403);
    expect((await screen({}, await mintServiceToken("identity"))).status).toBe(200);
    expect((await screen({}, await mintServiceToken("agentpay"))).status).toBe(200);
    expect((await s.call("POST", "/internal/screenings", { body: screenReq(), token: "" })).status).toBe(401);
  });
});

describe("GET /internal/geo-policy", () => {
  it("returns the default policy for payments", async () => {
    const r = await s.call("GET", "/internal/geo-policy", { token: await mintServiceToken("payments") });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      blocked_countries: ["CU", "IR", "KP", "SY"],
      blocked_regions: ["UA-43", "UA-14", "UA-09"],
      version: "1",
    });
  });
  it("requires compliance.read", async () => {
    expect((await s.call("GET", "/internal/geo-policy", { token: await mintServiceToken("notify") })).status).toBe(403);
  });
});

describe("KYB", () => {
  let acct: string;
  beforeEach(async () => {
    acct = newId("acct");
    await s.admin.db.transaction().execute((tx) => createKybCase(tx, acct));
  });

  it("the owner starts KYB: returns the case, which stays not_started until the details are submitted", async () => {
    const token = await sessionToken(acct);
    const r = await s.call("POST", "/v1/account/kyb", { body: {}, token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "kyb_case", status: "not_started", vendor_flow_url: null, editable: true });
    expect((await s.call("POST", "/v1/account/kyb", { body: {}, token })).body).toMatchObject({
      status: "not_started",
    });
    const transitions = await s.admin.db
      .selectFrom("kyb_case_transitions")
      .innerJoin("kyb_cases", "kyb_cases.id", "kyb_case_transitions.kyb_case_id")
      .select(["from_state", "to_state", "actor"])
      .where("kyb_cases.account_id", "=", toUuid(acct, "acct"))
      .execute();
    expect(transitions).toEqual([]);
  });

  it("honours Idempotency-Key on start", async () => {
    const token = await sessionToken(acct);
    const headers = { "idempotency-key": `idem-${acct}` };
    const a = await s.call("POST", "/v1/account/kyb", { body: {}, token, headers });
    const b = await s.call("POST", "/v1/account/kyb", { body: {}, token, headers });
    expect(a.body).toEqual(b.body);
  });

  it("only the owner may start KYB", async () => {
    const r = await s.call("POST", "/v1/account/kyb", { body: {}, token: await sessionToken(acct, "developer") });
    expect(r.status).toBe(403);
  });

  it("starting KYB for an account without a case creates it (account.created not consumed yet)", async () => {
    const other = newId("acct");
    const r = await s.call("POST", "/v1/account/kyb", { body: {}, token: await sessionToken(other) });
    expect(r.body).toMatchObject({ status: "not_started" });
    expect(
      await s.admin.db
        .selectFrom("kyb_cases")
        .select("id")
        .where("account_id", "=", toUuid(other, "acct"))
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it("the ops decision records the actor and emits evt.compliance.kyb.<decision> once", async () => {
    const decide = async (decision: string, reason = "documents verified") =>
      s.call("POST", `/internal/kyb_cases/${acct}/decision`, { body: { decision, reason }, token: await opsToken() });
    const r = await decide("approved");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ account_id: acct, status: "approved" });
    expect(Number.isNaN(Date.parse((r.body as { decided_at: string }).decided_at))).toBe(false);
    expect((await decide("approved")).body).toMatchObject({ status: "approved" }); // idempotent, no second event
    const approved = (await outbox("evt.compliance.kyb.approved")).filter((e) => e.envelope.aggregate.id === acct);
    expect(approved).toHaveLength(1);
    expect(approved[0]?.envelope.data.object).toMatchObject({ account_id: acct, status: "approved" });

    expect((await decide("rejected", "sanctions exposure")).body).toMatchObject({ status: "rejected" });
    const rejected = (await outbox("evt.compliance.kyb.rejected")).filter((e) => e.envelope.aggregate.id === acct);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.envelope.aggregate.version).toBeGreaterThan(approved[0]?.envelope.aggregate.version as number);

    const row = await s.admin.db
      .selectFrom("kyb_cases")
      .selectAll()
      .where("account_id", "=", toUuid(acct, "acct"))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: "rejected",
      decided_by: "ops:usr_ops_alice",
      decision_reason: "sanctions exposure",
    });
  });

  it("deciding an unknown account is resource_missing; a service token is refused", async () => {
    const unknown = newId("acct");
    const r = await s.call("POST", `/internal/kyb_cases/${unknown}/decision`, {
      body: { decision: "approved", reason: "x" },
      token: await opsToken(),
    });
    expect(r.status).toBe(404);
    const svc = await s.call("POST", `/internal/kyb_cases/${acct}/decision`, {
      body: { decision: "approved", reason: "x" },
      token: await mintServiceToken("identity"),
    });
    expect(svc.status).toBe(403);
    const noScope = await s.call("POST", `/internal/kyb_cases/${acct}/decision`, {
      body: { decision: "approved", reason: "x" },
      token: await opsToken(["compliance.cases.write"]),
    });
    expect(noScope.status).toBe(403);
  });
});

describe("database roles", () => {
  it("the app role cannot change the schema", async () => {
    await expect(sql`create table nope (id int)`.execute(s.admin.db)).rejects.toThrow(/permission denied/);
    await expect(sql`drop table cases`.execute(s.admin.db)).rejects.toThrow(/must be owner|permission denied/);
  });
  it("ids round-trip as the spec's prefixed ids", async () => {
    const id = newId("case");
    expect(fromUuid("case", toUuid(id, "case"))).toBe(id);
  });
});
