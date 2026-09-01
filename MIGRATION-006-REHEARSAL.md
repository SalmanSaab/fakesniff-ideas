# Migration 006 staging rehearsal

**Written by Codex — 1 September 2026.**

## Decision

Keep migration 006 and rehearse it on the throwaway staging project now. Do
not run it on production yet.

The deployed Home screen already calls `get_home_changes` and
`ack_home_changes`. Without 006, “Since your last look” can only fall into its
friendly failure state. Retiring the migration would therefore also require
removing that shipped feature. The original reason for holding 006—Salman being
away and unable to respond—is over.

Migration 003 remains completely out of scope.

## Environment identity

- Staging project ref: `ojbxrtxhlnmapdrwmaod`
- Production project ref: `kayxejofqyxoqlberrgw`
- Fixed workspace: `6b9f4ba4-e480-4c08-b67e-4d389db3f9d1`

Before every SQL run, read the project ref in the Supabase dashboard URL. Stop
if it is not the staging ref above.

## Gate before 006

1. Record the decision in the Hub Decisions module.
2. Confirm the project is staging and create a recoverable staging backup or
   snapshot.
3. Run this read-only preflight:

```sql
select
  to_regclass('public.workspaces') as workspaces,
  to_regclass('public.members') as members,
  to_regclass('public.tasks') as tasks,
  to_regclass('public.decisions') as decisions,
  to_regclass('public.lookbook_items') as lookbook_items,
  to_regclass('public.activity_events') as activity_events,
  to_regclass('public.home_feed_state') as existing_home_feed_state,
  to_regclass('public.home_event_receipts') as existing_home_event_receipts,
  to_regprocedure('public.get_home_changes(uuid,uuid,integer)') as existing_get_rpc,
  to_regprocedure('public.ack_home_changes(uuid,uuid,uuid[])') as existing_ack_rpc,
  to_regprocedure('public.get_home_changes(uuid,integer)') as old_get_overload,
  to_regprocedure('public.ack_home_changes(uuid,uuid[])') as old_ack_overload;

select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'decisions'
  and column_name in ('topic', 'counterparty', 'decided_by_name', 'lookbook_item_id')
order by column_name;

select user_id, display_name, role, archived_at
from public.members
where workspace_id = '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1'
order by archived_at nulls first, display_name;

select event_object_table, trigger_name
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('tasks', 'decisions')
order by event_object_table, trigger_name;

select indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'activity_events'
order by indexname;

select
  has_schema_privilege('anon', 'public', 'CREATE') as anon_can_create,
  has_schema_privilege('authenticated', 'public', 'CREATE') as authenticated_can_create;
```

Expected before continuing:

- migrations 001, 002 and 004 objects exist;
- all four 005 columns are returned;
- at least two active `member`, `admin` or `owner` rows exist;
- task and decision audit triggers plus the workspace/time activity index exist;
- both CREATE checks are false;
- no `home_*` table, current RPC or old overload exists.

Current records say staging has 001, 002 and 004 but not 005. If the four
decision columns are absent, run and verify
`migrations/20260813_005_decisions.sql` separately, issue
`notify pgrst, 'reload schema';`, and repeat the preflight. Do not combine 005
and 006 into one opaque run.

## Apply

Run only `migrations/20260813_006_home_changes.sql` in the staging SQL editor.
The file owns its transaction and sends the PostgREST schema reload notice.

## Catalog verification

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('home_feed_state', 'home_event_receipts')
order by c.relname;

select tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename in ('home_feed_state', 'home_event_receipts');

select
  role_name,
  has_table_privilege(role_name, 'public.home_feed_state', 'SELECT,INSERT,UPDATE,DELETE')
    as home_state_direct_access,
  has_table_privilege(role_name, 'public.home_event_receipts', 'SELECT,INSERT,UPDATE,DELETE')
    as receipt_direct_access
from unnest(array['anon', 'authenticated']) as role_name;

select
  p.oid::regprocedure::text as signature,
  p.prosecdef as security_definer,
  p.proowner::regrole::text as owner,
  p.proconfig as fixed_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_home_changes', 'ack_home_changes')
order by p.oid::regprocedure::text;

select
  to_regprocedure('public.get_home_changes(uuid,integer)') as old_get_overload,
  to_regprocedure('public.ack_home_changes(uuid,uuid[])') as old_ack_overload;
```

Expected:

- both tables have RLS enabled, no browser policies and no direct anon or
  authenticated table privileges;
- both current RPCs are `SECURITY DEFINER`, owned by the trusted migration
  owner, fix `search_path` and `row_security`, deny anon and allow
  authenticated execution;
- both old overloads are null.

## Runtime boundary rehearsal

Use two active staging members, A and B, and controlled records that are
removed or rolled back afterwards.

1. With no token and with the anon key, both RPCs fail closed and return no
   workspace information.
2. A valid authenticated nonmember, a mismatched `p_expected_user_id`, and a
   foreign workspace ID fail with generic `42501` behavior and create no state.
3. Create controlled transitions for:
   - a task entering Waiting, owned by A;
   - a task entering Review, with B as the separate approver;
   - a proposed decision;
   - the same or another decision becoming Decided.
4. Put a unique sentinel in a private field such as task description. Confirm
   it never appears in the RPC JSON. Returned item keys must be limited to
   `eventId`, `kind`, `entityId`, `title`, `actorName`, `occurredAt`,
   `needsYou` and `receiptEventIds`.
5. Confirm `needsYou` is true only for the relevant owner/approver.
6. A acknowledges the exact displayed receipt IDs. A no longer sees them, B
   still does. A duplicate acknowledgement returns zero new receipts.
7. Foreign-workspace and unrelated event IDs acknowledge zero rows.
8. Resolved or archived current records disappear from the feed.
9. More than five distinct eligible items sets `hasMore`; limits 0 and 999 are
   clamped to 1 and 10.
10. Repeated transitions for one entity return one visible item with all exact
    receipt IDs needed to prevent it resurfacing.

## Browser rehearsal

On the deployed staging Hub, test desktop and an iPhone-sized viewport:

1. First Home visit loads without the “couldn’t check recent changes” state.
2. A controlled Waiting/Review/Decision event appears with only the intended
   human summary.
3. The event is acknowledged only after at least 60% of its row is visible.
4. Reloading and opening another device/session for the same member does not
   repeat an acknowledged event.
5. Member B still sees their own unacknowledged copy.
6. An empty visit records its opened state and the retry/error copy remains
   friendly when the request is deliberately made unavailable.

## Production hold

Do not run 006 on production merely because staging applied cleanly. Preserve
the staging SQL output, browser evidence and any corrections for a second read.
Production needs its own explicit decision and run window. Migration 003 stays
untouched.

## Known non-blocking debt

- The receipt foreign key is not composite with `workspace_id`; direct writes
  are nevertheless revoked and the only permitted RPC rechecks the workspace.
- Receipt arrays and historical event scans can grow with a long-lived entity.
  This is acceptable for three users now, but measure it before wider use.
- A rare transaction begun before the Amsterdam midnight baseline and committed
  afterwards can fall before a first visitor's cutoff.

