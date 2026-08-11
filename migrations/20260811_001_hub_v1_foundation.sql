-- Codex — 2026-08-11
-- FAKESNIFF Hub V1, phase 1: non-breaking expand and backfill.
--
-- This is an additive migration. It preserves the existing ideas, triggers and
-- activity rows and assigns them to the FAKESNIFF workspace. It deliberately
-- leaves the three legacy anonymous policies and grants in place so the current
-- idea board keeps working while the authenticated Hub is deployed. Run the
-- separate 20260811_003_hub_v1_access_cutover.sql only after the Work module,
-- replacement UI and team memberships have been verified. Do not paste API
-- keys into this file.
--
-- Required rollout steps after this migration:
--   1. Create a GitHub Environment named scanner-production, restrict it to
--      the protected default branch, and add SUPABASE_URL,
--      SUPABASE_SCANNER_KEY and SUPABASE_WORKSPACE_ID
--      (6b9f4ba4-e480-4c08-b67e-4d389db3f9d1) as Environment secrets.
--      V1's SUPABASE_SCANNER_KEY value is the powerful service-role secret;
--      never expose it to browser code or commit it to this repository.
--   2. Disable public Auth sign-ups, then invite the initial team members.
--   3. Add the invited users to public.members from privileged SQL. Membership
--      management is not implemented in the app yet; do not expect an owner to
--      add members from the current UI.
--   4. Run 20260811_002_hub_v1_work_module.sql, then deploy and verify the
--      authenticated Hub, including a successful scan.
--   5. Run 20260811_003_hub_v1_access_cutover.sql to remove legacy anon access.

begin;

create extension if not exists pgcrypto;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated;

-- ---------------------------------------------------------------------------
-- Workspace and invite-only membership
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  constraint workspaces_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint workspaces_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

insert into public.workspaces (id, name, slug)
values ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', 'FAKESNIFF', 'fakesniff')
on conflict do nothing;

create table if not exists public.members (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id      uuid not null references auth.users(id) on delete restrict,
  display_name text not null,
  role          text not null default 'member',
  invited_by    uuid references auth.users(id) on delete set null,
  joined_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  primary key (workspace_id, user_id),
  constraint members_display_name_length check (char_length(btrim(display_name)) between 1 and 80),
  constraint members_role_allowed check (role in ('viewer', 'member', 'admin', 'owner'))
);

create or replace function app_private.member_role_rank(p_role text)
returns integer
language sql
immutable
strict
as $$
  select case p_role
    when 'viewer' then 0
    when 'member' then 1
    when 'admin'  then 2
    when 'owner'  then 3
    else -1
  end
$$;

