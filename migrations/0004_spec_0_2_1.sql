-- nearpay-compliance, spec 0.2.1 (lld/compliance.md §"Spec 0.2.1 contract changes"). Additive, forward-only.

-- Account display names from `evt.identity.account.created` / `.updated` (ComplianceCase
-- `account_display_name`; the KYB queue keeps its own copy in kyb_cases). `version` is the identity
-- aggregate version: an older or redelivered event never overwrites a newer name.
create table account_names (
  account_id uuid primary key,
  display_name text not null,
  version integer not null,
  updated_at timestamptz not null default now());

-- `listOpsCases?subject=` (exact subject.id) is an indexed lookup
create index cases_subject_id on cases ((subject->>'id'), created_at);
