-- Codex — 2026-08-13
-- FAKESNIFF Hub: a private, cross-device "since your last look" feed.
--
-- activity_events already records server-owned audit history, but event_data
-- contains complete row snapshots. The Home browser path must never receive
-- or cache those snapshots. These two RPCs reduce them to a tiny allow-listed
-- feed and remember exactly which events each person has seen.
--
-- Additive. Run after 001, 002, 004 and 005. Independent of migration 003.

begin;

create table if not exists public.home_feed_state (
  workspace_id  uuid not null,
  user_id       uuid not null,
  started_at    timestamptz not null,
  last_opened_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint home_feed_state_member_fk
    foreign key (workspace_id, user_id)
    references public.members(workspace_id, user_id) on delete restrict
);

create table if not exists public.home_event_receipts (
  workspace_id uuid not null,
  user_id      uuid not null,
  event_id     uuid not null references public.activity_events(id) on delete restrict,
  seen_at      timestamptz not null default now(),
  primary key (workspace_id, user_id, event_id),
  constraint home_event_receipts_member_fk
    foreign key (workspace_id, user_id)
    references public.members(workspace_id, user_id) on delete restrict
);

alter table public.home_feed_state enable row level security;
alter table public.home_event_receipts enable row level security;

-- No browser receives direct table access. The RPCs below bind user_id to
-- auth.uid(), re-check active membership, and expose only sanitized fields.
revoke all privileges on table
  public.home_feed_state,
  public.home_event_receipts
from public, anon, authenticated;

-- Codex — 2026-08-13: defensive cleanup for a throwaway environment that may
-- have rehearsed the pre-review two-argument draft. Production/staging records
-- say 006 has not run, but leaving a weaker overload callable would be unsafe.
drop function if exists public.get_home_changes(uuid, integer);
drop function if exists public.ack_home_changes(uuid, uuid[]);

