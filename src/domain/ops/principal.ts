/**
 * Ops principals on console routes (compliance LLD §5.1, foundations §9). Pure.
 *
 * The service bootstrap verifies the token and its `ops:` scope. These checks repeat, in the handler,
 * the rules every console write depends on (fail closed even on a kit that does not enforce them
 * yet): an `ops` principal whose `sub` is an operator user id (`usr_…`), whose `ops_role` is one of
 * the route's `opsRoles`, and — on step-up routes — whose step-up is still fresh.
 */
import { isId } from "@nearpay-internal/ids";
import type { Operator, OpsRole } from "../ops-approval/approval.js";

export interface OpsClaims {
  readonly ptype: string;
  readonly sub: string;
  readonly ops_role?: string | undefined;
  readonly step_up_until?: number | undefined;
  /** Identity's extra claims of the adaptive two-person rule (active ops_admins, last verification). */
  readonly ops_admins?: unknown;
  readonly ops_auth_at?: unknown;
}

export interface OpsRouteRules {
  readonly opsRoles?: readonly string[] | undefined;
  readonly stepUp?: boolean | undefined;
}

export type OperatorCheck =
  | { readonly ok: true; readonly operator: Operator }
  | { readonly ok: false; readonly error: "permission_denied" | "step_up_required"; readonly reason: string };

const OPS_ROLES: readonly OpsRole[] = ["ops", "ops_admin"];

export function checkOperator(claims: OpsClaims | null, route: OpsRouteRules, nowSeconds: number): OperatorCheck {
  if (claims?.ptype !== "ops") return { ok: false, error: "permission_denied", reason: "act as an operator" };
  if (!isId("usr", claims.sub))
    return { ok: false, error: "permission_denied", reason: "act without an operator user id" };
  const role = claims.ops_role as OpsRole | undefined;
  if (!role || !OPS_ROLES.includes(role))
    return { ok: false, error: "permission_denied", reason: "act without a console role" };
  if (!route.opsRoles?.includes(role))
    return { ok: false, error: "permission_denied", reason: `call this route as ${role}` };
  if (route.stepUp && !(claims.step_up_until !== undefined && claims.step_up_until > nowSeconds))
    return { ok: false, error: "step_up_required", reason: "step-up is not fresh" };
  // malformed extra claims count as absent (two-person applies; fail closed)
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const admins = int(claims.ops_admins);
  const authAt = int(claims.ops_auth_at);
  return {
    ok: true,
    operator: {
      sub: claims.sub,
      role,
      ...(admins !== undefined ? { activeAdmins: admins } : {}),
      ...(authAt !== undefined ? { authAt } : {}),
    },
  };
}
