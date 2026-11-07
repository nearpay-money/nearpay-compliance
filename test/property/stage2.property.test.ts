/**
 * Stage 2 properties (foundations §16): the self-declared KYB status machine, the two-person rule for
 * merchant suspension (never completes with one principal; never after expiry) and the screening
 * fail-closed policy behind the vendor-neutral provider interface.
 */
import { newId } from "@nearpay-internal/ids";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideConsole,
  decideKyb,
  isEditable,
  KYB_STATUSES,
  type KybDecision,
  type KybStatus,
  submitKyb,
} from "../../src/domain/kyb-case/kyb.js";
import { emptyProfile, type KybProfile, mergeProfile, missingFields } from "../../src/domain/kyb-case/profile.js";
import {
  type Approval,
  approve,
  type Operator,
  reject,
  requestAction,
  type SuspensionAction,
  sweep,
} from "../../src/domain/ops-approval/approval.js";
import { decide, type ScreeningFacts } from "../../src/domain/screening/decision.js";

// ---------------------------------------------------------------------------------------------
// KYB
// ---------------------------------------------------------------------------------------------

const decisionArb = fc.constantFrom<KybDecision>("approved", "rejected", "needs_info");
const fieldUpdate = fc.oneof(
  fc.record({ legal_name: fc.option(fc.constantFrom("Acme Ltd", "  ", "Jane Doe"), { nil: null }) }),
  fc.record({ country_of_incorporation: fc.option(fc.constantFrom("GB", "de"), { nil: null }) }),
  fc.record({ registration_number: fc.option(fc.constantFrom("123", "HRB 1"), { nil: null }) }),
  fc.record({ business_type: fc.option(fc.constantFrom("company" as const, "other" as const), { nil: null }) }),
  fc.record({ website: fc.option(fc.constant("https://acme.example"), { nil: null }) }),
  fc.record({
    business_address: fc.option(fc.constant({ line1: "1 St", city: "Town", country: "GB" }), { nil: null }),
  }),
  fc.record({ representative: fc.option(fc.constant({ name: "Jane", title: "Director" }), { nil: null }) }),
  fc.record({ expected_monthly_volume: fc.option(fc.constant("under_10k" as const), { nil: null }) }),
);
type KybCmd =
  | { kind: "update"; update: Parameters<typeof mergeProfile>[1] }
  | { kind: "submit" }
  | { kind: "console"; d: KybDecision; info: string | undefined }
  | { kind: "manual"; d: KybDecision };
const kybCmd = (manual: boolean): fc.Arbitrary<KybCmd> =>
  fc.oneof(
    fieldUpdate.map((update) => ({ kind: "update", update }) as const),
    fc.constant({ kind: "submit" } as const),
    fc.record({
      kind: fc.constant("console" as const),
      d: decisionArb,
      info: fc.option(fc.constantFrom("add the register number", " "), { nil: undefined }),
    }),
    ...(manual ? [decisionArb.map((d) => ({ kind: "manual", d }) as const)] : []),
  );

interface KybWorld {
  status: KybStatus;
  profile: KybProfile;
  events: string[];
  /** Profile completeness at the last accepted submission. */
  submittedComplete: boolean | null;
}

function runKyb(cmds: readonly KybCmd[], onStep?: (before: KybWorld, cmd: KybCmd, after: KybWorld) => void) {
  const w: KybWorld = { status: "not_started", profile: emptyProfile(), events: [], submittedComplete: null };
  for (const cmd of cmds) {
    const before: KybWorld = { ...w, events: [...w.events] };
    switch (cmd.kind) {
      case "update":
        if (isEditable(w.status)) w.profile = mergeProfile(w.profile, cmd.update).profile;
        break;
      case "submit": {
        const step = submitKyb(w.status, missingFields(w.profile));
        if (step.ok) {
          w.status = step.to;
          w.events.push("kyb.submitted");
          w.submittedComplete = missingFields(w.profile).length === 0;
        }
        break;
      }
      case "console": {
        const step = decideConsole(w.status, cmd.d, {
          requestedInfo: cmd.info,
          profileComplete: missingFields(w.profile).length === 0,
        });
        if (step.changed) {
          w.status = step.to;
          w.events.push(`kyb.${cmd.d}`);
        }
        break;
      }
      case "manual": {
        const step = decideKyb(w.status, cmd.d);
        if (step.changed) {
          w.status = step.to;
          w.events.push(`kyb.${cmd.d}`);
        }
        break;
      }
    }
    onStep?.(before, cmd, w);
  }
  return w;
}