create or replace function app_private.has_workspace_role(
  p_workspace_id uuid,
  p_minimum_role text default 'viewer'
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select exists (
    select 1
    from public.members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.archived_at is null
      and w.archived_at is null
      and app_private.member_role_rank(m.role)
          >= app_private.member_role_rank(p_minimum_role)
  )
$$;

-- Text version avoids unsafe UUID casts when a storage object has a malformed path.
create or replace function app_private.has_workspace_role_text(
  p_workspace_id text,
  p_minimum_role text default 'viewer'
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select exists (
    select 1
    from public.members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id::text = p_workspace_id
      and m.user_id = auth.uid()
      and m.archived_at is null
      and w.archived_at is null
      and app_private.member_role_rank(m.role)
          >= app_private.member_role_rank(p_minimum_role)
  )
$$;

-- ---------------------------------------------------------------------------
-- Scanner visibility and safe extension of existing data
-- ---------------------------------------------------------------------------

create table if not exists public.scanner_runs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete restrict,
  external_run_id  text not null,
  status           text not null default 'running',
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  before_count     integer,
  after_count      integer,
  collected_count  integer not null default 0,
  submitted_count  integer not null default 0,
  inserted_count   integer not null default 0,
  failed_count     integer not null default 0,
  commit_sha       text,
  error_message    text,
  details          jsonb not null default '{}'::jsonb,
  unique (workspace_id, external_run_id),
  unique (workspace_id, id),
  constraint scanner_runs_status_allowed check (status in ('running', 'succeeded', 'failed')),
  constraint scanner_runs_counts_nonnegative check (
    coalesce(before_count, 0) >= 0 and coalesce(after_count, 0) >= 0
    and collected_count >= 0 and submitted_count >= 0
    and inserted_count >= 0 and failed_count >= 0
  ),
  constraint scanner_runs_details_object check (jsonb_typeof(details) = 'object'),
  constraint scanner_runs_finished_state check (
    (status = 'running' and finished_at is null)
    or (status in ('succeeded', 'failed') and finished_at is not null)
  )
);

alter table public.triggers add column if not exists workspace_id uuid;
alter table public.triggers add column if not exists scanner_run_id uuid;
alter table public.triggers add column if not exists archived_at timestamptz;
alter table public.triggers add column if not exists updated_at timestamptz not null default now();

update public.triggers
set workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
where workspace_id is null;

-- Keep the legacy anonymous scanner working during the expand phase. The new
-- scanner supplies workspace_id explicitly; the default can be removed later
-- if a second workspace is introduced.
alter table public.triggers alter column workspace_id
  set default '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1';
alter table public.triggers alter column workspace_id set not null;

-- Retain triggers_title_source_key until the cutover so the old scanner's
-- on_conflict=title,source request remains valid.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_workspace_title_source_key'
  ) then
    alter table public.triggers
      add constraint triggers_workspace_title_source_key
      unique (workspace_id, title, source);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_workspace_id_id_key'
  ) then
    alter table public.triggers
      add constraint triggers_workspace_id_id_key unique (workspace_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_workspace_fk'
  ) then
    alter table public.triggers
      add constraint triggers_workspace_fk foreign key (workspace_id)
      references public.workspaces(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_scanner_run_fk'
  ) then
    alter table public.triggers
      add constraint triggers_scanner_run_fk
      foreign key (workspace_id, scanner_run_id)
      references public.scanner_runs(workspace_id, id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_category_allowed'
  ) then
    alter table public.triggers add constraint triggers_category_allowed check (
      category in ('music', 'film', 'tv', 'icons', 'social', 'tech', 'sport',
                   'travel', 'art', 'news', 'youth', 'other')
    ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_url_http'
  ) then
    alter table public.triggers add constraint triggers_url_http check (
      url is null or url = '' or url ~ '^https?://[^[:space:]]+$'
    ) not valid;
  end if;
end
$$;

alter table public.ideas add column if not exists workspace_id uuid;
alter table public.ideas add column if not exists trigger_id bigint;
alter table public.ideas add column if not exists owner_id uuid;
alter table public.ideas add column if not exists created_by_user_id uuid;
alter table public.ideas add column if not exists updated_by_user_id uuid;
alter table public.ideas add column if not exists archived_at timestamptz;

update public.ideas
set workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
where workspace_id is null;

alter table public.ideas alter column workspace_id
  set default '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1';
alter table public.ideas alter column workspace_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_workspace_id_id_key'
  ) then
    alter table public.ideas
      add constraint ideas_workspace_id_id_key unique (workspace_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_workspace_fk'
  ) then
    alter table public.ideas
      add constraint ideas_workspace_fk foreign key (workspace_id)
      references public.workspaces(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_trigger_fk'
  ) then
    alter table public.ideas
      add constraint ideas_trigger_fk foreign key (workspace_id, trigger_id)
      references public.triggers(workspace_id, id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_owner_fk'
  ) then
    alter table public.ideas
      add constraint ideas_owner_fk foreign key (workspace_id, owner_id)
      references public.members(workspace_id, user_id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_created_by_user_fk'
  ) then
    alter table public.ideas
      add constraint ideas_created_by_user_fk foreign key (created_by_user_id)
      references auth.users(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_updated_by_user_fk'
  ) then
    alter table public.ideas
      add constraint ideas_updated_by_user_fk foreign key (updated_by_user_id)
      references auth.users(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_status_allowed'
  ) then
    alter table public.ideas add constraint ideas_status_allowed check (
      status in ('new', 'interesting', 'needs work', 'develop', 'rejected', 'in production')
    ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_risk_allowed'
  ) then
    alter table public.ideas add constraint ideas_risk_allowed
      check (risk in ('clean', 'check', 'avoid')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_category_allowed'
  ) then
    alter table public.ideas add constraint ideas_category_allowed check (
      category in ('music', 'film', 'tv', 'icons', 'social', 'tech', 'sport',
                   'travel', 'art', 'news', 'youth', 'other')
    ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_source_url_http'
  ) then
    alter table public.ideas add constraint ideas_source_url_http check (
      source_url is null or source_url = '' or source_url ~ '^https?://[^[:space:]]+$'
    ) not valid;
  end if;
