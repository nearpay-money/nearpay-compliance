/**
 * KYB case state (compliance LLD §3, FR-CMP-01, FR-ACC-05). Pure.
 *
 * | from          | command                | to                                   | event            |
 * |---------------|------------------------|--------------------------------------|------------------|
 * | (none)        | account created        | not_started                          | —                |
 * | not_started   | owner starts KYB       | pending                              | —                |
 * | needs_info    | owner starts KYB       | pending                              | —                |
 * | pending/other | owner starts KYB       | unchanged                            | —                |
 * | any           | ops decision D ≠ state | D (approved / rejected / needs_info) | kyb.<D>          |
 * | D             | ops decision D         | unchanged (idempotent, no event)     | —                |
 *
 * Ops may reverse a decision (e.g. revoke an approval): identity recomputes live mode from the event.
 */

export const KYB_STATUSES = ["not_started", "pending", "needs_info", "approved", "rejected"] as const;
export type KybStatus = (typeof KYB_STATUSES)[number];
export type KybDecision = "approved" | "rejected" | "needs_info";

export type KybStep = { readonly changed: false } | { readonly changed: true; readonly to: KybStatus };

export function startKyb(current: KybStatus): KybStep {
  return current === "not_started" || current === "needs_info" ? { changed: true, to: "pending" } : { changed: false };
}

export function decideKyb(current: KybStatus, decision: KybDecision): KybStep {
  return current === decision ? { changed: false } : { changed: true, to: decision };
}

/** Subject of the event a decision emits. */
export function kybSubject(decision: KybDecision): `evt.compliance.kyb.${KybDecision}` {
  return `evt.compliance.kyb.${decision}`;
}
