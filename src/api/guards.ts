/**
 * Route guards for principals without an account (compliance LLD §5.1).
 *
 * - `operator(ctx)`: the verified ops principal of a console route as an `Operator`, re-checking
 *   `opsRoles` and step-up from the route definition (fail closed, whatever the kit enforces).
 * - `withPrincipalIdempotency`: api-conventions §4 for ops and service principals. The bootstrap's
 *   automatic idempotency is scoped to an account (`principal.acct`); console and service calls have
 *   none, so their keys are scoped to the principal (`ops:<sub>` / `service:<sub>`) in the same
 *   `idempotency_keys` table (same 24 h retention, same replay and conflict rules).
 */
import { createHash } from "node:crypto";
import { idempotencyStore } from "@nearpay-internal/db";
import { ApiError, type RequestContext, respond } from "@nearpay-internal/service";
import type { AnyRoute } from "@nearpay-money/spec";
import type { Compliance } from "../app/context.js";
import { checkOperator } from "../domain/ops/principal.js";
import type { Operator } from "../domain/ops-approval/approval.js";

export function operator(ctx: RequestContext<AnyRoute>): Operator {
  const r = checkOperator(ctx.principal, ctx.route, Math.floor(Date.now() / 1000));
  if (!r.ok) {
    if (r.error === "step_up_required") throw new ApiError("step_up_required");
    throw new ApiError("permission_denied", { params: { action: r.reason } });
  }
  return r.operator;
}

/** Deterministic pseudo-account uuid of a principal namespace (never collides with a UUIDv7 account id). */
export function principalNamespace(ns: string): string {
  const h = createHash("sha256").update(`compliance-idempotency:${ns}`).digest("hex");
  // version nibble 8 (custom, RFC 9562): account ids are UUIDv7, so the scopes cannot overlap
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function withPrincipalIdempotency<T>(
  c: Compliance,
  ctx: RequestContext<AnyRoute>,
  namespace: string,
  status: 200 | 201 | 202 | 204,
  fn: () => Promise<T>,
) {
  const key = ctx.idempotencyKey;
  if (!key) return respond(status, await fn());
  const r = await idempotencyStore(c.db, c.cipher).run(
    {
      accountId: principalNamespace(namespace),
      livemode: false,
      key,
      method: ctx.request.method,
      path: ctx.request.url.split("?")[0] as string,
      body: ctx.request.body ?? null,
    },
    async () => ({ status, body: (await fn()) ?? null }),
  );
  const headers: Record<string, string> = r.replayed ? { "Idempotent-Replayed": "true" } : {};
  return respond(r.status as 200 | 201 | 202 | 204, (r.status === 204 ? undefined : r.body) as T, headers);
}