describe("KYB status machine (owner + console)", () => {
  it("pending is only entered by a submission of a complete declaration", () => {
    fc.assert(
      fc.property(fc.array(kybCmd(false), { maxLength: 30 }), (cmds) => {
        runKyb(cmds, (before, cmd, after) => {
          expect(KYB_STATUSES).toContain(after.status);
          if (after.status === "pending" && before.status !== "pending") {
            expect(cmd.kind).toBe("submit");
            expect(missingFields(after.profile)).toEqual([]);
          }
        });
      }),
    );
  });

  it("approved is only entered from pending, with a complete declaration that was submitted", () => {
    fc.assert(
      fc.property(fc.array(kybCmd(false), { maxLength: 30 }), (cmds) => {
        runKyb(cmds, (before, cmd, after) => {
          if (after.status === "approved" && before.status !== "approved") {
            expect(cmd).toMatchObject({ kind: "console", d: "approved" });
            expect(before.status).toBe("pending");
            expect(missingFields(after.profile)).toEqual([]);
            expect(after.submittedComplete).toBe(true);
          }
        });
      }),
    );
  });

  it("the declaration only changes while editable; decided cases are frozen for the owner", () => {
    fc.assert(
      fc.property(fc.array(kybCmd(true), { maxLength: 30 }), (cmds) => {
        runKyb(cmds, (before, cmd, after) => {
          if (cmd.kind === "update" && !isEditable(before.status)) expect(after.profile).toEqual(before.profile);
          if (cmd.kind === "submit" && !isEditable(before.status)) expect(after.status).toBe(before.status);
        });
      }),
    );
  });

  it("every status change emits exactly one event, and a no-op emits none (INV-4)", () => {
    fc.assert(
      fc.property(fc.array(kybCmd(true), { maxLength: 30 }), (cmds) => {
        runKyb(cmds, (before, cmd, after) => {
          const emitted = after.events.length - before.events.length;
          const changed = before.status !== after.status;
          if (cmd.kind === "update") expect(emitted).toBe(0);
          else expect(emitted).toBe(changed ? 1 : 0);
          if (emitted === 1)
            expect(after.events.at(-1)).toBe(cmd.kind === "submit" ? "kyb.submitted" : `kyb.${after.status}`);
        });
      }),
    );
  });

  it("needs_info set by the console always carries what the merchant must add", () => {
    fc.assert(
      fc.property(fc.array(kybCmd(false), { maxLength: 30 }), (cmds) => {
        runKyb(cmds, (before, cmd, after) => {
          if (cmd.kind === "console" && after.status === "needs_info" && before.status !== "needs_info")
            expect(cmd.info?.trim()).toBeTruthy();
        });
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Two-person suspension
// ---------------------------------------------------------------------------------------------

type SusCmd =
  | { kind: "request"; by: number; action: SuspensionAction }
  | { kind: "approve"; by: number }
  | { kind: "reject"; by: number }
  | { kind: "tick"; seconds: number }
  | { kind: "sweep" };

const TTL = 86_400;

interface SusWorld {
  now: number;
  suspended: boolean;
  approvals: (Approval & { decidedBy?: string; decidedAt?: number })[];
  executions: { action: string; requestedBy: string; decidedBy: string; role: string; at: number; expiresAt: number }[];
}

function runSuspension(ops: readonly Operator[], cmds: readonly SusCmd[]): SusWorld {
  const w: SusWorld = { now: 1_800_000_000_000, suspended: false, approvals: [], executions: [] };
  const pendingIdx = () => w.approvals.findIndex((a) => a.status === "pending");
  for (const cmd of cmds) {
    switch (cmd.kind) {
      case "tick":
        w.now += cmd.seconds * 1000;
        break;
      case "sweep":
        w.approvals = w.approvals.map((a) => (sweep(a, w.now) ? { ...a, status: "expired" } : a));
        break;
      case "request": {
        const op = ops[cmd.by % ops.length] as Operator;
        // the use case expires due requests of the account before checking for a pending one
        w.approvals = w.approvals.map((a) => (sweep(a, w.now) ? { ...a, status: "expired" } : a));
        const step = requestAction(cmd.action, {
          suspended: w.suspended,
          pendingExists: pendingIdx() >= 0,
          now: w.now,
          ttlSeconds: TTL,
        });
        if (step.ok)
          w.approvals.push({ action: step.action, status: "pending", requestedBy: op.sub, expiresAt: step.expiresAt });
        break;
      }
      case "approve":
      case "reject": {
        const i = pendingIdx();
        if (i < 0) break;
        const op = ops[cmd.by % ops.length] as Operator;
        const a = w.approvals[i] as Approval;
        const step =
          cmd.kind === "approve"
            ? approve(a, op, { suspended: w.suspended, now: w.now })
            : reject(a, op, { now: w.now });
        if (step.kind === "expire") w.approvals[i] = { ...a, status: "expired" };
        if (step.kind === "rejected")
          w.approvals[i] = { ...a, status: "rejected", decidedBy: op.sub, decidedAt: w.now };
        if (step.kind === "approved") {
          w.approvals[i] = { ...a, status: "approved", decidedBy: op.sub, decidedAt: w.now };
          w.suspended = a.action === "account.suspend";
          w.executions.push({
            action: a.action,
            requestedBy: a.requestedBy,
            decidedBy: op.sub,
            role: op.role,
            at: w.now,
            expiresAt: a.expiresAt,
          });
        }
        break;
      }
    }
  }
  return w;
}

const opArb = fc.record({
  sub: fc.constant(null).map(() => newId("usr")),
  role: fc.constantFrom("ops" as const, "ops_admin" as const),
});
const susCmd = fc.oneof(
  fc.record({
    kind: fc.constant("request" as const),
    by: fc.nat(10),
    action: fc.constantFrom<SuspensionAction>("suspend", "reinstate"),
  }),
  fc.record({ kind: fc.constant("approve" as const), by: fc.nat(10) }),
  fc.record({ kind: fc.constant("reject" as const), by: fc.nat(10) }),
  fc.record({ kind: fc.constant("tick" as const), seconds: fc.integer({ min: 1, max: 2 * TTL }) }),
  fc.constant({ kind: "sweep" as const }),
);

describe("two-person suspension", () => {
  it("never completes with one principal, whatever its role", () => {
    fc.assert(
      fc.property(opArb, fc.array(susCmd, { maxLength: 40 }), (op, cmds) => {
        const w = runSuspension([op], cmds);
        expect(w.executions).toEqual([]);
        expect(w.suspended).toBe(false);
        expect(w.approvals.every((a) => a.status !== "approved")).toBe(true);
      }),
    );
  });

  it("every execution has a different ops_admin approver and happens before expiry", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 2, maxLength: 4 }), fc.array(susCmd, { maxLength: 60 }), (ops, cmds) => {
        const w = runSuspension(ops, cmds);
        for (const x of w.executions) {
          expect(x.decidedBy).not.toBe(x.requestedBy);
          expect(x.role).toBe("ops_admin");
          expect(x.at).toBeLessThan(x.expiresAt);
        }
      }),
    );
  });

  it("at most one request is pending, and the state changes only through executions", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 4 }), fc.array(susCmd, { maxLength: 60 }), (ops, cmds) => {
        // replay step by step to check the invariants after every command
        for (let n = 0; n <= cmds.length; n++) {
          const w = runSuspension(ops, cmds.slice(0, n));
          expect(w.approvals.filter((a) => a.status === "pending").length).toBeLessThanOrEqual(1);
          const last = w.executions.at(-1);
          expect(w.suspended).toBe(last ? last.action === "account.suspend" : false);
          expect(w.executions.length).toBe(w.approvals.filter((a) => a.status === "approved").length);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("an expired request can never be approved, even by a valid second operator", () => {
    fc.assert(
      fc.property(opArb, fc.integer({ min: 0, max: 3 * TTL }), (requester, late) => {
        const admin: Operator = { sub: newId("usr"), role: "ops_admin" };
        const w = runSuspension(
          [requester, admin],
          [
            { kind: "request", by: 0, action: "suspend" },
            { kind: "tick", seconds: TTL + late },
            { kind: "approve", by: 1 },
          ],
        );
        expect(w.executions).toEqual([]);
        expect(w.suspended).toBe(false);
        expect(w.approvals.map((a) => a.status)).toEqual(["expired"]);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Screening fail-closed policy
// ---------------------------------------------------------------------------------------------

const facts: fc.Arbitrary<ScreeningFacts> = fc.record({
  livemode: fc.constant(true),
  sandboxBlocked: fc.boolean(),
  provider: fc.record({
    name: fc.constant("local"),
    hits: fc.subarray(["sanctions", "blocklist"]),
    unavailable: fc.option(fc.constant("sanctions_list_unavailable"), { nil: null }),
    risk: fc.constant(null),
  }),
  cached: fc.option(
    fc.record({
      decision: fc.constantFrom("allow" as const, "block" as const, "review" as const),
      reasons: fc.constant([]),
    }),
    { nil: null },
  ),
  amountUsdMicros: fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n }), { nil: null }),
  failClosedThresholdUsdMicros: fc.bigInt({ min: 0n, max: 10n ** 13n }),
});

describe("screening fail-closed policy", () => {
  it("a live payment at or above the threshold is never allowed by a degraded screen", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const o = decide(f);
        const large = f.amountUsdMicros !== null && f.amountUsdMicros >= f.failClosedThresholdUsdMicros;
        if (large && o.kind === "decided" && o.decision === "allow") {
          expect(f.provider.unavailable).toBeNull();
          expect(o.postScreenRequired).toBe(false);
        }
        if (large && f.provider.unavailable !== null && f.provider.hits.length === 0)
          expect(o).toEqual({ kind: "unavailable" });
      }),
    );
  });

  it("a degraded screen with an unknown amount fails closed (audit finding 9)", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const o = decide({ ...f, amountUsdMicros: null, provider: { ...f.provider, hits: [] } });
        if (f.provider.unavailable !== null) expect(o).toEqual({ kind: "unavailable" });
        else expect(o.kind).toBe("decided");
      }),
    );
  });

  it("an unavailable provider is never hidden by the cache, and never yields a cacheable allow", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const o = decide({ ...f, provider: { ...f.provider, hits: [], unavailable: "sanctions_list_unavailable" } });
        if (o.kind === "decided") {
          expect(o.cached).toBe(false);
          expect(o).toMatchObject({ decision: "allow", postScreenRequired: true });
        }
      }),
    );
  });

  it("a hit blocks, available or not, cached or not", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const o = decide({ ...f, provider: { ...f.provider, hits: ["blocklist"] } });
        expect(o).toMatchObject({ kind: "decided", decision: "block", cached: false });
      }),
    );
  });
});
