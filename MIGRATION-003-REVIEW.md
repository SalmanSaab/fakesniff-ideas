# Migration 003 cutover review

Reviewed by Codex on 13 August 2026. This was a read-only review of
`migrations/20260811_003_hub_v1_access_cutover.sql`; migration 003 was not run
or changed.

## Decision

**Do not run migration 003 on the live production project before the
fortnight away. The public idea board does not survive it.**

The page at `index.html` would still open, but it would no longer load or save
ideas, load or mark raw material, or load or write activity. An already-open
tab may keep stale rows on screen even after refreshes start failing. Normally
an error appears within 30 seconds (later in a throttled background tab), and
every new write fails immediately. Reloading the page leaves the data areas
empty. That is not a working fallback.

Migration 003 intentionally retires anonymous access. It has no built-in
rollback switch: after it commits, restoring the fallback requires the
compensating SQL below.

## What a signed-in Hub user sees

A valid signed-in user with an active workspace membership should not lose the
authenticated Hub when 003 lands:

- Home and Work use `workspaces`, `members`, `workstreams`, and `tasks`.
  Migration 003 does not alter those tables or their permissions.
- Idea Lab inside the Hub sends the signed-in user's token, states its
  `workspace_id`, and reads the new `activity_events` feed. Migration 003 keeps
  the authenticated grants that this path needs.
- Lookbook is unaffected by 003. It separately requires migration 004 and its
  private-storage setup, which 003 does not touch.
- Existing viewer/member/admin/owner rules remain in force. A signed-in person
  without an active membership remains blocked, as they were before 003.

That conclusion is from source and SQL review. The complete signed-in
create-to-approval rehearsal is still waiting for an attached authenticated
browser session.

There is one important trap: signing into `hub.html` does not authenticate
`index.html`. The public board always sends the hard-coded anonymous key.
`fs_who` is only a locally saved display name. A signed-in user who opens the
public board therefore gets the same broken board as everyone else after the
production cutover. The standalone Idea Lab has the same anonymous fallback
and also stops working; only Idea Lab mounted inside the signed-in Hub survives.

## Why the public board stops

Migration 003 does all of the following in one transaction:

1. Drops the anonymous policies on `ideas`, `triggers`, and `activity`.
2. Revokes all table and sequence privileges from `anon` (and `PUBLIC`).
3. Restores access only for authenticated users and the scanner service role.
4. Removes the implicit FAKESNIFF `workspace_id` defaults.
5. Removes the old global `(title, source)` trigger key used by the legacy
   scanner.

`index.html` does not send a user session or a `workspace_id`. It loads all
three legacy tables together, so one denied request makes the whole refresh
fail. Its idea writes, `triggers.used` update, and activity write are denied as
well. Restoring only a policy or only a grant would not be sufficient; its
inserts also need the workspace defaults and sequence access restored.

### Check the target project

The cutover only affects the Supabase project in whose SQL editor it is run.
At the time of this review:

- `hub-config.js` points at the throwaway staging project
  `ojbxrtxhlnmapdrwmaod`.
- `index.html` points at the production project
  `kayxejofqyxoqlberrgw`.

Running 003 on staging therefore does not take down the production public
board. It also does not prove that the production cutover is safe. Verify the
project reference in the Supabase dashboard before either cutover or recovery.

## A second production risk: the scheduled scanner

The hardened scanner on this merged Hub branch is compatible with 003: it uses
the service-role credential, states a workspace, records a scanner run, and
conflicts on `(workspace_id, title, source)`.

The production/default `master` branch is still on the old scanner. GitHub
schedules run that default-branch version. It uses the anonymous key, omits
`workspace_id`, and conflicts on the old `(title, source)` key. Production 003
would stop that daily scanner too.

Do not bypass the migration's successful-scanner preflight. Before any future
production cutover, merge the hardened scanner and workflow to the default
branch, configure its production secrets, and observe a genuine successful run
from that deployed commit. A historical `scanner_runs` success by itself does
not prove that today's default-branch schedule is safe.

## Emergency public-board restore after a committed cutover

Use this only if migration 003 has already reported success and committed on
the same project used by `index.html`. It restores the operations the public
board actually performs while leaving RLS enabled and preserving the newer
authenticated and service-role access.

This deliberately makes the public anonymous key writable again. It is a
temporary fallback recovery, not the desired final security state.

First run this read-only check. It confirms that the database is in the clean,
committed migration-003 state that this recovery expects:

```sql
select
  not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and policyname in ('ideas_all', 'triggers_all', 'activity_all')
  ) as legacy_anon_policies_removed,
  not has_table_privilege('anon', 'public.ideas', 'SELECT')
    and not has_table_privilege('anon', 'public.triggers', 'SELECT')
    and not has_table_privilege('anon', 'public.activity', 'SELECT')
    as legacy_anon_reads_revoked,
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('ideas', 'triggers', 'activity')
      and column_name = 'workspace_id'
      and column_default is not null
  ) as legacy_workspace_defaults_removed,
  not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.triggers'::regclass
      and conname = 'triggers_title_source_key'
  ) as legacy_trigger_key_removed;
```

All four results must be `true`. If any is `false`, stop: either this is the
wrong project or its schema is not the clean post-003 state. Inspect it instead
of applying a generic inverse script.

```sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Restore the implicit workspace used by the legacy browser client.
alter table public.ideas
  alter column workspace_id
  set default '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid;
alter table public.triggers
  alter column workspace_id
  set default '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid;
alter table public.activity
  alter column workspace_id
  set default '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid;

-- Restore a FAKESNIFF-only anonymous fallback. This is narrower than the
-- original global anonymous policies.
drop policy if exists ideas_all on public.ideas;
create policy ideas_all on public.ideas
  for all to anon
  using (
    workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid
  )
  with check (
    workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid
  );

drop policy if exists triggers_all on public.triggers;
create policy triggers_all on public.triggers
  for all to anon
  using (
    workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid
  )
  with check (
    workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid
  );

drop policy if exists activity_all on public.activity;
create policy activity_all on public.activity
  for all to anon
  using (
    workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid
  )
  with check (
    workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'::uuid
  );

-- Minimum table operations used by index.html. No anonymous DELETE grant.
grant select, insert, update on table public.ideas to anon;
grant select, update on table public.triggers to anon;
grant select, insert on table public.activity to anon;

-- Identity sequences used by anonymous idea and activity inserts.
grant usage, select on sequence
  public.ideas_id_seq,
  public.activity_id_seq
to anon;

notify pgrst, 'reload schema';
commit;
```

`ALTER TABLE` takes a lock. The five-second lock timeout makes a busy database
fail instead of waiting indefinitely. If any statement fails, issue
`rollback;`, investigate, and retry the whole transaction. Do not continue with
a partly copied script.

Do not disable RLS, do not grant to `PUBLIC`, and do not rerun `schema.sql` or
migration 001 as a rollback.

### Current production scanner needs a second action

The public-board transaction above does not reopen anonymous trigger inserts
or recreate the obsolete global key. The current hardened scanner does not
need either one.

At the time of this review, production `master` still deploys the legacy
scanner. Restoring the board alone would therefore leave daily ingestion
broken. In addition to the first transaction, either deploy and verify the
hardened scanner immediately (preferred), or temporarily restore compatibility
for the legacy scanner with the steps below.

First check whether the old global key can be recreated safely:

```sql
select title, source, count(*) as copies
from public.triggers
where source is not null
group by title, source
having count(*) > 1
order by copies desc, title, source;
```

If that query returns any row, stop. Do not delete data to force the constraint.
Deploy the hardened scanner instead. If it returns no rows, run:

```sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.triggers
  add constraint triggers_title_source_key unique (title, source);

grant select, insert on table public.triggers to anon;
grant usage, select on sequence public.triggers_id_seq to anon;

notify pgrst, 'reload schema';
commit;
```

This second transaction is only for temporary compatibility with the old
anonymous scanner. The preferred fix is to deploy and verify the hardened
workspace-aware scanner.

## Verify the emergency restore

Run these read-only checks in the same project after the recovery transaction:

```sql
select
  has_table_privilege('anon', 'public.ideas', 'SELECT')
    as ideas_read,
  has_table_privilege('anon', 'public.ideas', 'INSERT')
    as ideas_add,
  has_table_privilege('anon', 'public.ideas', 'UPDATE')
    as ideas_edit,
  has_table_privilege('anon', 'public.triggers', 'SELECT')
    as triggers_read,
  has_table_privilege('anon', 'public.triggers', 'UPDATE')
    as triggers_mark_used,
  has_table_privilege('anon', 'public.activity', 'SELECT')
    as activity_read,
  has_table_privilege('anon', 'public.activity', 'INSERT')
    as activity_add,
  has_sequence_privilege('anon', 'public.ideas_id_seq', 'USAGE')
    as ideas_ids,
  has_sequence_privilege('anon', 'public.activity_id_seq', 'USAGE')
    as activity_ids,
  not has_table_privilege('anon', 'public.ideas', 'DELETE')
    as ideas_delete_denied,
  not has_table_privilege('anon', 'public.triggers', 'DELETE')
    as triggers_delete_denied,
  not has_table_privilege('anon', 'public.activity', 'DELETE')
    as activity_delete_denied;

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and policyname in ('ideas_all', 'triggers_all', 'activity_all')
order by tablename;

select table_name, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('ideas', 'triggers', 'activity')
  and column_name = 'workspace_id'
order by table_name;
```

The first query should return `true` in every column. The second should show
three `ALL` policies for `{anon}`, with both expressions restricted to the
FAKESNIFF workspace UUID. The third should show that UUID as all three
defaults.

Then open `index.html` in a signed-out/incognito browser. Ideas, Raw Material,
and Activity must all load. A real create/update check changes production data,
so do that only deliberately with a clearly named test idea and clean it up
from privileged SQL afterward.

## Transaction rule

If a preflight assertion inside 003 fails before its `commit`, the transaction
does not apply the cutover. Issue `rollback;` if the SQL session is still in an
aborted transaction and fix the failed precondition; do not run the recovery
script.

If 003 reaches its own `commit`, a later `rollback;` cannot undo it. The inverse
statements above are then the concrete recovery path.

## Safe go/no-go rule

Production 003 is a **no-go** until all of these are true:

1. The fortnight fallback is no longer required, or the team deliberately
   accepts that `index.html` will be retired.
2. The authenticated Hub has passed the real member workflow rehearsal.
3. Every team member can sign in and has the intended active role.
4. The hardened scanner is on the production default branch with its secrets,
   and a run from that deployment has succeeded.
5. An operator with access to the verified production project is available to
   run the emergency restore if needed.

For the current Friday decision: leave production migration 003 unapplied.
