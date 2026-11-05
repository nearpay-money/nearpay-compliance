/**
 * Contract (foundations §16): every Stage-1 compliance route of the spec is bound, every subject the
 * catalogue routes to compliance has a handler, every subject compliance produces is emitted, and
 * responses (success and error) have the spec's shapes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ErrorEnvelope, PUBLIC_ROUTES, startKyb } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { newId } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  createScreening,
  decideKyb,
  getGeoPolicy,
  INTERNAL_ROUTES,
  SUBJECTS,
  type Subject,
} from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceRoutes } from "../../src/api/routes.js";
import { complianceHandlers } from "../../src/consumers/handlers.js";
import { mintServiceToken, opsToken, type Stack, sessionToken, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const ALL_ROUTES = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes", () => {
  it("binds every Stage-1 compliance route, and nothing else", () => {
    const bindings = complianceRoutes({} as never);
    expect(unimplementedRoutes("compliance", ALL_ROUTES, bindings).map((r) => r.id)).toEqual([]);
    const ours = ALL_ROUTES.filter((r) => r.service === "compliance" && r.stage <= 1).map((r) => r.id);
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
      (k) => SUBJECTS[k].producer === "compliance" && SUBJECTS[k].stage <= 1,
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
