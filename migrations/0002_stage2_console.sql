-- nearpay-compliance Stage 2 (lld/compliance.md v1.6 §3; ADR-0020): self-declared KYB profile, console
-- case management, blocklist ids, two-person suspension approvals and the operator-action log.
-- Additive and forward-only: no Stage 1 column is dropped or renamed.

-- KYB: self-declared minimum business details instead of vendor columns (vendor, vendor_applicant_id
-- and level stay, always null, until a later migration drops them).
alter table kyb_cases
  add column profile_enc bytea,                          -- envelope-encrypted JSON `KybProfile` (personal data)
  add column declared_by uuid,                           -- owner (user id) who submitted the declaration
  add column requested_info text,                        -- what ops asked for while needs_info (shown to the merchant)
  add column submitted_at timestamptz,
  add column account_display_name text;                  -- from evt.identity.account.created (console queue)
create index kyb_cases_queue on kyb_cases (status, (coalesce(submitted_at, created_at)), id);

-- Blocklist: API ids (bl_) and an optional chain for console entries.
alter table blocklist
  add column id uuid not null unique default gen_random_uuid(),
  add column chain text;
create index blocklist_created on blocklist (created_at desc, id desc);

-- Screenings: who asked (ops lookups record the operator).
alter table screenings add column requested_by text;

-- Cases: console assignment, the payments reconciliation kind, and the payment intent of execution reviews.
alter table cases
  add column assignee uuid,
  add column payment_intent text;                        -- pi_… from Execution.reference (Review.payment_intent)
alter table cases drop constraint cases_kind_check;
alter table cases add constraint cases_kind_check check (kind in
  ('screening_hit','post_screen_hit','held_execution','audit_mismatch','merchant_report','reconciliation_diff'));

-- Two-person rule for account suspend/reinstate (`OpsApproval`, opa_). The server enforces the rule on the
-- verified ops principal; the checks repeat it: an approved request has an ops_admin approver who is a
-- different operator than the requester. (A requester may still withdraw their own request: reject.)
create table ops_approvals (
  id uuid primary key,
  action text not null check (action in ('account.suspend','account.reinstate')),
  account_id uuid not null,
  reason text not null,
  status text not null check (status in ('pending','approved','rejected','expired')),
  requested_by uuid not null,
  requested_role text not null check (requested_role in ('ops','ops_admin')),
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_role text check (decided_role in ('ops','ops_admin')),
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz not null,
  check (expires_at > requested_at),
  check (status <> 'approved' or (decided_by is not null and decided_by <> requested_by and decided_role = 'ops_admin')),
  check (status not in ('approved','rejected') or (decided_by is not null and decided_at is not null)));
create unique index ops_approvals_one_pending on ops_approvals (account_id) where status = 'pending';
create index ops_approvals_account on ops_approvals (account_id, requested_at desc);
create index ops_approvals_expiry on ops_approvals (expires_at) where status = 'pending';

-- Operator actions (INV-9, T-12): append-only log of every console write; the same ids are published as
-- evt.compliance.ops_action.recorded (outbox, same transaction). Notes are envelope-encrypted.
create table ops_actions (
  id uuid primary key,
  actor_sub uuid not null,
  actor_role text not null check (actor_role in ('ops','ops_admin')),
  action text not null,
  target_type text not null,
  target_id text not null,
  account_id uuid,
  approval_id uuid,
  note_enc bytea,
  created_at timestamptz not null default now());
create index ops_actions_target on ops_actions (target_type, target_id, created_at);