end
$$;

alter table public.activity add column if not exists workspace_id uuid;

update public.activity
set workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
where workspace_id is null;

alter table public.activity alter column workspace_id
  set default '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1';
alter table public.activity alter column workspace_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.activity'::regclass
      and conname = 'activity_workspace_fk'
  ) then
    alter table public.activity
      add constraint activity_workspace_fk foreign key (workspace_id)
      references public.workspaces(id) on delete restrict;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Hub work, designs, decisions and resources
-- ---------------------------------------------------------------------------

create table if not exists public.workstreams (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  name        text not null,
  slug        text not null,
  description text not null default '',
  status      text not null default 'active',
  owner_id    uuid,
  position    integer not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, slug),
  unique (workspace_id, id),
  constraint workstreams_owner_fk foreign key (workspace_id, owner_id)
    references public.members(workspace_id, user_id) on delete restrict,
  constraint workstreams_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint workstreams_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint workstreams_status_allowed check (status in ('active', 'paused', 'complete')),
  constraint workstreams_position_nonnegative check (position >= 0)
);

create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete restrict,
  workstream_id  uuid,
  source_idea_id bigint,
  title          text not null,
  description    text not null default '',
  status         text not null default 'backlog',
  priority       text not null default 'normal',
  owner_id       uuid,
  due_at         timestamptz,
  blocker_note   text not null default '',
  position       integer not null default 0,
  completed_at   timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  updated_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  unique (workspace_id, id),
  constraint tasks_workstream_fk foreign key (workspace_id, workstream_id)
    references public.workstreams(workspace_id, id) on delete restrict,
  constraint tasks_source_idea_fk foreign key (workspace_id, source_idea_id)
    references public.ideas(workspace_id, id) on delete restrict,
  constraint tasks_owner_fk foreign key (workspace_id, owner_id)
    references public.members(workspace_id, user_id) on delete restrict,
  constraint tasks_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint tasks_status_allowed check (
    status in ('backlog', 'this_week', 'doing', 'review', 'waiting', 'done')
  ),
  constraint tasks_priority_allowed check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint tasks_position_nonnegative check (position >= 0)
);

create table if not exists public.designs (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete restrict,
  workstream_id       uuid,
  source_idea_id      bigint,
  title               text not null,
  statement           text not null default '',
  brief               text not null default '',
  status              text not null default 'brief',
  legal_review_status text not null default 'not_flagged',
  legal_note          text not null default '',
  owner_id            uuid,
  created_by          uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,
  unique (workspace_id, id),
  constraint designs_workstream_fk foreign key (workspace_id, workstream_id)
    references public.workstreams(workspace_id, id) on delete restrict,
  constraint designs_source_idea_fk foreign key (workspace_id, source_idea_id)
    references public.ideas(workspace_id, id) on delete restrict,
  constraint designs_owner_fk foreign key (workspace_id, owner_id)
    references public.members(workspace_id, user_id) on delete restrict,
  constraint designs_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint designs_status_allowed check (
    status in ('brief', 'concept', 'designing', 'review', 'approved', 'production', 'released', 'rejected')
  ),
  constraint designs_legal_status_allowed check (
    legal_review_status in ('not_flagged', 'needs_review', 'sent_to_lawyer', 'cleared', 'blocked')
  )
);

create table if not exists public.design_versions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete restrict,
  design_id       uuid not null,
  version_number  integer not null,
  storage_path    text not null,
  preview_path    text,
  notes           text not null default '',
  mime_type       text,
  file_size_bytes bigint,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  unique (workspace_id, id),
  unique (design_id, version_number),
  constraint design_versions_design_fk foreign key (workspace_id, design_id)
    references public.designs(workspace_id, id) on delete restrict,
  constraint design_versions_number_positive check (version_number > 0),
  constraint design_versions_file_size_nonnegative check (
    file_size_bytes is null or file_size_bytes >= 0
  ),
  constraint design_versions_storage_path_scoped check (
    storage_path like workspace_id::text || '/designs/' || design_id::text || '/%'
  ),
  constraint design_versions_preview_path_scoped check (
    preview_path is null
    or preview_path like workspace_id::text || '/designs/' || design_id::text || '/%'
  )
);

