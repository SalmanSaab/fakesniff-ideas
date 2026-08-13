-- Claude — 2026-08-13
-- FAKESNIFF Hub: make Decisions usable, and usable in a factory.
--
-- Correction to my own first draft. Migration 001 already creates
-- public.decisions — I did not check, wrote a second CREATE TABLE, and
-- `if not exists` silently skipped it before an index failed on a column that
-- was never added. The whole thing rolled back, which is the only reason this
-- is a footnote rather than an incident. This version does not create anything
-- that already exists.
--
-- Two jobs:
--
-- 1. The table is currently unusable. 001 enables row level security on it but
--    never adds a policy or a grant, so it fails closed and nobody — member,
--    admin or owner — can read or write a single row. Safe, but dead.
--
-- 2. The fields it has are for a company decision log tied to workstreams and
--    member records. What is needed on 24 Aug is a factory notebook: which
--    supplier, what kind of decision, and the photograph it refers to. Those
--    are added here, all nullable, so nothing already written stops working.
--
-- Additive and non-breaking. Run after 001, 002 and 004. Independent of 003.

begin;

-- ---------------------------------------------------------------------------
-- 1. Access. Without this the table cannot be used at all.
--    Members read and write; viewers read only; nothing is ever deleted.
-- ---------------------------------------------------------------------------

alter table public.decisions enable row level security;

drop policy if exists decisions_member_select on public.decisions;
create policy decisions_member_select on public.decisions
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

drop policy if exists decisions_member_insert on public.decisions;
create policy decisions_member_insert on public.decisions
  for insert to authenticated
  with check (app_private.has_workspace_role(workspace_id, 'member'));

drop policy if exists decisions_member_update on public.decisions;
create policy decisions_member_update on public.decisions
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, 'member'))
  with check (app_private.has_workspace_role(workspace_id, 'member'));

revoke all privileges on table public.decisions from public, anon, authenticated;
grant select, insert, update on table public.decisions to authenticated;

-- The same gap exists on resources, created alongside decisions in 001 and
-- equally unreachable. Fixing one and leaving the other would just move the
-- surprise to whoever opens that screen next.
alter table public.resources enable row level security;

drop policy if exists resources_member_select on public.resources;
create policy resources_member_select on public.resources
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

drop policy if exists resources_member_insert on public.resources;
create policy resources_member_insert on public.resources
  for insert to authenticated
  with check (app_private.has_workspace_role(workspace_id, 'member'));

drop policy if exists resources_member_update on public.resources;
create policy resources_member_update on public.resources
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, 'member'))
  with check (app_private.has_workspace_role(workspace_id, 'member'));

revoke all privileges on table public.resources from public, anon, authenticated;
grant select, insert, update on table public.resources to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The factory fields. All nullable or defaulted: a decision recorded before
--    this migration stays valid, and a decision recorded in a hurry afterwards
--    only ever needs the title 001 already requires.
-- ---------------------------------------------------------------------------

alter table public.decisions add column if not exists topic text not null default 'other';
alter table public.decisions add column if not exists counterparty text not null default '';
alter table public.decisions add column if not exists decided_by_name text not null default '';
alter table public.decisions add column if not exists lookbook_item_id uuid;

comment on column public.decisions.counterparty is
  'The factory, supplier or agent this was agreed with. Free text on purpose: '
  'we have no suppliers table, and inventing one to record a name would stop '
  'people writing anything down.';
comment on column public.decisions.decided_by_name is
  'Who agreed it, as typed. Separate from owner_id because on the day the '
  'person entering the record is often not the person who decided, and may not '
  'be a Hub user at all.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.decisions'::regclass
      and conname = 'decisions_topic_allowed'
  ) then
    alter table public.decisions add constraint decisions_topic_allowed check (
      topic in ('fabric', 'price', 'moq', 'delivery', 'sample', 'quality',
                'supplier', 'packaging', 'design', 'brand', 'other')
    );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.decisions'::regclass
      and conname = 'decisions_counterparty_length'
  ) then
    alter table public.decisions add constraint decisions_counterparty_length
      check (char_length(counterparty) <= 160);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.decisions'::regclass
      and conname = 'decisions_decided_by_name_length'
  ) then
    alter table public.decisions add constraint decisions_decided_by_name_length
      check (char_length(decided_by_name) <= 160);
  end if;

  -- Composite so a decision can never point at another workspace's photo.
  -- Deliberately no ON DELETE SET NULL: the key includes workspace_id, which is
  -- NOT NULL, so "set null" would fail on the first delete it ever saw.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.decisions'::regclass
      and conname = 'decisions_lookbook_fk'
  ) then
    alter table public.decisions add constraint decisions_lookbook_fk
      foreign key (workspace_id, lookbook_item_id)
      references public.lookbook_items (workspace_id, id);
  end if;
end
$$;

-- What the screen actually asks for: this workspace, newest first, unarchived.
create index if not exists decisions_workspace_recent_idx
  on public.decisions (workspace_id, updated_at desc)
  where archived_at is null;

create index if not exists decisions_lookbook_idx
  on public.decisions (workspace_id, lookbook_item_id)
  where lookbook_item_id is not null;

commit;

-- PostgREST caches the schema and will not see these columns until it reloads.
-- After 001 it served a stale cache for several minutes and reported tables it
-- had just been given as missing. Run this if the Hub cannot see the new fields:
--   notify pgrst, 'reload schema';
