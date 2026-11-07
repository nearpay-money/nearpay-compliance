/**
 * Spec route bindings (compliance LLD §5, §5.1). Auth, roles, scopes and step-up are enforced from the
 * spec by the bootstrap; console handlers additionally resolve the operator (`operator`) and scope
 * Idempotency-Keys to principals without an account (`withPrincipalIdempotency`).
 */
import {
  type AnyRoute,
  getKyb as getKybRoute,
  startKyb as startKybRoute,
  submitKyb as submitKybRoute,
  updateKybProfile as updateKybProfileRoute,
} from "@nearpay/spec";
import { ApiError, implement, type RequestContext, type Responded, type RouteBinding } from "@nearpay-internal/service";
import {
  addOpsBlocklistEntry as addOpsBlocklistEntryRoute,
  approveOpsSuspensionRequest,
  assignOpsCase as assignOpsCaseRoute,
  closeOpsCase as closeOpsCaseRoute,
  commentOpsCase as commentOpsCaseRoute,
  createInternalCase as createInternalCaseRoute,
  createOpsRescreen as createOpsRescreenRoute,
  createOpsScreening as createOpsScreeningRoute,
  createOpsSuspensionRequest,
  createScreening,
  decideKyb as decideKybRoute,
  decideOpsKybCase as decideOpsKybCaseRoute,
  getGeoPolicy as getGeoPolicyRoute,
  getInternalKybCase as getInternalKybCaseRoute,
  getOpsCase as getOpsCaseRoute,
  getOpsKybCase as getOpsKybCaseRoute,
  getOpsMerchantSuspension,
  listOpsBlocklist as listOpsBlocklistRoute,
  listOpsCases as listOpsCasesRoute,
  listOpsKybCases as listOpsKybCasesRoute,
  rejectOpsSuspensionRequest,
  removeOpsBlocklistEntry as removeOpsBlocklistEntryRoute,
} from "@nearpay-internal/spec";
import {
  addOpsBlocklistEntry,
  createOpsRescreen,
  createOpsScreening,
  getGeoPolicy,
  listOpsBlocklist,
  removeOpsBlocklistEntry,
} from "../app/admin.js";
import {
  assignOpsCase,
  closeOpsCase,
  commentOpsCase,
  createInternalCase,
  getOpsCase,
  listOpsCases,
} from "../app/cases.js";
import type { Compliance } from "../app/context.js";
import {
  decideKyb,
  decideOpsKybCase,
  getInternalKybCase,
  getKyb,
  getOpsKybCase,
  listOpsKybCases,
  startKyb,
  submitKyb,
  updateKybProfile,
} from "../app/kyb.js";
import { screen } from "../app/screening.js";
import {
  approveSuspensionRequest,
  createSuspensionRequest,
  getMerchantSuspension,
  rejectSuspensionRequest,
} from "../app/suspension.js";
import { operator, withPrincipalIdempotency } from "./guards.js";

const ctxOf = (ctx: unknown) => ctx as RequestContext<AnyRoute>;

function accountOf(ctx: { principal: { acct?: string | undefined } | null }, action: string): string {
  const acct = ctx.principal?.acct;
  if (!acct) throw new ApiError("permission_denied", { params: { action } });
  return acct;
}

const pathOf = (ctx: RequestContext<AnyRoute>) => ctx.request.url.split("?")[0] as string;

