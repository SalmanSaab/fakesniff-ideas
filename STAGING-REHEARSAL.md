# Staging rehearsal — run the migrations somewhere safe first

Goal: prove migrations 001 → 002 → 003 work, on a throwaway database, **without ever touching
the live one**. If something is wrong we find it here, not on the board Marco and Emiel use.

Everything below is copy-paste into the Supabase **SQL Editor**. Nothing here needs a terminal,
so it all works from a phone.

**Rule for the whole document: this is the STAGING project. Never run any of this on the live
`kayxejofqyxoqlberrgw` project.** Check the project name in the top-left before every paste.

---

## Step 0 — make the throwaway project (2 min)

1. supabase.com → **New project**
2. Name it **`fakesniff-staging`** (so it is unmistakable)
3. Any database password, any region. Free tier is fine.
4. Wait for it to finish provisioning.
5. **Settings → API** → copy the **Project URL** and the **anon/publishable key**, send them to
   Claude. Do **not** send the `service_role` / secret key.

Delete this project once we are done. It exists only to be broken safely.

---

## Step 1 — create the original board schema

Migration 001 **expands existing tables** — it assumes `ideas`, `triggers` and `activity` already
exist. On a brand-new project they do not, so 001 would fail immediately. Create them first.

Paste the full contents of **`schema.sql`** into the SQL Editor and run it.

**Verify** (should return 3 rows: activity, ideas, triggers):
```sql
select table_name from information_schema.tables
where table_schema='public' order by table_name;
```

---

## Step 2 — put some fake data in

The migrations backfill existing rows, so rehearsing on empty tables would skip the risky part.
This is invented data, nothing real.

```sql
insert into ideas (line, concept, category, status, risk, added_by)
values ('test line one','a test concept','social','new','clean','Salman'),
       ('test line two','another concept','film','interesting','check','Emiel');

insert into triggers (title, url, source, category, used)
values ('a test headline long enough to pass','https://example.com/a','r/test','social',false),
       ('second test headline for the feed','https://example.com/b','example.com','film',true);

insert into activity (who, what, idea_id)
values ('Salman','added "test line one"', 1);
```

**Verify** (expect 2 / 2 / 1):
```sql
select (select count(*) from ideas) as ideas,
       (select count(*) from triggers) as triggers,
       (select count(*) from activity) as activity;
```

---

## Step 3 — run migration 001 (foundation)

Paste **`migrations/20260811_001_hub_v1_foundation.sql`** and run.

Supabase may warn about destructive operations — that is the `drop policy if exists` cleanup, it
is expected here.

**Verify the new tables exist:**
```sql
select table_name from information_schema.tables
where table_schema='public' order by table_name;
```
Expect the originals **plus**: workspaces, members, workstreams, tasks, designs, design_versions,
decisions, resources, activity_events, scanner_runs.

**Verify the backfill worked** — every old row should now belong to the workspace, and the old
activity should have been copied into the audit table:
```sql
select
  (select count(*) from ideas    where workspace_id is null) as ideas_missing_ws,
  (select count(*) from triggers where workspace_id is null) as triggers_missing_ws,
  (select count(*) from activity where workspace_id is null) as activity_missing_ws,
  (select count(*) from activity_events)                     as copied_events;
```
**All three "missing" numbers must be 0**, and `copied_events` should be at least 1.

**Verify the old board still works** (this is the whole point of 001 being non-breaking):
```sql
select count(*) from ideas;
```
plus, if you want the real check, open the live-style board against the staging URL/key and
confirm it still reads and writes.

---

## Step 4 — run migration 002 (work module)

Paste **`migrations/20260811_002_hub_v1_work_module.sql`** and run.

**Verify the task fields and rules landed** (expect 9):
```sql
select count(*) from information_schema.columns
where table_name='tasks'
  and column_name in ('kind','source_design_id','approver_id','due_on','next_action',
                      'completion_condition','flags','source_url','latest_file_url');
```

**Verify the workstreams were seeded** (expect 6):
```sql
select name, slug from workstreams order by position;
```

---

## Step 5 — set up a user (needed before 003 will run)

Migration 003 refuses to run unless a real signed-in owner exists. So:

1. **Authentication → Providers → Email**: make sure email sign-in is on.
2. **Authentication → Users → Add user** → create one with your email. (In staging you can tick
   "auto confirm".)
3. Make that user an owner. Paste this and run:
```sql
insert into members (workspace_id, user_id, display_name, role)
select '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', id, 'Salman', 'owner'
from auth.users
order by created_at
limit 1
on conflict (workspace_id, user_id) do update set role = 'owner';
```

**Verify** (expect one row, role = owner):
```sql
select display_name, role from members;
```

---

## Step 6 — satisfy the last two 003 preflight checks

003 also insists a scanner run has succeeded, and that no active task is missing a due date.
In staging we fake the scanner run:

```sql
insert into scanner_runs (workspace_id, external_run_id, status, finished_at)
values ('6b9f4ba4-e480-4c08-b67e-4d389db3f9d1','staging-rehearsal','succeeded', now());
```

**Verify nothing will block** (all three should be 0 / 1 / 0):
```sql
select
  (select count(*) from tasks
     where archived_at is null
       and status in ('this_week','doing','review','waiting')
       and due_on is null)                                   as tasks_missing_due,
  (select count(*) from scanner_runs where status='succeeded') as good_scans,
  (select count(*) from members where role='owner' and archived_at is null) - 1 as owners_minus_one;
```

---

## Step 7 — run migration 003 (the cutover) — STAGING ONLY

**This is the one that switches the anonymous board off.** We are only proving it runs cleanly.
**Do not run this on production until Salman is back and the hub is verified.**

Paste **`migrations/20260811_003_hub_v1_access_cutover.sql`** and run.

**Verify the anon policies are gone** (expect 0 rows):
```sql
select policyname, tablename from pg_policies
where schemaname='public' and policyname in ('ideas_all','triggers_all','activity_all');
```

**Verify the expected failure**: with the staging URL + anon key, the old board should now fail to
read. That failure is the migration working correctly, not a bug.

---

## What to send back

After each step, paste the verification output. If any step errors, **stop and send the exact
error** — do not run the next one. That error is exactly what this rehearsal exists to find, and
it is far better found here than on the live database.

## When it is all done
Delete the `fakesniff-staging` project. Nothing in it is worth keeping.
