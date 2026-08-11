-- Codex — 2026-08-11
-- FAKESNIFF Hub V1, phase 2: additive Work module.
--
-- Run after 20260811_001_hub_v1_foundation.sql. This migration is safe for a
-- new tasks table and for a database that already received an earlier version
-- of the foundation: columns and constraints are added independently and are
-- guarded by name. Existing rows are preserved.

begin;

-- ---------------------------------------------------------------------------
-- Work-specific task fields
-- ---------------------------------------------------------------------------

alter table public.tasks add column if not exists kind text not null default 'task';
alter table public.tasks add column if not exists source_design_id uuid;
alter table public.tasks add column if not exists approver_id uuid;
-- Codex — 2026-08-11: Work uses calendar dates, so avoid timezone shifts from
-- the foundation's legacy due_at timestamp. Connected clients write due_on.
alter table public.tasks add column if not exists due_on date;
alter table public.tasks add column if not exists next_action text not null default '';
alter table public.tasks add column if not exists completion_condition text not null default '';
alter table public.tasks add column if not exists flags text[] not null default '{}'::text[];
alter table public.tasks add column if not exists source_url text not null default '';
alter table public.tasks add column if not exists latest_file_url text not null default '';

-- Codex — 2026-08-11: migrate legacy timestamp deadlines into the calendar
-- date used by the Hub. Europe/Amsterdam is the team's business timezone.
update public.tasks
set due_on = (due_at at time zone 'Europe/Amsterdam')::date
where due_on is null
  and due_at is not null;

-- An intermediate draft used this name for a rule that also treated Done as an
-- active state. Remove only that obsolete draft constraint; the corrected rule
-- below has a stable new name and is otherwise added idempotently.
alter table public.tasks drop constraint if exists tasks_active_fields_present;
alter table public.tasks drop constraint if exists tasks_review_has_approver;
alter table public.tasks drop constraint if exists tasks_review_has_separate_approver;
-- Codex — 2026-08-11: recreate this rule so an environment that tested an
-- earlier due_at draft is upgraded to the date-only due_on contract.
alter table public.tasks drop constraint if exists tasks_active_work_fields_present;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_source_design_fk'
  ) then
    alter table public.tasks
      add constraint tasks_source_design_fk
      foreign key (workspace_id, source_design_id)
      references public.designs(workspace_id, id) on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_approver_fk'
  ) then
    alter table public.tasks
      add constraint tasks_approver_fk
      foreign key (workspace_id, approver_id)
      references public.members(workspace_id, user_id) on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_kind_allowed'
  ) then
    alter table public.tasks add constraint tasks_kind_allowed
      check (kind in ('task', 'recurring')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_flags_allowed'
  ) then
    alter table public.tasks add constraint tasks_flags_allowed check (
      flags <@ array[
        'legal', 'budget', 'supplier', 'account_access', 'missing_assets'
      ]::text[]
      and array_position(flags, null) is null
    ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_source_url_http'
  ) then
    alter table public.tasks add constraint tasks_source_url_http
      check (source_url = '' or source_url ~ '^https?://[^[:space:]]+$')
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_latest_file_url_https'
  ) then
    alter table public.tasks add constraint tasks_latest_file_url_https
      check (latest_file_url = '' or latest_file_url ~ '^https://[^[:space:]]+$')
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_waiting_has_reason'
  ) then
    alter table public.tasks add constraint tasks_waiting_has_reason
      check (status <> 'waiting' or char_length(btrim(blocker_note)) > 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_review_has_separate_approver'
  ) then
    alter table public.tasks add constraint tasks_review_has_separate_approver
      check (
        (approver_id is null or approver_id is distinct from owner_id)
        and (status <> 'review' or approver_id is not null)
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_active_work_fields_present'
  ) then
    alter table public.tasks add constraint tasks_active_work_fields_present check (
      status not in ('this_week', 'doing', 'review', 'waiting')
      or (
        owner_id is not null
        and due_on is not null
        and char_length(btrim(next_action)) > 0
        and char_length(btrim(completion_condition)) > 0
      )
    ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_done_fields_present'
  ) then
    alter table public.tasks add constraint tasks_done_fields_present check (
      status <> 'done'
      or (
        owner_id is not null
        and char_length(btrim(completion_condition)) > 0
      )
    ) not valid;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Stable workstream categories. Rerunning this module never overwrites a name,
-- description or position that the team has edited.
-- ---------------------------------------------------------------------------

