-- Codex — 2026-08-11
-- FAKESNIFF Hub V1, phase 3: final authenticated-access cutover.
--
-- Run ONLY after all of the following are true:
--   1. 20260811_001_hub_v1_foundation.sql completed successfully.
--   2. 20260811_002_hub_v1_work_module.sql completed successfully.
--   3. Public Auth sign-ups are disabled and invited team users can sign in.
--   4. public.members contains at least one active owner.
--   5. The authenticated Hub has been deployed and tested with a team account.
--   6. The GitHub scanner secrets are configured and one new scan succeeded.
--
-- This transaction intentionally disables the old anonymous idea board. Keep a
-- privileged Supabase SQL session open during the cutover so it can be rolled
-- back immediately if a preflight assertion fails.

begin;

do $$
begin
  if (
    select count(*)
    from pg_attribute a
    where a.attrelid = 'public.tasks'::regclass
      and a.attname = any (array[
        'kind', 'source_design_id', 'approver_id', 'due_on', 'next_action',
        'completion_condition', 'flags', 'source_url', 'latest_file_url'
      ])
      and a.attnum > 0
      and not a.attisdropped
  ) <> 9
     or to_regclass('public.tasks_one_doing_per_owner_active_uidx') is null
     or not exists (
       select 1
       from pg_trigger t
       where t.tgrelid = 'public.tasks'::regclass
         and t.tgname = 'tasks_manage_state'
         and not t.tgisinternal
         and t.tgfoid = to_regprocedure('app_private.manage_task_state()')
     ) then
    raise exception 'cutover blocked: run and verify the Work module first';
  end if;

  if exists (
    select 1
    from public.tasks t
    where t.workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
      and t.archived_at is null
      and t.status in ('this_week', 'doing', 'review', 'waiting')
      and t.due_on is null
  ) then
    raise exception 'cutover blocked: backfill due_on for every active Work item';
  end if;

  if not exists (
    select 1
    from public.workspaces w
    join public.members m on m.workspace_id = w.id
    where w.id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
      and w.archived_at is null
      and m.role = 'owner'
      and m.archived_at is null
  ) then
    raise exception 'cutover blocked: FAKESNIFF needs an active owner membership';
  end if;

  if not exists (
    select 1
    from public.scanner_runs sr
    where sr.workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
      and sr.status = 'succeeded'
  ) then
    raise exception 'cutover blocked: run and verify the secrets-based scanner first';
  end if;
end
$$;

-- Remove the three permissive policies installed by the original idea board.
drop policy if exists ideas_all on public.ideas;
drop policy if exists triggers_all on public.triggers;
drop policy if exists activity_all on public.activity;

-- RLS plus this explicit grant allow-list leaves no anonymous CRUD path.
revoke all privileges on table public.ideas, public.triggers, public.activity
from public, anon, authenticated;

grant select, insert, update on table public.ideas to authenticated;
grant select on table public.triggers to authenticated;
grant select on table public.activity to authenticated;

revoke all privileges on sequence
  public.ideas_id_seq, public.triggers_id_seq, public.activity_id_seq
from public, anon, authenticated;
grant usage, select on sequence public.ideas_id_seq to authenticated;

-- The scheduled scanner is the only server process that inserts raw triggers.
grant select, insert, update on table public.triggers, public.scanner_runs
to service_role;
grant usage, select on sequence public.triggers_id_seq to service_role;

-- New clients must always state their workspace. Phase 1 kept these defaults so
-- the legacy board and scanner would continue working before this cutover.
alter table public.ideas alter column workspace_id drop default;
alter table public.triggers alter column workspace_id drop default;
alter table public.activity alter column workspace_id drop default;

-- The new scanner conflicts on (workspace_id, title, source). Removing the old
-- global key lets future workspaces collect the same source independently.
alter table public.triggers drop constraint if exists triggers_title_source_key;

commit;