create table if not exists public.decisions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete restrict,
  workstream_id  uuid,
  title          text not null,
  context        text not null default '',
  decision       text not null default '',
  status         text not null default 'proposed',
  owner_id       uuid,
  decided_at     timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  updated_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  unique (workspace_id, id),
  constraint decisions_workstream_fk foreign key (workspace_id, workstream_id)
    references public.workstreams(workspace_id, id) on delete restrict,
  constraint decisions_owner_fk foreign key (workspace_id, owner_id)
    references public.members(workspace_id, user_id) on delete restrict,
  constraint decisions_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint decisions_status_allowed check (
    status in ('proposed', 'decided', 'superseded', 'cancelled')
  ),
  constraint decisions_decided_state check (
    (status = 'decided' and decided_at is not null and char_length(btrim(decision)) > 0)
    or status <> 'decided'
  )
);

create table if not exists public.resources (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,
  workstream_id uuid,
  title         text not null,
  kind          text not null default 'link',
  url           text,
  notes         text not null default '',
  owner_id      uuid,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (workspace_id, id),
  constraint resources_workstream_fk foreign key (workspace_id, workstream_id)
    references public.workstreams(workspace_id, id) on delete restrict,
  constraint resources_owner_fk foreign key (workspace_id, owner_id)
    references public.members(workspace_id, user_id) on delete restrict,
  constraint resources_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint resources_kind_allowed check (
    kind in ('link', 'document', 'board', 'store', 'social', 'asset', 'other')
  ),
  constraint resources_url_shape check (
    url is null or url = '' or url ~ '^https://'
  )
);

create table if not exists public.activity_events (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete restrict,
  actor_id            uuid references auth.users(id) on delete set null,
  entity_type        text not null,
  entity_id          text,
  action             text not null,
  event_data         jsonb not null default '{}'::jsonb,
  occurred_at        timestamptz not null default now(),
  legacy_activity_id bigint unique,
  constraint activity_events_entity_type_length check (
    char_length(btrim(entity_type)) between 1 and 80
  ),
  constraint activity_events_action_length check (
    char_length(btrim(action)) between 1 and 80
  ),
  constraint activity_events_data_object check (jsonb_typeof(event_data) = 'object')
);

-- Preserve the old human-readable activity as immutable historical events.
insert into public.activity_events (
  workspace_id, entity_type, entity_id, action, event_data, occurred_at,
  legacy_activity_id
)
select
  a.workspace_id,
  'idea',
  a.idea_id::text,
  'legacy_activity',
  jsonb_build_object('who', a.who, 'what', a.what),
  coalesce(a.at, now()),
  a.id
from public.activity a
on conflict (legacy_activity_id) do nothing;

-- ---------------------------------------------------------------------------
-- Server-maintained timestamps, actors, invariants and audit trail
-- ---------------------------------------------------------------------------

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create or replace function app_private.stamp_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      new.created_at := now();
    else
      new.created_by := old.created_by;
      new.created_at := old.created_at;
    end if;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end
$$;

create or replace function app_private.stamp_idea_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_by_user_id := auth.uid();
      new.created_at := now();
    else
      new.created_by_user_id := old.created_by_user_id;
      new.created_at := old.created_at;
    end if;
    new.updated_by_user_id := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end
$$;

create or replace function app_private.stamp_design_version_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      new.created_at := now();
    else
      new.design_id := old.design_id;
      new.version_number := old.version_number;
      new.storage_path := old.storage_path;
      new.created_by := old.created_by;
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end
$$;

create or replace function app_private.stamp_membership_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated' then
    if tg_op = 'INSERT' then
      new.invited_by := auth.uid();
      new.joined_at := now();
    else
      new.invited_by := old.invited_by;
      new.joined_at := old.joined_at;
    end if;
    new.updated_at := now();
  end if;
  return new;
end
$$;