insert into public.workstreams (workspace_id, name, slug, description, position)
values
  ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'Operations', 'operations', 'Company systems, decisions and coordination.', 10),
  ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'Product & Design', 'product-design', 'Garments, artwork, sampling and production.', 20),
  ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'Brand & Content', 'brand-content', 'Brand direction, photography, video and publishing assets.', 30),
  ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'Marketing', 'marketing', 'Audience tests, store journeys and measurable acquisition.', 40),
  ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'Automation', 'automation', 'Idea collection and carefully supervised machine assistance.', 50),
  ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'Administration', 'administration', 'Legal, finance, suppliers and account access.', 60)
on conflict (workspace_id, slug) do nothing;

-- ---------------------------------------------------------------------------
-- Workflow state and approval
-- ---------------------------------------------------------------------------

create or replace function app_private.manage_task_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_is_admin boolean := false;
  actor_is_old_approver boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.owner_id is not null and not exists (
      select 1
      from public.members m
      where m.workspace_id = new.workspace_id
        and m.user_id = new.owner_id
        and m.archived_at is null
        and m.role in ('member', 'admin', 'owner')
    ) then
      raise exception 'Owner must be an active member who can update work';
    end if;

    if new.approver_id is not null and not exists (
      select 1
      from public.members m
      where m.workspace_id = new.workspace_id
        and m.user_id = new.approver_id
        and m.archived_at is null
        and m.role in ('member', 'admin', 'owner')
    ) then
      raise exception 'Approver must be an active member who can update work';
    end if;

    -- Codex — 2026-08-11: direct creation of already-completed,
    -- approval-bound work is a privileged history import. Ordinary members
    -- must assign approval before the completion transition.
    if auth.role() = 'authenticated'
       and new.status = 'done'
       and new.approver_id is not null
       and not app_private.has_workspace_role(new.workspace_id, 'admin') then
      raise exception 'Only a workspace admin can create completed approval-bound work';
    end if;

    if new.status = 'done' then
      new.completed_at := now();
    else
      new.completed_at := null;
    end if;
    return new;
  end if;

  if auth.role() = 'authenticated' then
    actor_is_admin := app_private.has_workspace_role(old.workspace_id, 'admin');
    actor_is_old_approver := old.approver_id is not null
      and auth.uid() = old.approver_id;

    if new.owner_id is distinct from old.owner_id
       and new.owner_id is not null
       and not exists (
         select 1
         from public.members m
         where m.workspace_id = new.workspace_id
           and m.user_id = new.owner_id
           and m.archived_at is null
           and m.role in ('member', 'admin', 'owner')
       ) then
      raise exception 'Owner must be an active member who can update work';
    end if;

    if new.approver_id is distinct from old.approver_id
       and new.approver_id is not null
       and not exists (
         select 1
         from public.members m
         where m.workspace_id = new.workspace_id
           and m.user_id = new.approver_id
           and m.archived_at is null
           and m.role in ('member', 'admin', 'owner')
       ) then
      raise exception 'Approver must be an active member who can update work';
    end if;

    -- Once approval is assigned, ordinary members cannot replace or remove the
    -- approver to manufacture their own approval path.
    if old.approver_id is not null
       and new.approver_id is distinct from old.approver_id
       and not actor_is_admin then
      raise exception 'Only a workspace admin can change an assigned approver';
    end if;

    -- Assigning an approver and marking Done in the same update would skip the
    -- retained-approver completion gate, which intentionally checks OLD.
    if old.approver_id is null
       and new.approver_id is not null
       and new.status = 'done'
       and not actor_is_admin then
      raise exception 'Approval must be assigned before completion';
    end if;

    -- Archiving is also a workflow exit because it removes the card from normal
    -- views. Approval-bound work cannot be hidden by its owner.
    if (old.status = 'review' or old.approver_id is not null)
       and old.archived_at is null
       and new.archived_at is not null
       and not actor_is_old_approver
       and not actor_is_admin then
      raise exception 'Only the assigned approver or a workspace admin can archive this task';
    end if;

    -- The assigned approver (or an admin/owner) controls every exit from the
    -- Review lane, including sending work back for changes.
    if old.status = 'review'
       and new.status is distinct from old.status
       and not actor_is_old_approver
       and not actor_is_admin then
      raise exception 'Only the assigned approver or a workspace admin can move this review';
    end if;

    -- Completed approval-bound history cannot be reopened by an unrelated
    -- member because that also clears the server-owned completion timestamp.
    if old.status = 'done'
       and old.approver_id is not null
       and new.status is distinct from old.status
       and not actor_is_old_approver
       and not actor_is_admin then
      raise exception 'Only the assigned approver or a workspace admin can reopen this task';
    end if;

    -- If a task has ever retained an approver, completing it still requires
    -- that approver/admin even after it was sent back to Doing or Waiting.
    if new.status = 'done'
       and old.approver_id is not null
       and not actor_is_old_approver
       and not actor_is_admin then
      raise exception 'Only the assigned approver or a workspace admin can complete this task';
    end if;
  end if;

  if new.status = 'done' then
    if old.status = 'done' then
      new.completed_at := old.completed_at;
    else
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;

  return new;
