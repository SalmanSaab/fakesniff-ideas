# Codex — migration 007 staging rehearsal

**Written by Codex, 5 September 2026. Prepared, not executed.**

Review target: Claude commit `6e7a761969fd822ec797e56216abcc9c83ed7ad6`.
The SQL passes static review. The original six browser-module regressions pass,
but two additional draft/identity regressions block frontend release. This is a
rehearsal plan, not permission to deploy or evidence that policies have run.

## Environment gate

Only use the [staging SQL editor](https://supabase.com/dashboard/project/ojbxrtxhlnmapdrwmaod/sql/new).
Check the actual URL immediately before each execution:

- Staging: `ojbxrtxhlnmapdrwmaod`.
- Production, never a target of this rehearsal: `kayxejofqyxoqlberrgw`.

The in-app browser reached Supabase's sign-in page during this review. Salman
must sign in himself; do not extract a dashboard token or ask him to paste one.
No SQL has been submitted. Stop for an unknown project, unexpected existing
007 objects, missing foundation helpers, or a security/approval prompt.

## Read-only preflight

Run this only once the staging session is available. It retrieves no credentials
or personal details. It checks only 007's actual dependencies, not 005 or 006.

```sql
select
  to_regclass('public.workspaces') as workspaces,
  to_regclass('public.members') as members,
  to_regclass('public.activity_events') as activity_events,
  to_regclass('auth.users') as auth_users,
  to_regclass('public.work_updates') as existing_work_updates,
  to_regprocedure('app_private.has_workspace_role(uuid,text)') as membership_helper,
  to_regprocedure('app_private.prevent_workspace_move()') as identity_guard,
  to_regprocedure('app_private.stamp_work_update()') as existing_update_stamp;

select count(*) >= 2 as two_existing_test_identities_available from auth.users;

select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
where p.oid in (
  to_regprocedure('app_private.has_workspace_role(uuid,text)'),
  to_regprocedure('app_private.prevent_workspace_move()')
);
```

Compare the installed helpers with 001's reviewed definitions. Before a fresh
007 run, `existing_work_updates` and `existing_update_stamp` should be null.
If not, inspect what is already installed rather than blindly reapplying.
Two existing Auth IDs are needed for rollback-only fixtures. Do not create
accounts or change real memberships simply to make the rehearsal pass.

## Installation and database checks are separate acts

After the review gate is cleared and the staging-only action is authorized:

1. Run only `migrations/20260905_007_work_updates.sql` in the verified staging
   editor. It owns its `BEGIN` / `COMMIT` and schema-cache notification. It is
   **not** rollback-only and must not be pasted inside the test transaction.
2. Inspect the resulting columns, enabled RLS, policies and triggers. Expected:
   three policies (viewer-level SELECT, author INSERT, author UPDATE), two
   triggers (stamp and identity guard), no DELETE policy or audit trigger.
3. Run `tests/sql/work-updates-rehearsal.sql` as one complete script. It uses
   existing Auth IDs only in new fixture workspaces, switches actual SQL roles,
   verifies `auth.uid()`, and tests the real policies/column grants. It ends with
   `ROLLBACK`; no fixture reports, workspaces or memberships should persist.
4. If the editor stops on a failed assertion, run `ROLLBACK;` in the same
   session. Record the failure; do not weaken the policy or skip the assertion.

The script checks caller permissions, every server-owned metadata column,
whitespace and length boundaries, own edits/no-op edits, author isolation,
cross-workspace isolation, viewer/nonmember/archived access, anonymous denial,
and absence of copied report content in `activity_events`. Its temporary test
helpers are SECURITY INVOKER, not a privileged substitute for the caller.

SQL-role simulation does not test bearer-token validation or browser behavior.
Do not call those verified merely because the rollback script passes.

## Staging browser acceptance

Only after both JavaScript suites and the database rehearsal pass, arrange the
separate staging frontend deployment. Keep the TEST COPY marker and staging
configuration. Do not deploy production as a side effect.

- Use a real staging session to post, reopen and correct a short test update.
- Retry a failed read/save without losing text or manufacturing duplicates.
- Verify a second member can read but not rewrite it; a viewer cannot post.
- Verify no-token, malformed/expired-token and authenticated-nonmember HTTP
  requests fail closed. Use configured test sessions, not copied production keys.
- Verify sign-out/role/account changes clear private UI and old requests do not
  repopulate it.
- Salman/Emiel perform the phone loop: find the genuine assigned next action,
  write an update, and let the other person find it by opening/refreshing Home.
  Remind them that this release sends no notifications.

Report separately: code tests, browser fixtures, installed-schema assertions,
real authenticated browser checks and the employee's phone result. No production
release or migration 003/006 execution is included here.