create or replace function app_private.protect_workspace_server_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated' then
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end
$$;

create or replace function app_private.guard_trigger_server_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.scanner_run_id is not null then
        raise exception 'scanner_run_id is server-managed';
      end if;
      new.found_at := now();
      new.updated_at := now();
    else
      if new.scanner_run_id is distinct from old.scanner_run_id then
        raise exception 'scanner_run_id is server-managed';
      end if;
      new.found_at := old.found_at;
      new.updated_at := now();
    end if;
  end if;
  return new;
end
$$;

create or replace function app_private.prevent_workspace_move()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id cannot be changed';
  end if;
  if (to_jsonb(new) ->> 'id') is distinct from (to_jsonb(old) ->> 'id') then
    raise exception 'row id cannot be changed';
  end if;
  return new;
end
$$;

create or replace function app_private.manage_task_state_foundation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'done' then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end
$$;

create or replace function app_private.manage_decision_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'decided' then
    new.decided_at := coalesce(new.decided_at, now());
  elsif new.status = 'proposed' then
    new.decided_at := null;
  end if;
  return new;
end
$$;

create or replace function app_private.guard_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  actor_role text;
  removes_active_owner boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id is distinct from old.workspace_id
       or new.user_id is distinct from old.user_id then
      raise exception 'membership identity cannot be changed';
    end if;

    removes_active_owner := old.role = 'owner'
      and old.archived_at is null
      and (new.role <> 'owner' or new.archived_at is not null);

    if auth.uid() is not null then
      select m.role into actor_role
      from public.members m
      where m.workspace_id = old.workspace_id
        and m.user_id = auth.uid()
        and m.archived_at is null;

      if actor_role is distinct from 'owner'
         and (old.role = 'owner' or new.role = 'owner') then
        raise exception 'only an owner can change owner memberships';
      end if;
    end if;
  elsif tg_op = 'DELETE' then
    removes_active_owner := old.role = 'owner' and old.archived_at is null;
  end if;

  if removes_active_owner then
    -- Serialize owner changes across different membership rows. The workspace
    -- row lock also makes the invariant visible to operators and prevents two
    -- concurrent demotions from both observing another owner.
    perform pg_advisory_xact_lock(hashtextextended(old.workspace_id::text, 0));
    perform 1 from public.workspaces w
      where w.id = old.workspace_id
      for update;

    if not exists (
      select 1
      from public.members m
      where m.workspace_id = old.workspace_id
        and m.user_id <> old.user_id
        and m.role = 'owner'
        and m.archived_at is null
    ) then
      raise exception 'a workspace must retain at least one active owner';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create or replace function app_private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  old_data jsonb;
  new_data jsonb;
  row_data jsonb;
  workspace uuid;
  entity text;
  payload jsonb;