export function complianceRoutes(c: Compliance): RouteBinding[] {
  /** Console write: operator check, then principal-scoped idempotency. */
  const opsWrite = <T>(
    rawCtx: unknown,
    status: 200 | 201 | 202 | 204,
    fn: (op: ReturnType<typeof operator>) => Promise<T>,
  ) => {
    const ctx = ctxOf(rawCtx);
    const op = operator(ctx);
    return withPrincipalIdempotency(c, ctx, `ops:${op.sub}`, status, () => fn(op));
  };
  const opsRead = (rawCtx: unknown) => operator(ctxOf(rawCtx));

  return [
    // ---- internal (services) ------------------------------------------------------------------
    implement(createScreening, async (ctx) => screen(c, ctx.body)),
    implement(getGeoPolicyRoute, async () => getGeoPolicy(c)),
    implement(getInternalKybCaseRoute, async (ctx) => getInternalKybCase(c, ctx.params.id)),
    implement(createInternalCaseRoute, async (ctx) => {
      const caller = ctx.principal?.sub ?? "unknown";
      return withPrincipalIdempotency(c, ctxOf(ctx), `service:${caller}`, 201, () =>
        createInternalCase(c, caller, ctx.body),
      );
    }),
    // Stage 1 manual decision (ops CLI path, testbed onboarding): unchanged rules.
    implement(decideKybRoute, async (ctx) => {
      const actor = `ops:${ctx.principal?.sub ?? "unknown"}`;
      return decideKyb(c, ctx.params.id, ctx.body.decision, ctx.body.reason, actor);
    }),

    // ---- dashboard (session owner/admin) ------------------------------------------------------
    implement(startKybRoute, async (ctx) =>
      startKyb(c, accountOf(ctx, "start KYB without an account"), `user:${ctx.principal?.sub}`),
    ),
    implement(getKybRoute, async (ctx) => getKyb(c, accountOf(ctx, "read KYB without an account"))),
    implement(updateKybProfileRoute, async (ctx) =>
      updateKybProfile(c, accountOf(ctx, "update KYB without an account"), ctx.body, `user:${ctx.principal?.sub}`),
    ),
    implement(submitKybRoute, async (ctx) =>
      submitKyb(c, accountOf(ctx, "submit KYB without an account"), ctx.principal?.sub ?? ""),
    ),

    // ---- console: KYB ----------------------------------------------------------------------------
    implement(listOpsKybCasesRoute, async (ctx) => {
      opsRead(ctx);
      return listOpsKybCases(c, ctx.query, pathOf(ctxOf(ctx)));
    }),
    implement(getOpsKybCaseRoute, async (ctx) => {
      opsRead(ctx);
      return getOpsKybCase(c, ctx.params.id);
    }),
    implement(decideOpsKybCaseRoute, async (ctx) =>
      opsWrite(ctx, 200, (op) => decideOpsKybCase(c, op, ctx.params.id, ctx.body)),
    ),

    // ---- console: cases ----------------------------------------------------------------------------
    implement(listOpsCasesRoute, async (ctx) => {
      opsRead(ctx);
      return listOpsCases(c, ctx.query, pathOf(ctxOf(ctx)));
    }),
    implement(getOpsCaseRoute, async (ctx) => {
      opsRead(ctx);
      return getOpsCase(c, ctx.params.id);
    }),
    implement(assignOpsCaseRoute, async (ctx) =>
      opsWrite(ctx, 200, (op) => assignOpsCase(c, op, ctx.params.id, ctx.body.assignee)),
    ),
    implement(commentOpsCaseRoute, async (ctx) =>
      opsWrite(ctx, 200, (op) => commentOpsCase(c, op, ctx.params.id, ctx.body.note)),
    ),
    implement(closeOpsCaseRoute, async (ctx) =>
      opsWrite(ctx, 200, (op) => closeOpsCase(c, op, ctx.params.id, ctx.body.resolution, ctx.body.note)),
    ),

    // ---- console: blocklist, screening, re-screening --------------------------------------------
    implement(listOpsBlocklistRoute, async (ctx) => {
      opsRead(ctx);
      return listOpsBlocklist(c, ctx.query, pathOf(ctxOf(ctx)));
    }),
    implement(addOpsBlocklistEntryRoute, async (ctx) =>
      opsWrite(ctx, 201, (op) => addOpsBlocklistEntry(c, op, ctx.body)),
    ),
    implement(
      removeOpsBlocklistEntryRoute,
      async (ctx) =>
        opsWrite(ctx, 204, (op) => removeOpsBlocklistEntry(c, op, ctx.params.id, ctx.body.reason)) as Promise<
          Responded<undefined>
        >,
    ),
    implement(createOpsScreeningRoute, async (ctx) => opsWrite(ctx, 200, (op) => createOpsScreening(c, op, ctx.body))),
    implement(createOpsRescreenRoute, async (ctx) =>
      opsWrite(ctx, 202, (op) => createOpsRescreen(c, op, ctx.body.account)),
    ),

    // ---- console: merchant suspension (two-person rule) -----------------------------------------
    implement(getOpsMerchantSuspension, async (ctx) => {
      opsRead(ctx);
      return getMerchantSuspension(c, ctx.params.id);
    }),
    implement(createOpsSuspensionRequest, async (ctx) =>
      opsWrite(ctx, 201, (op) => createSuspensionRequest(c, op, ctx.params.id, ctx.body.action, ctx.body.reason)),
    ),
    implement(approveOpsSuspensionRequest, async (ctx) =>
      opsWrite(ctx, 200, (op) => approveSuspensionRequest(c, op, ctx.params.id, ctx.params.request, ctx.body.note)),
    ),
    implement(rejectOpsSuspensionRequest, async (ctx) =>
      opsWrite(ctx, 200, (op) => rejectSuspensionRequest(c, op, ctx.params.id, ctx.params.request, ctx.body.note)),
    ),
  ];
}
