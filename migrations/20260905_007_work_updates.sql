-- FAKESNIFF Hub — migration 007: work updates
--
-- Marco's 90-day plan, section 9: a short update at the end of a working day or
-- block, so he can see what happened without calling three people. Emiel asked
-- for the same thing unprompted the following day. Two of the three people, the
-- clearest build signal this project has produced.
--
-- What this is NOT, because each was considered and rejected:
--   - not a task system. The personal agenda comes from Work, which already has
--     owners, due dates and next actions.
--   - not a calendar. A report is dated by the server when it is written.
--   - not an audit feed. audit_row_change is deliberately not attached; it would
--     copy the whole text into activity_events, which Home already reads.
--
-- Independent of migration 006 in both directions. 007 neither reads nor alters
-- anything 006 creates, and 006's RPCs are not extended to carry updates. If 006
-- is closed or hidden the numbering gap is intentional and harmless.
--
-- Codex second read, 5 Sep, produced two corrections that are applied here and
-- both were real:
--   1. whole-table INSERT/UPDATE grants would have let a caller supply
--      created_at, reported_on, edited_at and archive a report. Defaults do not
--      protect a column against an explicit value. Column-level grants now do.
--   2. trim() without an explicit character set removes spaces only, so a
--      report of nothing but newlines or tabs would have passed the blank check.

begin;

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table if not exists public.work_updates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,

  -- Authorship comes from the session, never the request body. The default is
  -- convenience; the insert policy below is what actually enforces it.
  author_id     uuid not null default auth.uid()
                  references auth.users(id) on delete restrict,

  -- Three fields rather than one body. Marco's stated need is to identify the
  -- result, the blocker and the next step in about a minute; a single blob
  -- makes that a reading exercise every time it is opened.
  done          text not null default '',
  open          text not null default '',
  next          text not null default '',

  -- Europe/Amsterdam, not UTC. A report written at 00:30 in Leeuwarden is still
  -- that working block, while UTC has already moved to the previous date. The
  -- same zone migration 002 used when converting due_at.
  reported_on   date not null
                  default (now() at time zone 'Europe/Amsterdam')::date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Null until the author changes the content. This is the edited marker; the
  -- interface reads it and nothing else depends on it.
  edited_at     timestamptz,

  -- Present so this table matches every other one in the schema. No interface
  -- uses it in this release and no delete policy exists. A mistaken report is
  -- corrected by editing it.
  archived_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- Constraints
--
-- Both names go into humanUpdateError with English and Dutch sentences. A
-- constraint name reaching Marco is always a bug, including one we did not
-- predict.
-- ---------------------------------------------------------------------------

-- Not every prompt has to be filled — only that the report is not blank.
-- `~ '\S'` means "contains at least one non-whitespace character", which
-- correctly rejects a report of spaces, tabs or newlines. trim(x) = '' would
-- have accepted tabs and newlines, because PostgreSQL's one-argument trim
-- removes spaces and nothing else.
alter table public.work_updates drop constraint if exists work_updates_not_empty;
alter table public.work_updates add constraint work_updates_not_empty
  check (done ~ '\S' or open ~ '\S' or next ~ '\S');

-- The cap protects the one-minute read as much as the database.
alter table public.work_updates drop constraint if exists work_updates_length;
alter table public.work_updates add constraint work_updates_length
  check (
    length(done) <= 1000
    and length(open) <= 1000
    and length(next) <= 1000
  );

-- The feed is always "this workspace, newest first".
create index if not exists work_updates_feed_idx
  on public.work_updates (workspace_id, reported_on desc, created_at desc);

-- ---------------------------------------------------------------------------
-- Server-owned columns
--
-- The column grants below are the real protection. This trigger is the second
-- line: if a grant is ever widened by mistake, authorship and dates still
-- cannot be rewritten through the API.
-- ---------------------------------------------------------------------------

create or replace function app_private.stamp_work_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();

  if new.done is distinct from old.done
     or new.open is distinct from old.open
     or new.next is distinct from old.next
  then
    new.edited_at := now();
  else
    -- A no-op update must not invent an edit. Someone saving without changing
    -- anything has not edited their report.
    new.edited_at := old.edited_at;
  end if;

  new.author_id   := old.author_id;
  new.reported_on := old.reported_on;
  new.created_at  := old.created_at;

  return new;
end;
$$;

-- Codex, 5 Sep: consistency hardening rather than a currently exposed RPC.
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, and a
-- SECURITY DEFINER function that is callable by anyone is the shape of problem
-- worth closing before it is one.
revoke all on function app_private.stamp_work_update() from public, anon, authenticated;

drop trigger if exists work_updates_stamp on public.work_updates;
create trigger work_updates_stamp
  before update on public.work_updates
  for each row execute function app_private.stamp_work_update();

-- Same guard every other table gets: workspace and row id are immutable.
drop trigger if exists work_updates_prevent_workspace_move on public.work_updates;
create trigger work_updates_prevent_workspace_move
  before update on public.work_updates
  for each row execute function app_private.prevent_workspace_move();

-- audit_row_change is deliberately NOT attached. See the header.

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.work_updates enable row level security;

-- Anyone who can see the workspace can read the team's reports. Marco reading
-- must never require the right to post, so this is viewer-level on purpose.
drop policy if exists work_updates_member_select on public.work_updates;
create policy work_updates_member_select on public.work_updates
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

-- You may only write as yourself.
drop policy if exists work_updates_author_insert on public.work_updates;
create policy work_updates_author_insert on public.work_updates
  for insert to authenticated
  with check (
    app_private.has_workspace_role(workspace_id, 'member')
    and author_id = auth.uid()
  );

-- You may only correct your own. Neither an admin nor another member gains the
-- right to rewrite somebody else's account of their own work.
drop policy if exists work_updates_author_update on public.work_updates;
create policy work_updates_author_update on public.work_updates
  for update to authenticated
  using (
    app_private.has_workspace_role(workspace_id, 'member')
    and author_id = auth.uid()
  )
  with check (
    app_private.has_workspace_role(workspace_id, 'member')
    and author_id = auth.uid()
  );

-- No delete policy. Deletion is not part of this release.

-- ---------------------------------------------------------------------------
-- Grants — column level, not whole table
--
-- A whole-table insert grant would let a caller supply created_at, reported_on
-- or edited_at, and a whole-table update grant would let them archive a report
-- through the API. Column defaults do not protect a column against an explicit
-- request value; only the grant does.
--
-- `id` is insertable so the browser can retry the same submission after an
-- uncertain POST without creating a second report.
-- ---------------------------------------------------------------------------

revoke all privileges on table public.work_updates from public, anon, authenticated;

grant select on table public.work_updates to authenticated;
grant insert (id, workspace_id, done, open, next)
  on table public.work_updates to authenticated;
grant update (done, open, next)
  on table public.work_updates to authenticated;

commit;

-- PostgREST caches the schema. Without this the new table is invisible to the
-- browser until the cache happens to expire, which reads as "the deploy did
-- nothing" and has cost us an evening before.
notify pgrst, 'reload schema';