begin
  if tg_op <> 'INSERT' then
    old_data := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    new_data := to_jsonb(new);
  end if;

  row_data := case when tg_op = 'DELETE' then old_data else new_data end;
  workspace := (row_data ->> 'workspace_id')::uuid;
  entity := coalesce(row_data ->> 'id', row_data ->> 'user_id');

  payload := case tg_op
    when 'INSERT' then jsonb_build_object('new', new_data)
    when 'UPDATE' then jsonb_build_object('old', old_data, 'new', new_data)
    else jsonb_build_object('old', old_data)
  end;

  insert into public.activity_events (
    workspace_id, actor_id, entity_type, entity_id, action, event_data
  ) values (
    workspace, auth.uid(), tg_table_name, entity, lower(tg_op), payload
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

-- Replace the original public timestamp trigger with the private function.
drop trigger if exists ideas_touch on public.ideas;
drop trigger if exists ideas_set_updated_at on public.ideas;
create trigger ideas_set_updated_at before update on public.ideas
  for each row execute function app_private.set_updated_at();

drop trigger if exists triggers_set_updated_at on public.triggers;
create trigger triggers_set_updated_at before update on public.triggers
  for each row execute function app_private.set_updated_at();

drop trigger if exists members_set_updated_at on public.members;
create trigger members_set_updated_at before update on public.members
  for each row execute function app_private.set_updated_at();

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function app_private.set_updated_at();

drop trigger if exists workstreams_set_updated_at on public.workstreams;
create trigger workstreams_set_updated_at before update on public.workstreams
  for each row execute function app_private.set_updated_at();

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function app_private.set_updated_at();

drop trigger if exists designs_set_updated_at on public.designs;
create trigger designs_set_updated_at before update on public.designs
  for each row execute function app_private.set_updated_at();

drop trigger if exists decisions_set_updated_at on public.decisions;
create trigger decisions_set_updated_at before update on public.decisions
  for each row execute function app_private.set_updated_at();

drop trigger if exists resources_set_updated_at on public.resources;
create trigger resources_set_updated_at before update on public.resources
  for each row execute function app_private.set_updated_at();

drop trigger if exists ideas_stamp_actor on public.ideas;
create trigger ideas_stamp_actor before insert or update on public.ideas
  for each row execute function app_private.stamp_idea_actor();

drop trigger if exists design_versions_stamp_actor on public.design_versions;
create trigger design_versions_stamp_actor before insert or update on public.design_versions
  for each row execute function app_private.stamp_design_version_actor();

drop trigger if exists members_stamp_actor on public.members;
create trigger members_stamp_actor before insert or update on public.members
  for each row execute function app_private.stamp_membership_actor();

drop trigger if exists workspaces_protect_server_fields on public.workspaces;
create trigger workspaces_protect_server_fields before update on public.workspaces
  for each row execute function app_private.protect_workspace_server_fields();

drop trigger if exists triggers_guard_server_fields on public.triggers;
create trigger triggers_guard_server_fields before insert or update on public.triggers
  for each row execute function app_private.guard_trigger_server_fields();

do $$
declare
  table_name text;
begin
  foreach table_name in array array['workstreams', 'tasks', 'designs', 'decisions', 'resources']
  loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_stamp_actor', table_name);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function app_private.stamp_actor()',
      table_name || '_stamp_actor', table_name
    );
  end loop;
end
$$;

-- Codex — 2026-08-11: rerunning phase 1 after phase 2 must not replace the
-- hardened Work trigger. Phase 2 is identifiable by its additive due_on field.
do $$
begin
  if not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.tasks'::regclass
      and attname = 'due_on'
      and attnum > 0
      and not attisdropped
  ) then
    execute 'drop trigger if exists tasks_manage_state on public.tasks';
    execute 'create trigger tasks_manage_state before insert or update on public.tasks for each row execute function app_private.manage_task_state_foundation()';
  end if;
end
$$;

drop trigger if exists decisions_manage_state on public.decisions;
create trigger decisions_manage_state before insert or update on public.decisions
  for each row execute function app_private.manage_decision_state();

drop trigger if exists members_guard_change on public.members;
create trigger members_guard_change before update or delete on public.members
  for each row execute function app_private.guard_membership_change();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'members', 'workstreams', 'tasks', 'ideas', 'triggers', 'designs',
    'design_versions', 'decisions', 'resources', 'scanner_runs'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_prevent_workspace_move', table_name);
    execute format(
      'create trigger %I before update on public.%I for each row execute function app_private.prevent_workspace_move()',
      table_name || '_prevent_workspace_move', table_name
    );
  end loop;
end
$$;

-- Scanner volume is summarized in scanner_runs; per-trigger insert events
-- would make the human activity feed unusably noisy.
drop trigger if exists triggers_audit_change on public.triggers;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'members', 'workstreams', 'tasks', 'ideas', 'designs',
    'design_versions', 'decisions', 'resources'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_audit_change', table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function app_private.audit_row_change()',
      table_name || '_audit_change', table_name
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Row-level security. Authenticated users see only active workspaces where they
-- have a membership. The legacy ideas_all, triggers_all and activity_all anon
-- policies remain temporarily; phase 2 removes them after the new UI is live.
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.members enable row level security;
alter table public.workstreams enable row level security;
alter table public.tasks enable row level security;
alter table public.ideas enable row level security;
alter table public.triggers enable row level security;
alter table public.designs enable row level security;
alter table public.design_versions enable row level security;
alter table public.decisions enable row level security;
alter table public.resources enable row level security;
alter table public.activity enable row level security;
alter table public.activity_events enable row level security;
alter table public.scanner_runs enable row level security;

