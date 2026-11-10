/**
 * KYB case state (compliance LLD §5, FR-CMP-01 as amended by ADR-0020, FR-ACC-05). Pure.
 *
 * Status values are unchanged since Stage 1; `pending` means "self-declared details submitted, not decided
 * yet". With `NP_KYB_MODE=auto` (default, open onboarding, ADR-0024) the system decides a submission in the
 * same transaction (`domain/kyb-case/auto.ts`: approved, or rejected on a geo-policy hit), so `pending` is
 * only seen in `manual` mode (or for a Stage 1 case without details).
 *
 * | from                          | command                         | guard                    | to          | event          |
 * |-------------------------------|---------------------------------|--------------------------|-------------|----------------|
 * | (none)                        | account created / start / edit  | —                        | not_started | —              |
 * | not_started · needs_info      | owner edits the profile         | —                        | unchanged   | —              |
 * | not_started · needs_info      | owner submits                   | profile complete         | pending     | kyb.submitted  |
 * | pending (auto mode)           | system: auto decision           | profile complete         | approved · rejected | kyb.<D> |
 * | pending · rejected            | console: approved               | profile complete         | approved    | kyb.approved   |
 * | pending · approved            | console: rejected               | —                        | rejected    | kyb.rejected   |
 * | pending · approved · rejected | console: needs_info             | `requested_info` given   | needs_info  | kyb.needs_info |
 * | D                             | console or manual: D            | —                        | unchanged (idempotent, no event)       |
 * | any                           | manual (Stage 1) decision D ≠ s | case exists              | D           | kyb.<D>        |
 *
 * The Stage 1 manual endpoint and the ops CLI keep their rules (any decision on an existing case), so
 * scripted onboarding keeps working; the console route follows the table. Ops may reverse an approval:
 * identity recomputes live mode from the event.
 */

export const KYB_STATUSES = ["not_started", "pending", "needs_info", "approved", "rejected"] as const;
export type KybStatus = (typeof KYB_STATUSES)[number];
export const KYB_DECISIONS = ["approved", "rejected", "needs_info"] as const;
export type KybDecision = (typeof KYB_DECISIONS)[number];

export type KybStep = { readonly changed: false } | { readonly changed: true; readonly to: KybStatus };

/** States in which the owner may edit and submit the declaration. */
export function isEditable(current: KybStatus): boolean {
  return current === "not_started" || current === "needs_info";
}

/**
 * `POST /v1/account/kyb` (Stage 1 route). Since Stage 2 it only creates/returns the case: `pending`
 * means "submitted", which needs a complete declaration (`submitKyb`). Kept as a function so the
 * rule is tested with the rest of the machine.
 */
export function startKyb(_current: KybStatus): KybStep {
  return { changed: false };
}

export type SubmitStep =
  | { readonly ok: true; readonly to: "pending" }
  | { readonly ok: false; readonly reason: "state" }
  | { readonly ok: false; readonly reason: "incomplete"; readonly missing: readonly string[] };

/** Owner submission: only from an editable state, and only with every required field declared. */
export function submitKyb(current: KybStatus, missing: readonly string[]): SubmitStep {
  if (!isEditable(current)) return { ok: false, reason: "state" };
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing };
  return { ok: true, to: "pending" };
}

/** Stage 1 manual decision (`decideKyb`, ops CLI): any decision on an existing case; repeats are no-ops. */
export function decideKyb(current: KybStatus, decision: KybDecision): KybStep {
  return current === decision ? { changed: false } : { changed: true, to: decision };
}

export type ConsoleDecisionStep =
  | KybStep
  | { readonly changed: false; readonly error: "state_conflict" | "requested_info_required" | "profile_incomplete" };

const CONSOLE_FROM: Record<KybDecision, readonly KybStatus[]> = {
  // `rejected`: an operator may reverse an abuse rejection or a geo auto-rejection (ADR-0024)
  approved: ["pending", "rejected"],
  rejected: ["pending", "approved"],
  needs_info: ["pending", "approved", "rejected"],
};

/**
 * Console decision (`decideOpsKybCase`): the manual rules plus the state table above. Approving needs a
 * complete declaration (a Stage 1 case started without details can sit in `pending` with none).
 */
export function decideConsole(
  current: KybStatus,
  decision: KybDecision,
  o: { requestedInfo: string | undefined; profileComplete: boolean },
): ConsoleDecisionStep {
  if (current === decision) return { changed: false };
  if (!CONSOLE_FROM[decision].includes(current)) return { changed: false, error: "state_conflict" };
  if (decision === "needs_info" && !o.requestedInfo?.trim())
    return { changed: false, error: "requested_info_required" };
  if (decision === "approved" && !o.profileComplete) return { changed: false, error: "profile_incomplete" };
  return { changed: true, to: decision };
}

/** Subject of the event a decision emits. */
export function kybSubject(decision: KybDecision): `evt.compliance.kyb.${KybDecision}` {
  return `evt.compliance.kyb.${decision}`;
}
