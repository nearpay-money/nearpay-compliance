-- nearpay-compliance (lld/compliance.md §3): policies, sanctions list, blocklist, screenings (cache and
-- audit), KYB cases, compliance cases, monitored destinations, account flags.

create table policies (
  id text primary key,                                   -- 'default', later per jurisdiction
  uid uuid not null unique,                              -- pol_ id (aggregate id of policy events)
  fail_closed_threshold_usd_micros bigint not null default 1000000000,   -- USD 1,000
  blocked_countries char(2)[] not null default '{CU,IR,KP,SY}',
  blocked_regions text[] not null default '{UA-43,UA-14,UA-09}',          -- Crimea, Donetsk, Luhansk (ISO 3166-2)
  kyb_required_for_live boolean not null default true,
  retention_years smallint not null default 5 check (retention_years between 1 and 30),
  version integer not null default 1,
  updated_at timestamptz not null default now());
insert into policies (id, uid) values ('default', gen_random_uuid());

-- OFAC SDN digital-currency addresses (SP-15) and vendor deltas.
create table sanctions_entries (
  chain_family text not null,                            -- evm | bitcoin | solana | tron | other
  address_norm text not null,                            -- lower-case for EVM, as published otherwise
  source text not null,                                  -- 'ofac_sdn'
  currency text not null,                                -- OFAC feature code (XBT, ETH, USDT, …)
  listed_at date,
  primary key (chain_family, address_norm));
-- subjects on chains the registry does not know are matched in any family
create index sanctions_entries_address on sanctions_entries (address_norm);

create table sanctions_lists (
  source text primary key,
  fetched_at timestamptz not null,
  entries integer not null,
  sha256 bytea not null);

create table blocklist (
  subject_type text not null check (subject_type in ('address','near_account','destination')),
  subject text not null,                                 -- normalised subject
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (subject_type, subject));

create table screenings (
  id uuid primary key,
  subject_type text not null check (subject_type in ('address','near_account','destination')),
  chain text,
  subject_norm text not null,
  context text not null,
  account_id uuid,
  livemode boolean not null,
  decision text not null check (decision in ('allow','block','review')),
  risk text,
  reasons text[] not null default '{}',
  provider text not null,
  post_screen_required boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now());
create index screenings_cache on screenings (subject_type, coalesce(chain, ''), subject_norm, livemode, expires_at desc);
create index screenings_created on screenings (created_at);

create table kyb_cases (
  id uuid primary key,
  account_id uuid not null unique,
  status text not null check (status in ('not_started','pending','needs_info','approved','rejected')),
  vendor text,
  vendor_applicant_id text,
  level text,
  decision_reason text,
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 0);

create table kyb_case_transitions (
  id uuid primary key,
  kyb_case_id uuid not null references kyb_cases(id),
  from_state text,
  to_state text not null,
  cause text not null,
  actor text not null,
  evidence jsonb,
  created_at timestamptz not null default now());
create index kyb_case_transitions_case on kyb_case_transitions (kyb_case_id, created_at);

create table cases (
  id uuid primary key,
  account_id uuid,
  livemode boolean not null,
  kind text not null check (kind in ('screening_hit','post_screen_hit','held_execution','audit_mismatch','merchant_report')),
  subject jsonb not null,                                -- {type, id}
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null check (status in ('open','investigating','closed')),
  resolution text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  version integer not null default 0);
-- one open case per (kind, subject): redeliveries and repeated hits never duplicate cases
create unique index cases_open_once on cases (kind, (subject->>'type'), (subject->>'id')) where status <> 'closed';
create index cases_status on cases (status, created_at desc);

create table case_events (
  id uuid primary key,
  case_id uuid not null references cases(id),
  actor text not null,
  action text not null,
  note_enc bytea,                                        -- envelope-encrypted (case notes may hold PII)
  created_at timestamptz not null default now());
create index case_events_case on case_events (case_id, created_at);

create table monitored_destinations (
  destination_id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  chain text not null,
  address_norm text not null,
  asset_id text not null,
  type text not null,
  active boolean not null,
  source_version integer not null,                       -- identity aggregate version last applied
  last_screened_at timestamptz,
  updated_at timestamptz not null default now());
create index monitored_active on monitored_destinations (active, last_screened_at) where active;
create index monitored_address on monitored_destinations (address_norm) where active;

create table account_flags (
  account_id uuid primary key,
  suspended boolean not null,
  reason text not null,
  actor text not null,
  version integer not null default 1,
  updated_at timestamptz not null default now());
