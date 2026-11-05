/**
 * Compliance cases and reviews (compliance LLD §3, §6, FR-CMP-04). Pure.
 *
 * A case about a payment (a rails execution or an agent payment) is a *review*: opening it emits
 * `evt.compliance.review.opened` and closing it `review.closed` (payments flags the intent; the
 * payment stands — INV-1, NearPay cannot claw funds back). Cases about destinations or accounts are
 * ops-internal (no review events).
 */

export type CaseKind = "screening_hit" | "post_screen_hit" | "held_execution" | "audit_mismatch" | "merchant_report";
export type Severity = "low" | "medium" | "high" | "critical";
export type CaseStatus = "open" | "investigating" | "closed";
export type SubjectType = "execution" | "agent_payment" | "payment_intent" | "settlement_destination" | "account";

export interface CaseSubject {
  readonly type: SubjectType;
  readonly id: string;
}

const REVIEW_SUBJECTS = new Set<SubjectType>(["execution", "agent_payment", "payment_intent"]);
/** Review reasons the event catalogue knows (`Review.reason`). */
const REVIEW_REASONS = new Set<CaseKind>(["post_screen_hit", "held_execution", "audit_mismatch", "screening_hit"]);

export function isReview(kind: CaseKind, subject: CaseSubject): boolean {
  return REVIEW_SUBJECTS.has(subject.type) && REVIEW_REASONS.has(kind);
}

/**
 * Severity: audit mismatches are critical (independent evidence disagrees, ADR-0012); a held live
 * execution is high (funds are somewhere and need an operator); sanctions hits are high in live mode;
 * anything in test mode is low.
 */
export function severityOf(kind: CaseKind, livemode: boolean): Severity {
  if (!livemode) return "low";
  switch (kind) {
    case "audit_mismatch":
      return "critical";
    case "held_execution":
    case "post_screen_hit":
    case "screening_hit":
      return "high";
    case "merchant_report":
      return "medium";
  }
}

export type CaseStep = { readonly ok: true; readonly to: CaseStatus } | { readonly ok: false; readonly reason: string };

export function transitionCase(current: CaseStatus, to: CaseStatus): CaseStep {
  if (current === "closed") return { ok: false, reason: "the case is closed" };
  if (current === to) return { ok: false, reason: `the case is already ${to}` };
  return { ok: true, to };
}
