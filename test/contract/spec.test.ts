/**
 * Contract (foundations §16): every Stage 1 and Stage 2 compliance route of the spec (internal,
 * dashboard and console) is bound, every subject the
 * catalogue routes to compliance has a handler, every subject compliance produces is emitted, and
 * responses (success and error) have the spec's shapes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ErrorEnvelope, getKyb, PUBLIC_ROUTES, startKyb } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { sql } from "@nearpay-internal/db";
import { newId } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  createInternalCase,
  createOpsSuspensionRequest,
  createScreening,
  decideKyb,
  getGeoPolicy,
  getInternalKybCase,
  getOpsKybCase,
  getOpsMerchantSuspension,
  INTERNAL_ROUTES,
  listOpsBlocklist,
  listOpsCases,
  SUBJECTS,
  type Subject,
} from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceRoutes } from "../../src/api/routes.js";
import { complianceHandlers } from "../../src/consumers/handlers.js";
import {
  consoleToken,
  mintServiceToken,
  newOperator,
  opsToken,
  type Stack,
  sessionToken,
  startStack,
} from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const ALL_ROUTES = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes", () => {
  it("binds every Stage 1–2 compliance route (internal, dashboard, console), and nothing else", () => {
    const bindings = complianceRoutes({} as never);
    expect(unimplementedRoutes("compliance", ALL_ROUTES, bindings, 2).map((r) => r.id)).toEqual([]);
    const ours = [...new Set(ALL_ROUTES.filter((r) => r.service === "compliance" && r.stage <= 2).map((r) => r.id))];
    expect(ours).toEqual(
      expect.arrayContaining(["decideOpsKybCase", "approveOpsSuspensionRequest", "createInternalCase"]),
    );
    expect(bindings.map((b) => b.route.id).sort()).toEqual([...ours].sort());
  });

  it("responses match the spec schemas", async () => {
    const acct = newId("acct");
    const screening = await s.call("POST", "/internal/screenings", {
      body: { subject_type: "near_account", subject: "alice.near", context: "x402", livemode: false },
      token: await mintServiceToken("agentpay"),
    });
    expect(createScreening.response.safeParse(screening.body).success).toBe(true);
    const geo = await s.call("GET", "/internal/geo-policy", { token: await mintServiceToken("payments") });
    expect(getGeoPolicy.response.safeParse(geo.body).success).toBe(true);
    const kyb = await s.call("POST", "/v1/account/kyb", { body: {}, token: await sessionToken(acct) });
    expect(startKyb.response.safeParse(kyb.body).success).toBe(true);
    const decided = await s.call("POST", `/internal/kyb_cases/${acct}/decision`, {
      body: { decision: "approved", reason: "ok" },
      token: await opsToken(),
    });
    expect(decideKyb.response.safeParse(decided.body).success, JSON.stringify(decided.body)).toBe(true);

    // Stage 2
    const kyb2 = await s.call("GET", "/v1/account/kyb", { token: await sessionToken(acct) });
    expect(getKyb.response.safeParse(kyb2.body).success, JSON.stringify(kyb2.body)).toBe(true);
    const internal = await s.call("GET", `/internal/kyb_cases/${acct}`, { token: await mintServiceToken("identity") });
    expect(getInternalKybCase.response.safeParse(internal.body).success, JSON.stringify(internal.body)).toBe(true);
    const op = newOperator("ops_admin");
    const opsKyb = await s.call("GET", `/ops/kyb_cases/${acct}`, { token: await consoleToken(op) });
    expect(getOpsKybCase.response.safeParse(opsKyb.body).success, JSON.stringify(opsKyb.body)).toBe(true);
    const cases = await s.call("GET", "/ops/cases", { token: await consoleToken(op) });
    expect(listOpsCases.response.safeParse(cases.body).success, JSON.stringify(cases.body)).toBe(true);
    const created = await s.call("POST", "/internal/cases", {
      body: {
        kind: "reconciliation_diff",
        account_id: acct,
        livemode: false,
        subject: { type: "reconciliation_run", id: newId("rcn") },
        note: "1 diff",
      },
      token: await mintServiceToken("payments"),
    });
    expect(createInternalCase.response.safeParse(created.body).success, JSON.stringify(created.body)).toBe(true);
    const bl = await s.call("GET", "/ops/blocklist", { token: await consoleToken(op) });
    expect(listOpsBlocklist.response.safeParse(bl.body).success, JSON.stringify(bl.body)).toBe(true);
    const susp = await s.call("POST", `/ops/merchants/${acct}/suspension_requests`, {
      body: { action: "suspend", reason: "contract" },
      token: await consoleToken(op),
    });
    expect(createOpsSuspensionRequest.response.safeParse(susp.body).success, JSON.stringify(susp.body)).toBe(true);
    const state = await s.call("GET", `/ops/merchants/${acct}/suspension`, { token: await consoleToken(op) });
    expect(getOpsMerchantSuspension.response.safeParse(state.body).success, JSON.stringify(state.body)).toBe(true);
  });

  it("every event compliance writes matches its catalogue schema", async () => {
    const rows = (
      await sql<{
        subject: Subject;
        payload: { data: { object: unknown } };
      }>`select subject, payload from outbox`.execute(s.admin.db)
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const parsed = SUBJECTS[r.subject].object.safeParse(r.payload.data.object);
      expect(parsed.success, `${r.subject}: ${JSON.stringify(r.payload.data.object)}`).toBe(true);
    }
  });

  it("errors use the spec error envelope", async () => {
    for (const r of [
      await s.call("POST", "/internal/screenings", {
        body: { subject_type: "address", subject: "0x12", chain: "eip155:1", context: "payment", livemode: true },
      }),
      await s.call("POST", "/internal/screenings", { body: { subject_type: "bogus" } }),
      await s.call("GET", "/internal/geo-policy", { token: "" }),
      await s.call("POST", `/internal/kyb_cases/${newId("acct")}/decision`, {
        body: { decision: "approved", reason: "x" },
        token: await opsToken(),
      }),
    ]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(ErrorEnvelope.safeParse(r.body).success, JSON.stringify(r.body)).toBe(true);
    }
  });
});

describe("events", () => {
  it("handles every subject the catalogue routes to compliance", () => {
    const handlers = complianceHandlers({} as never);
    expect(unhandledSubjects("compliance", handlers)).toEqual([]);
    for (const subject of Object.keys(handlers) as Subject[])
      expect(SUBJECTS[subject].consumers).toContain("compliance");
  });

  it("emits every subject compliance produces (and only those)", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "compliance" && SUBJECTS[k].stage <= 2,
    );
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const literal = new Set(src.match(/evt\.compliance\.[a-z_]+\.[a-z_]+/g));
    // kyb.<decision> is built from the decision (domain/kyb-case kybSubject)
    for (const d of ["approved", "rejected", "needs_info"]) literal.add(`evt.compliance.kyb.${d}`);
    literal.delete("evt.compliance.kyb.");
    expect([...literal].filter((x) => !x.endsWith(".")).sort()).toEqual([...produced].sort());
  });
});