drop policy if exists workspaces_member_select on public.workspaces;
create policy workspaces_member_select on public.workspaces
  for select to authenticated
  using (app_private.has_workspace_role(id, 'viewer'));

drop policy if exists workspaces_admin_update on public.workspaces;
create policy workspaces_admin_update on public.workspaces
  for update to authenticated
  using (app_private.has_workspace_role(id, 'admin'))
  with check (app_private.has_workspace_role(id, 'admin'));

drop policy if exists members_member_select on public.members;
create policy members_member_select on public.members
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

drop policy if exists members_admin_insert on public.members;
create policy members_admin_insert on public.members
  for insert to authenticated
  with check (
    app_private.has_workspace_role(workspace_id, 'admin')
    and (role <> 'owner' or app_private.has_workspace_role(workspace_id, 'owner'))
  );

drop policy if exists members_admin_update on public.members;
create policy members_admin_update on public.members
  for update to authenticated
  using (
    app_private.has_workspace_role(workspace_id, 'admin')
    and (role <> 'owner' or app_private.has_workspace_role(workspace_id, 'owner'))
  )
  with check (
    app_private.has_workspace_role(workspace_id, 'admin')
    and (role <> 'owner' or app_private.has_workspace_role(workspace_id, 'owner'))
  );

-- Standard workspace records: viewers read; members and above create/update.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'workstreams', 'tasks', 'ideas', 'triggers', 'designs',
    'design_versions', 'decisions', 'resources'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', table_name || '_member_select', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app_private.has_workspace_role(workspace_id, ''viewer''))',
      table_name || '_member_select', table_name
    );
    execute format('drop policy if exists %I on public.%I', table_name || '_member_insert', table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (app_private.has_workspace_role(workspace_id, ''member''))',
      table_name || '_member_insert', table_name
    );
    execute format('drop policy if exists %I on public.%I', table_name || '_member_update', table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated using (app_private.has_workspace_role(workspace_id, ''member'')) with check (app_private.has_workspace_role(workspace_id, ''member''))',
      table_name || '_member_update', table_name
    );
  end loop;
end
$$;

-- Codex — 2026-08-11: raw triggers are scanner-owned. Authenticated members
-- may read them but cannot forge or rewrite the culture feed.
drop policy if exists triggers_member_insert on public.triggers;
drop policy if exists triggers_member_update on public.triggers;

drop policy if exists activity_member_select on public.activity;
create policy activity_member_select on public.activity
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

drop policy if exists activity_events_member_select on public.activity_events;
create policy activity_events_member_select on public.activity_events
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

drop policy if exists scanner_runs_member_select on public.scanner_runs;
create policy scanner_runs_member_select on public.scanner_runs
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

-- Phase 1 privilege allow-list for NEW tables. Do not revoke legacy ideas,
-- triggers or activity grants here: the current board still depends on them.
revoke all privileges on table
  public.workspaces, public.members, public.workstreams, public.tasks,
  public.designs, public.design_versions, public.decisions, public.resources,
  public.activity_events,
  public.scanner_runs
from public, anon, authenticated;

grant select on table
  public.workspaces, public.members, public.workstreams, public.tasks,
  public.designs, public.design_versions, public.decisions, public.resources,
  public.activity_events,
  public.scanner_runs
to authenticated;

grant update on table public.workspaces to authenticated;
grant insert, update on table public.members to authenticated;
grant insert, update on table
  public.workstreams, public.tasks, public.designs, public.design_versions,
  public.decisions, public.resources
to authenticated;

-- The authenticated Hub can use legacy records through membership RLS. These
-- grants add authenticated access without changing the old anon access.
grant select, insert, update on table public.ideas to authenticated;
grant select on table public.triggers to authenticated;
revoke insert, update on table public.triggers from authenticated;
grant select on table public.activity to authenticated;
grant usage, select on sequence public.ideas_id_seq to authenticated;
revoke all privileges on sequence public.triggers_id_seq from authenticated;

-- The scheduled scanner uses service_role and needs only these explicit table
-- privileges. The role itself bypasses RLS, so keep that key server-side only.
grant select, insert, update on table public.triggers, public.scanner_runs
to service_role;
grant usage, select on sequence public.triggers_id_seq to service_role;