create or replace function public.get_home_changes(
  p_workspace_id uuid,
  p_expected_user_id uuid,
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, app_private, pg_temp
set row_security = off
as $$
declare
  v_user_id auth.users.id%type := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
  v_started_at timestamptz;
  v_last_opened_at timestamptz;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  if auth.role() <> 'authenticated'
     or v_user_id is null
     or v_user_id is distinct from p_expected_user_id
     or not app_private.has_workspace_role(p_workspace_id, 'viewer') then
    raise exception 'Home changes are not available.' using errcode = '42501';
  end if;

  -- A first visit starts at midnight in the team's timezone. After that
  -- per-user baseline, exact receipts prevent late commits from being skipped.
  insert into public.home_feed_state (
    workspace_id, user_id, started_at
  ) values (
    p_workspace_id,
    v_user_id,
    date_trunc('day', clock_timestamp() at time zone 'Europe/Amsterdam')
      at time zone 'Europe/Amsterdam'
  )
  on conflict (workspace_id, user_id) do nothing;

  select started_at, last_opened_at
  into v_started_at, v_last_opened_at
  from public.home_feed_state
  where workspace_id = p_workspace_id
    and user_id = v_user_id;

  with candidates as (
    select
      e.id as event_id,
      'task'::text as entity_family,
      case
        when t.status = 'waiting' then 'task_waiting'
        else 'task_review'
      end as kind,
      t.id::text as entity_id,
      left(t.title, 240) as title,
      left(coalesce(nullif(btrim(actor.display_name), ''), 'Someone on the team'), 80) as actor_name,
      e.occurred_at,
      case
        when t.status = 'review' and t.approver_id = v_user_id then 0
        when t.status = 'waiting' and t.owner_id = v_user_id then 1
        when t.status = 'review' then 2
        else 3
      end as priority,
      (
        (t.status = 'review' and t.approver_id = v_user_id)
        or (t.status = 'waiting' and t.owner_id = v_user_id)
      ) as needs_you
    from public.activity_events e
    join public.tasks t
      on t.workspace_id = e.workspace_id
     and t.id::text = e.entity_id
    left join public.members actor
      on actor.workspace_id = e.workspace_id
     and actor.user_id = e.actor_id
    left join public.home_event_receipts receipt
      on receipt.workspace_id = e.workspace_id
     and receipt.user_id = v_user_id
     and receipt.event_id = e.id
    where e.workspace_id = p_workspace_id
      and e.entity_type = 'tasks'
      and e.action in ('insert', 'update')
      and e.occurred_at >= v_started_at
      and receipt.event_id is null
      and t.archived_at is null
      and (
        (
          e.event_data #>> '{new,status}' = 'waiting'
          and (e.event_data #>> '{old,status}') is distinct from 'waiting'
          and t.status = 'waiting'
        )
        or
        (
          e.event_data #>> '{new,status}' = 'review'
          and (e.event_data #>> '{old,status}') is distinct from 'review'
          and t.status = 'review'
        )
      )

    union all

    select
      e.id as event_id,
      'decision'::text as entity_family,
      case
        when d.status = 'decided' then 'decision_agreed'
        else 'decision_recorded'
      end as kind,
      d.id::text as entity_id,
      left(d.title, 240) as title,
      left(coalesce(nullif(btrim(actor.display_name), ''), 'Someone on the team'), 80) as actor_name,
      e.occurred_at,
      4 as priority,
      false as needs_you
    from public.activity_events e
    join public.decisions d
      on d.workspace_id = e.workspace_id
     and d.id::text = e.entity_id
    left join public.members actor
      on actor.workspace_id = e.workspace_id
     and actor.user_id = e.actor_id
    left join public.home_event_receipts receipt
      on receipt.workspace_id = e.workspace_id
     and receipt.user_id = v_user_id
     and receipt.event_id = e.id
    where e.workspace_id = p_workspace_id
      and e.entity_type = 'decisions'
      and e.occurred_at >= v_started_at
      and receipt.event_id is null
      and d.archived_at is null
      and d.status in ('proposed', 'decided')
      and (
        e.action = 'insert'
        or (
          e.action = 'update'
          and e.event_data #>> '{new,status}' = 'decided'
          and (e.event_data #>> '{old,status}') is distinct from 'decided'
          and d.status = 'decided'
        )
      )
  ),
  current_change_per_item as (
    -- All receipt IDs come from this exact SELECT snapshot. A transaction that
    -- commits later cannot be silently acknowledged, even if its transaction-
    -- start timestamp is older than an item already shown.
    select
      (array_agg(event_id order by occurred_at desc, event_id desc))[1] as event_id,
      (array_agg(kind order by occurred_at desc, event_id desc))[1] as kind,
      entity_id,
      (array_agg(title order by occurred_at desc, event_id desc))[1] as title,
      (array_agg(actor_name order by occurred_at desc, event_id desc))[1] as actor_name,
      max(occurred_at) as occurred_at,
      min(priority) as priority,
      bool_or(needs_you) as needs_you,
      array_agg(event_id order by occurred_at desc, event_id desc) as receipt_event_ids
    from candidates
    group by entity_family, entity_id
  ),
  ranked as (
    select
      *,
      row_number() over (order by priority, occurred_at desc, event_id desc) as row_number,
      count(*) over () as total_count
    from current_change_per_item
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'eventId', event_id,
          'kind', kind,
          'entityId', entity_id,
          'title', title,
          'actorName', actor_name,
          'occurredAt', occurred_at,
          'needsYou', needs_you,
          'receiptEventIds', to_jsonb(receipt_event_ids)
        ) order by row_number
      ) filter (where row_number <= v_limit),
      '[]'::jsonb
    ),
    coalesce(max(total_count) > v_limit, false)
  into v_items, v_has_more
  from ranked;

  return jsonb_build_object(
    'firstVisit', v_last_opened_at is null,
    'lastOpenedAt', v_last_opened_at,
    'hasMore', v_has_more,
    'items', v_items
  );
end
$$;

create or replace function public.ack_home_changes(
  p_workspace_id uuid,
  p_expected_user_id uuid,
  p_event_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, app_private, pg_temp
set row_security = off
as $$
declare
  v_user_id auth.users.id%type := auth.uid();
  v_seen_at timestamptz := clock_timestamp();
  v_started_at timestamptz;
  v_acknowledged integer := 0;
begin
  if auth.role() <> 'authenticated'
     or v_user_id is null
     or v_user_id is distinct from p_expected_user_id
     or not app_private.has_workspace_role(p_workspace_id, 'viewer') then
    raise exception 'Home changes are not available.' using errcode = '42501';
  end if;

  if cardinality(coalesce(p_event_ids, '{}'::uuid[])) > 500 then
    raise exception 'Too many Home changes were acknowledged at once.' using errcode = '22023';
  end if;

  insert into public.home_feed_state (
    workspace_id, user_id, started_at, last_opened_at
  ) values (
    p_workspace_id,
    v_user_id,
    date_trunc('day', v_seen_at at time zone 'Europe/Amsterdam')
      at time zone 'Europe/Amsterdam',
    v_seen_at
  )
  on conflict (workspace_id, user_id) do update
  set last_opened_at = greatest(
        coalesce(public.home_feed_state.last_opened_at, '-infinity'::timestamptz),
        excluded.last_opened_at
      ),
      updated_at = greatest(public.home_feed_state.updated_at, excluded.last_opened_at);

  select started_at
  into v_started_at
  from public.home_feed_state
  where workspace_id = p_workspace_id
    and user_id = v_user_id;

  with requested as (
    select distinct event_id
    from unnest(coalesce(p_event_ids, '{}'::uuid[])) as requested(event_id)
  ), inserted as (
    insert into public.home_event_receipts (
      workspace_id, user_id, event_id, seen_at
    )
    select p_workspace_id, v_user_id, e.id, v_seen_at
    from requested
    join public.activity_events e
      on e.id = requested.event_id
     and e.workspace_id = p_workspace_id
     and e.occurred_at >= v_started_at
    where (
      e.entity_type = 'tasks'
      and e.action in ('insert', 'update')
      and e.event_data #>> '{new,status}' in ('waiting', 'review')
      and (e.event_data #>> '{old,status}') is distinct from (e.event_data #>> '{new,status}')
    ) or (
      e.entity_type = 'decisions'
      and (
        e.action = 'insert'
        or (
          e.action = 'update'
          and e.event_data #>> '{new,status}' = 'decided'
          and (e.event_data #>> '{old,status}') is distinct from 'decided'
        )
      )
    )
    on conflict (workspace_id, user_id, event_id) do nothing
    returning 1
  )
  select count(*) into v_acknowledged from inserted;

  return jsonb_build_object(
    'acknowledged', v_acknowledged,
    'openedAt', v_seen_at
  );
end
$$;

revoke all on function public.get_home_changes(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.ack_home_changes(uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_home_changes(uuid, uuid, integer) to authenticated;
grant execute on function public.ack_home_changes(uuid, uuid, uuid[]) to authenticated;

-- This project has previously served a stale PostgREST schema after an
-- additive migration. Deliver the reload notification with this transaction.
notify pgrst, 'reload schema';

commit;
