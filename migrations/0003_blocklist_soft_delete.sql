-- nearpay-compliance: blocklist removal keeps the entry (audit finding 10, stage 2; INV-9).
-- A removal used to delete the row, so the audit trail (ops_actions → bl_ id) lost the address it was about.
-- Removal now sets removed_at/removed_by/removal_note; screening and the console list read active rows only.
-- Additive and forward-only: no data is dropped; the natural key becomes a partial unique index so a removed
-- subject can be listed again (as a new entry with a new id).

alter table blocklist
  add column removed_at timestamptz,
  add column removed_by text,                           -- `ops:usr_…` (console) or the CLI actor
  add column removal_note text,
  add constraint blocklist_removal_complete check ((removed_at is null) = (removed_by is null));

alter table blocklist drop constraint blocklist_pkey;
alter table blocklist add constraint blocklist_pkey primary key (id);
create unique index blocklist_active on blocklist (subject_type, subject) where removed_at is null;

-- History cannot be erased or rewritten: no deletes; a removed entry is frozen.
create function blocklist_keep_history() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'blocklist entries are never deleted (set removed_at)' using errcode = 'check_violation';
  end if;
  if old.removed_at is not null then
    raise exception 'a removed blocklist entry cannot change' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger blocklist_keep_history before update or delete on blocklist
  for each row execute function blocklist_keep_history();

-- Operator actions: internal structured details (e.g. the blocklist subject and chain). Never published:
-- evt.compliance.ops_action.recorded stays ids-only.
alter table ops_actions add column details jsonb;