revoke all on function app_private.member_role_rank(text) from public, anon, authenticated;
revoke all on function app_private.has_workspace_role(uuid, text) from public, anon, authenticated;
revoke all on function app_private.has_workspace_role_text(text, text) from public, anon, authenticated;
grant execute on function app_private.has_workspace_role(uuid, text) to authenticated;
grant execute on function app_private.has_workspace_role_text(text, text) to authenticated;

revoke all on function app_private.set_updated_at() from public, anon, authenticated;
revoke all on function app_private.stamp_actor() from public, anon, authenticated;
revoke all on function app_private.stamp_idea_actor() from public, anon, authenticated;
revoke all on function app_private.stamp_design_version_actor() from public, anon, authenticated;
revoke all on function app_private.stamp_membership_actor() from public, anon, authenticated;
revoke all on function app_private.protect_workspace_server_fields() from public, anon, authenticated;
revoke all on function app_private.guard_trigger_server_fields() from public, anon, authenticated;
revoke all on function app_private.prevent_workspace_move() from public, anon, authenticated;
revoke all on function app_private.manage_task_state_foundation() from public, anon, authenticated;
revoke all on function app_private.manage_decision_state() from public, anon, authenticated;
revoke all on function app_private.guard_membership_change() from public, anon, authenticated;
revoke all on function app_private.audit_row_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private design asset bucket. Paths must be:
--   <workspace UUID>/designs/<design UUID>/<filename>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'design-assets',
  'design-assets',
  false,
  52428800,
  array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists design_assets_member_read on storage.objects;
create policy design_assets_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'design-assets'
    and split_part(name, '/', 2) = 'designs'
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'viewer')
  );

drop policy if exists design_assets_member_insert on storage.objects;
create policy design_assets_member_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'design-assets'
    and split_part(name, '/', 2) = 'designs'
    and split_part(name, '/', 3) <> ''
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'member')
    and exists (
      select 1 from public.designs d
      where d.workspace_id::text = split_part(name, '/', 1)
        and d.id::text = split_part(name, '/', 3)
        and d.archived_at is null
    )
  );

drop policy if exists design_assets_member_update on storage.objects;
create policy design_assets_member_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'design-assets'
    and split_part(name, '/', 2) = 'designs'
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'member')
  )
  with check (
    bucket_id = 'design-assets'
    and split_part(name, '/', 2) = 'designs'
    and split_part(name, '/', 3) <> ''
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'member')
    and exists (
      select 1 from public.designs d
      where d.workspace_id::text = split_part(name, '/', 1)
        and d.id::text = split_part(name, '/', 3)
        and d.archived_at is null
    )
  );

drop policy if exists design_assets_admin_delete on storage.objects;
create policy design_assets_admin_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'design-assets'
    and split_part(name, '/', 2) = 'designs'
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'admin')
  );

-- Query indexes used by the Hub views and policies.
create index if not exists members_user_active_idx
  on public.members (user_id, workspace_id) where archived_at is null;
create index if not exists workstreams_workspace_status_idx
  on public.workstreams (workspace_id, status, position) where archived_at is null;
create index if not exists tasks_workspace_status_idx
  on public.tasks (workspace_id, status, position) where archived_at is null;
create index if not exists tasks_owner_idx
  on public.tasks (workspace_id, owner_id) where archived_at is null;
create index if not exists ideas_workspace_status_idx
  on public.ideas (workspace_id, status) where archived_at is null;
create index if not exists triggers_workspace_used_idx
  on public.triggers (workspace_id, used, found_at desc) where archived_at is null;
create index if not exists designs_workspace_status_idx
  on public.designs (workspace_id, status, updated_at desc) where archived_at is null;
create index if not exists design_versions_design_idx
  on public.design_versions (workspace_id, design_id, version_number desc)
  where archived_at is null;
create index if not exists decisions_workspace_status_idx
  on public.decisions (workspace_id, status, updated_at desc) where archived_at is null;
create index if not exists resources_workspace_kind_idx
  on public.resources (workspace_id, kind, updated_at desc) where archived_at is null;
create index if not exists activity_events_workspace_time_idx
  on public.activity_events (workspace_id, occurred_at desc);
create index if not exists scanner_runs_workspace_time_idx
  on public.scanner_runs (workspace_id, started_at desc);

commit;
