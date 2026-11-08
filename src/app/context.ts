/** Dependencies shared by compliance use cases. */
import type { EnvelopeCipher, Kysely, Transaction } from "@nearpay-internal/db";
import { emit, sql } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { Subject } from "@nearpay-internal/spec";
import type { OperatorDirectory } from "../infra/clients/identity.js";
import type { DB } from "../infra/db/schema.js";
import type { ScreeningProvider } from "./screening-provider.js";

export interface ComplianceMetrics {
  screenings(labels: { context: string; decision: string; provider: string; cached: string }): void;
  screeningSeconds(seconds: number): void;
  vendorUnavailable(): void;
}

export interface Compliance {
  readonly db: Kysely<DB>;
  readonly cipher: EnvelopeCipher;
  readonly log: Logger;
  readonly metrics: ComplianceMetrics;
  /** Live screening provider behind the vendor-neutral interface (v1: `local`). */
  readonly provider: ScreeningProvider;
  /** Lifetime of a pending two-person request (`NP_OPS_APPROVAL_TTL_SECONDS`, default 24 h). */
  readonly opsApprovalTtlSeconds: number;
  /** Identity's operator read (api only; spec 0.2.1 `assignOpsCase` check). Absent → assignment fails closed. */
  readonly operators?: OperatorDirectory;
}

export type Tx = Transaction<DB>;

export const noMetrics: ComplianceMetrics = {
  screenings() {},
  screeningSeconds() {},
  vendorUnavailable() {},
};

export function complianceMetrics(m: ServiceMetrics): ComplianceMetrics {
  const total = m.counter("screenings_total", "Screenings by context, decision, provider and cache use.", [
    "context",
    "decision",
    "provider",
    "cached",
  ]);
  const seconds = m.histogram("screening_duration_seconds", "Screening latency.");
  const unavailable = m.counter("vendor_unavailable_total", "Screenings refused because the vendor was unavailable.");
  return {
    screenings: (l) => total.inc(l),
    screeningSeconds: (s) => seconds.observe(s),
    vendorUnavailable: () => unavailable.inc(),
  };
}

export async function dbNow(db: Kysely<DB> | Tx): Promise<Date> {
  const r = await sql<{ now: Date }>`select now() as now`.execute(db);
  return (r.rows[0] as { now: Date }).now;
}

/** Writes a domain event to the outbox in `tx` (validated against the catalogue by the kit). */
export function emitEvent(
  tx: Tx,
  e: {
    subject: Subject;
    aggregate: { type: string; id: string; version: number };
    accountUuid: string | null;
    livemode: boolean | null;
    object: unknown;
    previous?: Record<string, unknown>;
  },
) {
  return emit(tx, {
    subject: e.subject,
    aggregate: e.aggregate,
    accountId: e.accountUuid,
    livemode: e.livemode,
    data: { object: e.object, ...(e.previous ? { previous: e.previous } : {}) },
  });
}
