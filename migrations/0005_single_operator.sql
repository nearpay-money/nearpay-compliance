-- Adaptive two-person rule for account suspend/reinstate (compliance LLD §5.1 "Single-operator platforms").
-- Additive and forward-only.
--
-- A second, different operator approves only while two or more operators can approve. The request records how
-- many active ops_admin operators identity reported when it was made (`requested_admins`; null = unknown,
-- two-person). With one, the requester may complete it alone after the configured wait, with a new confirmation
-- and a written reason; the row is marked `single_operator`. The database still refuses a same-operator approval
-- unless it is marked, was requested with at most one approver, carries a reason and was decided after the request.
alter table ops_approvals
  add column requested_admins integer check (requested_admins is null or requested_admins >= 0),
  add column single_operator boolean not null default false;

-- the unnamed different-approver check of 0002, replaced by a named one with the single-operator exception
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'ops_approvals'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%decided_by <> requested_by%';
  if c is null then raise exception 'ops_approvals different-approver check not found'; end if;
  execute format('alter table ops_approvals drop constraint %I', c);
end $$;

alter table ops_approvals add constraint ops_approvals_approver_differs check (
  status <> 'approved' or (
    decided_by is not null and decided_role = 'ops_admin' and (
      decided_by <> requested_by
      or (single_operator and requested_admins is not null and requested_admins <= 1
          and decision_note is not null and length(btrim(decision_note)) > 0
          and decided_at is not null and decided_at > requested_at))));
alter table ops_approvals add constraint ops_approvals_single_operator_self check (
  not single_operator or (status = 'approved' and decided_by = requested_by));
