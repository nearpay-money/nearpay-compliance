/** Spec route bindings (compliance LLD §5). Auth and roles are enforced from the spec by the bootstrap. */
import { startKyb as startKybRoute } from "@nearpay/spec";
import { ApiError, implement, type RouteBinding } from "@nearpay-internal/service";
import {
  createScreening,
  decideKyb as decideKybRoute,
  getGeoPolicy as getGeoPolicyRoute,
} from "@nearpay-internal/spec";
import { getGeoPolicy } from "../app/admin.js";
import type { Compliance } from "../app/context.js";
import { decideKyb, startKyb } from "../app/kyb.js";
import { screen } from "../app/screening.js";

export function complianceRoutes(c: Compliance): RouteBinding[] {
  return [
    implement(createScreening, async (ctx) => screen(c, ctx.body)),
    implement(getGeoPolicyRoute, async () => getGeoPolicy(c)),
    implement(decideKybRoute, async (ctx) => {
      const actor = `ops:${ctx.principal?.sub ?? "unknown"}`;
      return decideKyb(c, ctx.params.id, ctx.body.decision, ctx.body.reason, actor);
    }),
    implement(startKybRoute, async (ctx) => {
      const acct = ctx.principal?.acct;
      if (!acct) throw new ApiError("permission_denied", { params: { action: "start KYB without an account" } });
      return startKyb(c, acct, `user:${ctx.principal?.sub}`);
    }),
  ];
}