end
$$;

drop trigger if exists tasks_manage_state on public.tasks;
create trigger tasks_manage_state before insert or update on public.tasks
  for each row execute function app_private.manage_task_state();

-- ---------------------------------------------------------------------------
-- Work-in-progress limits
-- ---------------------------------------------------------------------------

-- A partial unique index makes one Doing task per owner race-safe at every
-- PostgreSQL isolation level. Fail with an actionable message before creating
-- it if older task data already violates the invariant.
do $$
declare
  duplicate_owner record;
  crowded_lane record;
begin
  if exists (
    select 1 from public.tasks t
    where t.status = 'doing'
      and t.archived_at is null
      and t.owner_id is null
  ) then
    raise exception 'work module blocked: assign an owner to every active Doing task';
  end if;

  select t.workspace_id, t.owner_id, count(*) as task_count
  into duplicate_owner
  from public.tasks t
  where t.status = 'doing'
    and t.archived_at is null
  group by t.workspace_id, t.owner_id
  having count(*) > 1
  limit 1;

  if found then
    raise exception
      'work module blocked: owner % has % active Doing tasks in workspace %',
      duplicate_owner.owner_id,
      duplicate_owner.task_count,
      duplicate_owner.workspace_id;
  end if;

  select t.workspace_id, count(*) as task_count
  into crowded_lane
  from public.tasks t
  where t.status = 'this_week'
    and t.archived_at is null
  group by t.workspace_id
  having count(*) > 3
  limit 1;

  if found then
    raise exception
      'work module blocked: workspace % has % tasks in the This week lane; reduce it to three',
      crowded_lane.workspace_id,
      crowded_lane.task_count;
  end if;
end
$$;

create unique index if not exists tasks_one_doing_per_owner_active_uidx
  on public.tasks (workspace_id, owner_id)
  where status = 'doing' and archived_at is null;

create or replace function app_private.enforce_this_week_lane_wip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  lane_count integer;
begin
  if new.archived_at is not null or new.status <> 'this_week' then
    return new;
  end if;

  -- An edit to a card already in the lane cannot increase lane occupancy.
  if tg_op = 'UPDATE'
     and old.status = 'this_week'
     and old.archived_at is null then
    return new;
  end if;

  -- This is strictly a lane WIP limit, not a count of every outcome selected
  -- during a calendar week. The app/PostgREST write path must use PostgreSQL's
  -- default READ COMMITTED isolation: the advisory lock serializes entrants and
  -- the VOLATILE trigger function's SELECT then receives a fresh snapshot.
  perform pg_advisory_xact_lock(
    hashtextextended(new.workspace_id::text || ':this-week-lane', 0)
  );

  select count(*) into lane_count
  from public.tasks t
  where t.workspace_id = new.workspace_id
    and t.status = 'this_week'
    and t.archived_at is null
    and t.id <> new.id;

  if lane_count >= 3 then
    raise exception 'The This week lane is limited to three tasks';
  end if;

  return new;
end
$$;

-- Remove the earlier all-purpose trigger if an intermediate schema revision was
-- applied, then install the narrower lane-only rule.
drop trigger if exists tasks_enforce_limits on public.tasks;
drop trigger if exists tasks_enforce_this_week_lane_wip on public.tasks;
create trigger tasks_enforce_this_week_lane_wip
  before insert or update on public.tasks
  for each row execute function app_private.enforce_this_week_lane_wip();

drop function if exists app_private.enforce_task_limits();

-- Trigger functions are not client RPCs.
revoke all on function app_private.manage_task_state() from public, anon, authenticated;
revoke all on function app_private.enforce_this_week_lane_wip() from public, anon, authenticated;

commit;
