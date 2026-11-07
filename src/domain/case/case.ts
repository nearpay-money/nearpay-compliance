/**
 * Compliance cases and reviews (compliance LLD §3, §5.1, §6, FR-CMP-04). Pure.
 *
 * A case about a payment (a rails execution or an agent payment) is a *review*: opening it emits
 * `evt.compliance.review.opened` and closing it `review.closed` (payments flags the intent; the
 * payment stands — INV-1, NearPay cannot claw funds back). Cases about destinations, accounts or
 * reconciliation runs are ops-internal (no review events).
 *
 * | from          | command            | to            |
 * |---------------|--------------------|---------------|
 * | open          | assign (operator)  | investigating |
 * | investigating | assign / unassign  | investigating |
 * | open          | unassign           | open          |
 * | open · inv.   | investigate (CLI)  | investigating |
 * | open · inv.   | close (resolution) | closed        |
 * | closed        | any but comment    | refused (state_conflict) |
 */

export const CASE_KINDS = [
  "screening_hit",
  "post_screen_hit",
  "held_execution",
  "audit_mismatch",
  "merchant_report",
  "reconciliation_diff",
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type CaseStatus = "open" | "investigating" | "closed";
export type SubjectType =
  | "execution"
  | "agent_payment"
  | "payment_intent"
  | "settlement_destination"
  | "account"
  | "reconciliation_run";
export const RESOLUTIONS = [
  "no_action",
  "false_positive",
  "merchant_contacted",
  "destination_blocked",
  "account_suspended",
  "other",
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export interface CaseSubject {
  readonly type: SubjectType;
  readonly id: string;
}

const REVIEW_SUBJECTS = new Set<string>(["execution", "agent_payment", "payment_intent"]);
/** Review reasons the event catalogue knows (`Review.reason`). */
const REVIEW_REASONS = new Set<string>(["post_screen_hit", "held_execution", "audit_mismatch", "screening_hit"]);

export function isReview(kind: string, subject: { readonly type: string; readonly id?: string }): boolean {
  return REVIEW_SUBJECTS.has(subject.type) && REVIEW_REASONS.has(kind);
}

/**
 * Severity: audit mismatches are critical (independent evidence disagrees, ADR-0012); a held live
 * execution, a live sanctions hit and a reconciliation difference are high; anything in test mode is low.
 */
export function severityOf(kind: CaseKind, livemode: boolean): Severity {
  if (!livemode) return "low";
  switch (kind) {
    case "audit_mismatch":
      return "critical";
    case "held_execution":
    case "post_screen_hit":
    case "screening_hit":
    case "reconciliation_diff":
      return "high";
    case "merchant_report":
      return "medium";
  }
}

/** Ordering of the console queue: highest severity first. */
export function severityRank(s: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(s);
  return i < 0 ? 0 : i + 1;
}

export type CaseStep = { readonly ok: true; readonly to: CaseStatus } | { readonly ok: false; readonly reason: string };

/** Stage 1 status change (ops CLI `case-investigate` / `case-close`). */
export function transitionCase(current: CaseStatus, to: CaseStatus): CaseStep {
  if (current === "closed") return { ok: false, reason: "the case is closed" };
  if (current === to) return { ok: false, reason: `the case is already ${to}` };
  return { ok: true, to };
}

/** Console assignment: assigning an open case starts the investigation; a closed case cannot change. */
export function assignCase(current: CaseStatus, assignee: string | null): CaseStep {
  if (current === "closed") return { ok: false, reason: "the case is closed" };
  if (assignee !== null) return { ok: true, to: "investigating" };
  return { ok: true, to: current };
}

/** Console close: any open or investigating case, once. */
export function closeCase(current: CaseStatus): CaseStep {
  return current === "closed" ? { ok: false, reason: "the case is closed" } : { ok: true, to: "closed" };
}

/** Stored resolutions: the console stores the enum; the Stage 1 CLI stored free text (rendered `other`). */
export function resolutionOf(stored: string | null): Resolution | null {
  if (stored === null) return null;
  return (RESOLUTIONS as readonly string[]).includes(stored) ? (stored as Resolution) : "other";
}

/** Timeline action names of the API (`ComplianceCase.events[].action`) for stored case events. */
export function timelineAction(stored: string): "opened" | "assigned" | "unassigned" | "commented" | "closed" {
  switch (stored) {
    case "opened":
    case "assigned":
    case "unassigned":
    case "closed":
      return stored;
    case "investigating": // Stage 1 CLI `case-investigate`
      return "assigned";
    default: // `note` (CLI), `commented`
      return "commented";
  }
}
