-- Codex — 2026-09-05: installed-schema rehearsal for work updates (007).
-- This file is Codex. Preparation only: writing/reviewing it is not a runtime pass.
--
-- STAGING ONLY. Before executing, manually verify the dashboard URL is
-- https://supabase.com/dashboard/project/ojbxrtxhlnmapdrwmaod/sql
-- (a query-specific suffix is fine). Neither current_database() nor a literal
-- inside this script proves which Supabase project the connection belongs to.
-- Do not run this in production or on an unidentified SQL connection.
--
-- Prerequisites: 001 helpers and 007 are already installed on that staging
-- project; a privileged SQL-editor session can SET ROLE authenticated/anon;
-- at least two existing auth.users rows are available. No Auth account is
-- created, no credentials are changed, and no real membership is modified.
-- The two existing user IDs are used only in new, rollback-only workspaces.
--
-- This DOES NOT install a migration. In particular, do not paste 007 into
-- this transaction: its own COMMIT would defeat the rehearsal's ROLLBACK.
-- 003 and 006 are neither required nor run here.
--
-- Run the whole file in one session. A PASS result appears before ROLLBACK.
-- If any assertion fails and the editor stops before the final ROLLBACK,
-- execute ROLLBACK; immediately in that same session. All fixture changes,
-- temporary helper functions/grants and simulated claims are transactional.
-- SQL role simulation verifies the database boundary, not HTTP token parsing
-- or the signed-in browser flow; those still need their own staging check.

begin;
set local statement_timeout = '60s';
set local lock_timeout = '5s';
set local row_security = on;

-- Helpers are SECURITY INVOKER: SQL inside expect_error uses the caller's
-- actual SET ROLE identity. A SECURITY DEFINER test helper would bypass RLS.
create function pg_temp.updates_require(ok boolean, description text)
returns void language plpgsql security invoker as $$
begin
  if ok is distinct from true then
    raise exception 'Work updates rehearsal failed: %', description;
  end if;
end;
$$;

create function pg_temp.updates_expect_error(
  statement text, expected_state text, description text,
  expected_constraint text default null
)
returns void language plpgsql security invoker as $$
declare
  actual_state text;
  actual_constraint text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate,
      actual_constraint = constraint_name;
  end;
  perform pg_temp.updates_require(actual_state = expected_state,
    format('%s: expected SQLSTATE %s, got %s', description, expected_state,
      coalesce(actual_state, 'SUCCESS')));
  if expected_constraint is not null then
    perform pg_temp.updates_require(actual_constraint = expected_constraint,
      format('%s: wrong constraint (%s)', description,
        coalesce(actual_constraint, 'none')));
  end if;
end;
$$;

-- Permit the simulated callers to invoke only these temporary test helpers.
-- This grants nothing on the actual application schema or tables.
do $$
begin
  execute format('grant usage on schema %I to authenticated, anon',
    (select nspname from pg_namespace where oid = pg_my_temp_schema()));
end;
$$;
grant execute on function pg_temp.updates_require(boolean, text)
  to authenticated, anon;
grant execute on function pg_temp.updates_expect_error(text, text, text, text)
  to authenticated, anon;

do $rehearsal$
declare
  operator_role text := current_user;
  actors uuid[];
  actor_a uuid;
  actor_b uuid;
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
  report_a uuid := gen_random_uuid();
  report_b uuid := gen_random_uuid();
  report_other_workspace uuid := gen_random_uuid();
  column_name text;
  supplied_value text;
  sample text;
  permission_name text;
  before_row record;
  after_row record;
  affected integer;
  groups_passed integer := 0;
