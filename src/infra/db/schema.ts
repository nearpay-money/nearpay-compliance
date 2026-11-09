/** Kysely table types (migrations/0001_compliance.sql, 0002_stage2_console.sql, 0003_blocklist_soft_delete.sql). */
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
  id: Generated<string>;
  chain: ColumnType<string | null, string | null | undefined, string | null>;
  /** Soft delete (0003): a removed entry stays as history and no longer screens. */
  removed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  removed_by: ColumnType<string | null, string | null | undefined, string | null>;
  removal_note: ColumnType<string | null, string | null | undefined, string | null>;
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
  requested_by: ColumnType<string | null, string | null | undefined, string | null>;
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
  profile_enc: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  declared_by: ColumnType<string | null, string | null | undefined, string | null>;
  requested_info: ColumnType<string | null, string | null | undefined, string | null>;
  submitted_at: NullableTimestamp;
  account_display_name: ColumnType<string | null, string | null | undefined, string | null>;
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
  assignee: ColumnType<string | null, string | null | undefined, string | null>;
  payment_intent: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Migration 0004 (spec 0.2.1): display names from identity's account events. */
export interface AccountNamesTable {
  account_id: string;
  display_name: string;
  version: number;
  updated_at: Generated<Date>;
}

export interface CaseEventsTable {
  id: string;
  case_id: string;
  actor: string;
  action: string;
  note_enc: Buffer | null;
  created_at: Timestamp;
}

export type OpsActionDetails = Record<string, string | number | boolean | null>;

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

export interface OpsApprovalsTable {
  id: string;
  action: "account.suspend" | "account.reinstate";
  account_id: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requested_by: string;
  requested_role: "ops" | "ops_admin";
  requested_at: Timestamp;
  decided_by: ColumnType<string | null, string | null | undefined, string | null>;
  decided_role: ColumnType<
    "ops" | "ops_admin" | null,
    "ops" | "ops_admin" | null | undefined,
    "ops" | "ops_admin" | null
  >;
  decided_at: NullableTimestamp;
  decision_note: ColumnType<string | null, string | null | undefined, string | null>;
  /** Migration 0005: active `ops_admin` operators when requested (null: unknown → two-person). */
  requested_admins: ColumnType<number | null, number | null | undefined, number | null>;
  /** Migration 0005: approved by its requester on a single-operator platform. */
  single_operator: ColumnType<boolean, boolean | undefined, boolean>;
  expires_at: Timestamp;
}

export interface OpsActionsTable {
  id: string;
  actor_sub: string;
  actor_role: "ops" | "ops_admin";
  action: string;
  target_type: string;
  target_id: string;
  account_id: string | null;
  approval_id: string | null;
  note_enc: Buffer | null;
  created_at: Timestamp;
  /** Internal structured details (0003), never published. */
  details: ColumnType<OpsActionDetails | null, string | null | undefined, never>;
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
  account_names: AccountNamesTable;
  case_events: CaseEventsTable;
  monitored_destinations: MonitoredDestinationsTable;
  account_flags: AccountFlagsTable;
  ops_approvals: OpsApprovalsTable;
  ops_actions: OpsActionsTable;
}

export type DB = ComplianceTables & KitTables;
