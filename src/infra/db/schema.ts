/** Kysely table types (migrations/0001_compliance.sql). */
import type { ColumnType, Generated, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;
type TextArray = ColumnType<string[], string[] | undefined, string[]>;

export interface PoliciesTable {
  id: string;
  uid: string;
  fail_closed_threshold_usd_micros: ColumnType<bigint, bigint | string | undefined, bigint | string>;
  blocked_countries: TextArray;
  blocked_regions: TextArray;
  kyb_required_for_live: Generated<boolean>;
  retention_years: Generated<number>;
  version: Generated<number>;
  updated_at: Timestamp;
}

export interface SanctionsEntriesTable {
  chain_family: string;
  address_norm: string;
  source: string;
  currency: string;
  listed_at: ColumnType<Date | null, string | null | undefined, string | null>;
}

export interface SanctionsListsTable {
  source: string;
  fetched_at: Timestamp;
  entries: number;
  sha256: Buffer;
}

export interface BlocklistTable {
  subject_type: string;
  subject: string;
  reason: string;
  created_by: string;
  created_at: Timestamp;
}

export interface ScreeningsTable {
  id: string;
  subject_type: string;
  chain: string | null;
  subject_norm: string;
  context: string;
  account_id: string | null;
  livemode: boolean;
  decision: "allow" | "block" | "review";
  risk: string | null;
  reasons: TextArray;
  provider: string;
  post_screen_required: Generated<boolean>;
  expires_at: Timestamp;
  created_at: Timestamp;
}

export interface KybCasesTable {
  id: string;
  account_id: string;
  status: string;
  vendor: string | null;
  vendor_applicant_id: string | null;
  level: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  created_at: Timestamp;
  decided_at: NullableTimestamp;
  updated_at: Timestamp;
  version: Generated<number>;
}

export interface KybCaseTransitionsTable {
  id: string;
  kyb_case_id: string;
  from_state: string | null;
  to_state: string;
  cause: string;
  actor: string;
  evidence: ColumnType<unknown | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface CasesTable {
  id: string;
  account_id: string | null;
  livemode: boolean;
  kind: string;
  subject: Json<{ type: string; id: string }>;
  severity: string;
  status: string;
  resolution: string | null;
  created_at: Timestamp;
  closed_at: NullableTimestamp;
  version: Generated<number>;
}

export interface CaseEventsTable {
  id: string;
  case_id: string;
  actor: string;
  action: string;
  note_enc: Buffer | null;
  created_at: Timestamp;
}

export interface MonitoredDestinationsTable {
  destination_id: string;
  account_id: string;
  livemode: boolean;
  chain: string;
  address_norm: string;
  asset_id: string;
  type: string;
  active: boolean;
  source_version: number;
  last_screened_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface AccountFlagsTable {
  account_id: string;
  suspended: boolean;
  reason: string;
  actor: string;
  version: Generated<number>;
  updated_at: Timestamp;
}

export interface ComplianceTables {
  policies: PoliciesTable;
  sanctions_entries: SanctionsEntriesTable;
  sanctions_lists: SanctionsListsTable;
  blocklist: BlocklistTable;
  screenings: ScreeningsTable;
  kyb_cases: KybCasesTable;
  kyb_case_transitions: KybCaseTransitionsTable;
  cases: CasesTable;
  case_events: CaseEventsTable;
  monitored_destinations: MonitoredDestinationsTable;
  account_flags: AccountFlagsTable;
}

export type DB = ComplianceTables & KitTables;