begin
  -- 1. Effective permissions, not just the spelling of GRANT in a source file.
  perform pg_temp.updates_require(to_regclass('public.work_updates') is not null,
    '007 must already be installed in staging');
  perform pg_temp.updates_require(
    not exists (select 1 from pg_roles where rolname in ('authenticated', 'anon')
      and (rolsuper or rolbypassrls)), 'simulated callers must not bypass RLS');
  perform pg_temp.updates_require(
    (select relrowsecurity and pg_get_userbyid(relowner) not in ('authenticated', 'anon')
     from pg_class where oid = 'public.work_updates'::regclass),
    'RLS must be enabled and neither caller may own the table');
  perform pg_temp.updates_require(
    has_table_privilege('authenticated', 'public.work_updates', 'SELECT')
    and not has_table_privilege('authenticated', 'public.work_updates', 'INSERT')
    and not has_table_privilege('authenticated', 'public.work_updates', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.work_updates', 'DELETE'),
    'authenticated has SELECT but no whole-table write/delete privilege');
  foreach column_name in array array[
    'id', 'workspace_id', 'author_id', 'done', 'open', 'next', 'reported_on',
    'created_at', 'updated_at', 'edited_at', 'archived_at'
  ] loop
    perform pg_temp.updates_require(
      has_column_privilege('authenticated', 'public.work_updates', column_name, 'INSERT')
        = (column_name = any(array['id', 'workspace_id', 'done', 'open', 'next'])),
      'INSERT grant for ' || column_name);
    perform pg_temp.updates_require(
      has_column_privilege('authenticated', 'public.work_updates', column_name, 'UPDATE')
        = (column_name = any(array['done', 'open', 'next'])),
      'UPDATE grant for ' || column_name);
  end loop;
  foreach permission_name in array array['SELECT', 'INSERT', 'UPDATE'] loop
    perform pg_temp.updates_require(
      not has_any_column_privilege('anon', 'public.work_updates', permission_name),
      'anon has no column privilege: ' || permission_name);
  end loop;
  perform pg_temp.updates_require(
    not has_table_privilege('anon', 'public.work_updates', 'DELETE')
    and not has_function_privilege('authenticated', 'app_private.stamp_work_update()', 'EXECUTE')
    and not has_function_privilege('anon', 'app_private.stamp_work_update()', 'EXECUTE'),
    'anon cannot delete and callers cannot directly invoke the metadata trigger');
  groups_passed := groups_passed + 1;

  -- Fixture setup uses existing Auth IDs only. Clear any earlier editor claims.
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  select array_agg(id) into actors from
    (select id from auth.users order by created_at, id limit 2) existing_users;
  perform pg_temp.updates_require(array_length(actors, 1) = 2,
    'need two existing staging Auth users; do not create users to run this file');
  actor_a := actors[1]; actor_b := actors[2];
  insert into public.workspaces(id, name, slug) values
    (workspace_a, 'Codex updates rehearsal A', 'codex-updates-' || workspace_a::text),
    (workspace_b, 'Codex updates rehearsal B', 'codex-updates-' || workspace_b::text);
  insert into public.members(workspace_id, user_id, display_name, role) values
    (workspace_a, actor_a, 'Rehearsal A', 'member'),
    (workspace_a, actor_b, 'Rehearsal B', 'member'),
    (workspace_b, actor_b, 'Rehearsal B', 'member');

  -- 2. A real authenticated role and subject; own post gets server metadata.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor_a, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_temp.updates_require(current_user = 'authenticated'
    and auth.uid() = actor_a and auth.role() = 'authenticated', 'actor A context');
  insert into public.work_updates(id, workspace_id, done)
    values (report_a, workspace_a, 'Rehearsal: photographed a real shirt');
  select * into before_row from public.work_updates where id = report_a;
  perform pg_temp.updates_require(before_row.author_id = actor_a
    and before_row.reported_on = (transaction_timestamp() at time zone 'Europe/Amsterdam')::date
    and before_row.created_at = transaction_timestamp()
    and before_row.updated_at = transaction_timestamp()
    and before_row.edited_at is null and before_row.archived_at is null,
    'own post metadata comes from the database');
  groups_passed := groups_passed + 1;

  -- 3. Every protected INSERT/UPDATE column is actually refused through SQL.
  foreach column_name in array array[
    'author_id', 'reported_on', 'created_at', 'updated_at', 'edited_at', 'archived_at'
  ] loop
    supplied_value := case when column_name = 'author_id' then actor_b::text
      else '2001-01-01' end;
    perform pg_temp.updates_expect_error(format(
      'insert into public.work_updates(workspace_id, done, %I) values (%L, %L, %L)',
      column_name, workspace_a, 'forged metadata', supplied_value),
      '42501', 'protected INSERT ' || column_name);
  end loop;
  foreach column_name in array array[
    'id', 'workspace_id', 'author_id', 'reported_on', 'created_at', 'updated_at', 'edited_at', 'archived_at'
  ] loop
    supplied_value := case when column_name = 'id' then gen_random_uuid()::text
      when column_name = 'workspace_id' then workspace_b::text
      when column_name = 'author_id' then actor_b::text else '2001-01-01' end;
    perform pg_temp.updates_expect_error(format(
      'update public.work_updates set %I = %L where id = %L',
      column_name, supplied_value, report_a), '42501', 'protected UPDATE ' || column_name);
  end loop;
  select * into after_row from public.work_updates where id = report_a;
  perform pg_temp.updates_require(to_jsonb(after_row) = to_jsonb(before_row),
    'refused metadata writes changed nothing');
  groups_passed := groups_passed + 1;

  -- 4. Content constraints: whitespace, each field's accepted boundary and overflow.
  foreach sample in array array['', '   ', E'\t\r\n '] loop
    perform pg_temp.updates_expect_error(format(
      'insert into public.work_updates(workspace_id, done) values (%L, %L)', workspace_a, sample),
      '23514', 'blank report', 'work_updates_not_empty');
  end loop;
  foreach column_name in array array['done', 'open', 'next'] loop
    execute format('insert into public.work_updates(workspace_id, %I) values (%L, %L)',
      column_name, workspace_a, repeat('x', 1000));
    perform pg_temp.updates_expect_error(format(
      'insert into public.work_updates(workspace_id, %I) values (%L, %L)',
      column_name, workspace_a, repeat('x', 1001)),
      '23514', 'overlong ' || column_name, 'work_updates_length');
  end loop;
  groups_passed := groups_passed + 1;

  -- 5. Own edit/no-op semantics. now() is transaction-stable: do not assert
  -- that timestamps strictly increase inside this single rollback transaction.
  update public.work_updates set done = done where id = report_a;
  select * into after_row from public.work_updates where id = report_a;
  perform pg_temp.updates_require(after_row.edited_at is null, 'first no-op creates no edit marker');
  update public.work_updates set open = 'Waiting for the second photograph', next = 'Choose the photo'
    where id = report_a;
  get diagnostics affected = row_count;
  select * into after_row from public.work_updates where id = report_a;
  perform pg_temp.updates_require(affected = 1 and after_row.author_id = actor_a
    and after_row.workspace_id = workspace_a and after_row.id = report_a
    and after_row.created_at = before_row.created_at and after_row.reported_on = before_row.reported_on
    and after_row.updated_at = transaction_timestamp() and after_row.edited_at = transaction_timestamp()
    and after_row.archived_at is null and after_row.next = 'Choose the photo', 'own edit and metadata pins');
  before_row := after_row;
  update public.work_updates set next = next where id = report_a;
  select * into after_row from public.work_updates where id = report_a;
  perform pg_temp.updates_require(after_row.edited_at = before_row.edited_at, 'later no-op preserves edit marker');
  groups_passed := groups_passed + 1;

  -- 6. Another member can read but cannot rewrite A's report.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor_b, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor_b::text, true);
  perform pg_temp.updates_require(current_user = 'authenticated' and auth.uid() = actor_b, 'actor B context');
  insert into public.work_updates(id, workspace_id, done) values
    (report_b, workspace_a, 'Rehearsal: contacted an event'),
    (report_other_workspace, workspace_b, 'Other workspace, must stay private from A');
  perform pg_temp.updates_require(exists(select 1 from public.work_updates where id = report_a), 'teammate can read A');
  update public.work_updates set done = 'B must not overwrite A' where id = report_a;
  get diagnostics affected = row_count;
  perform pg_temp.updates_require(affected = 0, 'another author UPDATE affects zero rows');
  perform pg_temp.updates_expect_error(format('delete from public.work_updates where id = %L', report_b),
    '42501', 'authenticated cannot delete even its own report');
  groups_passed := groups_passed + 1;

  -- 7. A is a valid user but not a member of B's other workspace.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor_a, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor_a::text, true);
  perform pg_temp.updates_require(current_user = 'authenticated' and auth.uid() = actor_a, 'A context for isolation');
  perform pg_temp.updates_require((select count(*) from public.work_updates
    where id = any(array[report_a, report_b, report_other_workspace])) = 2,
    'unscoped read shows only the two W1 reports, not W2');
  perform pg_temp.updates_expect_error(format(
    'insert into public.work_updates(workspace_id, done) values (%L, %L)', workspace_b, 'not a member'),
    '42501', 'nonmember INSERT');
  update public.work_updates set done = 'not a member' where id = report_other_workspace;
  get diagnostics affected = row_count;
  perform pg_temp.updates_require(affected = 0, 'nonmember UPDATE affects zero rows');
  groups_passed := groups_passed + 1;

  -- 8. Viewer reads include its own old posts; neither new posts nor edits are allowed.
  execute format('set local role %I', operator_role);
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  update public.members set role = 'viewer' where workspace_id = workspace_a and user_id = actor_b;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor_b, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor_b::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_temp.updates_require(current_user = 'authenticated' and auth.uid() = actor_b
    and app_private.has_workspace_role(workspace_a, 'viewer')
    and not app_private.has_workspace_role(workspace_a, 'member'), 'viewer context');
  perform pg_temp.updates_require((select count(*) from public.work_updates
    where id = any(array[report_a, report_b])) = 2, 'viewer reads team reports');
  perform pg_temp.updates_expect_error(format(
    'insert into public.work_updates(workspace_id, done) values (%L, %L)', workspace_a, 'viewer attempt'),
    '42501', 'viewer INSERT');
  update public.work_updates set done = 'viewer cannot edit old own report' where id = report_b;
  get diagnostics affected = row_count;
  perform pg_temp.updates_require(affected = 0, 'viewer UPDATE affects zero rows');
  groups_passed := groups_passed + 1;

  -- 9/10. Archived membership and archived workspace each revoke access.
  foreach sample in array array['membership', 'workspace'] loop
    execute format('set local role %I', operator_role);
    perform set_config('request.jwt.claims', '{}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    update public.members set archived_at = case when sample = 'membership' then now() else null end
      where workspace_id = workspace_a and user_id = actor_a;
    update public.workspaces set archived_at = case when sample = 'workspace' then now() else null end
      where id = workspace_a;
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor_a, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', actor_a::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform pg_temp.updates_require(current_user = 'authenticated' and auth.uid() = actor_a,
      'A context for archived ' || sample);
    perform pg_temp.updates_require(not exists(select 1 from public.work_updates where workspace_id = workspace_a),
      'archived ' || sample || ' cannot read');
    perform pg_temp.updates_expect_error(format(
      'insert into public.work_updates(workspace_id, done) values (%L, %L)', workspace_a, 'archived access attempt'),
      '42501', 'archived ' || sample || ' INSERT');
    update public.work_updates set done = 'archived access attempt' where id = report_a;
    get diagnostics affected = row_count;
    perform pg_temp.updates_require(affected = 0, 'archived ' || sample || ' UPDATE affects zero rows');
    groups_passed := groups_passed + 1;
  end loop;

  -- 11. anon has no table access, independently of workspace membership RLS.
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform pg_temp.updates_require(current_user = 'anon' and auth.uid() is null, 'anon context');
  perform pg_temp.updates_expect_error('select * from public.work_updates limit 1', '42501', 'anon SELECT');
  perform pg_temp.updates_expect_error(format(
    'insert into public.work_updates(workspace_id, done) values (%L, %L)', workspace_a, 'anon attempt'),
    '42501', 'anon INSERT');
  perform pg_temp.updates_expect_error(format(
    'update public.work_updates set done = %L where id = %L', 'anon attempt', report_a), '42501', 'anon UPDATE');
  perform pg_temp.updates_expect_error(format('delete from public.work_updates where id = %L', report_a),
    '42501', 'anon DELETE');
  groups_passed := groups_passed + 1;

  -- 12. Reports were not copied into audit events; denied edits changed no content.
  execute format('set local role %I', operator_role);
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform pg_temp.updates_require(not exists (
    select 1 from public.activity_events event
    join public.work_updates report on event.entity_id = report.id::text
      and event.workspace_id = report.workspace_id
    where report.workspace_id in (workspace_a, workspace_b)
  ), 'no report content duplicated into activity_events');
  perform pg_temp.updates_require((select done from public.work_updates where id = report_a)
      = 'Rehearsal: photographed a real shirt'
    and (select done from public.work_updates where id = report_b) = 'Rehearsal: contacted an event',
    'all refused content edits left both authors reports unchanged');
  groups_passed := groups_passed + 1;
  perform set_config('codex.work_updates_rehearsal_groups', groups_passed::text, true);
end;
$rehearsal$;

select 'PASS — installed staging schema assertions completed; fixture changes are rolled back by the next statement.' as result,
  current_setting('codex.work_updates_rehearsal_groups')::integer as checked_groups;

rollback;
