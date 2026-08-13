-- Claude — 2026-08-13
-- FAKESNIFF Hub: Decisions.
--
-- Built for one specific problem. On 24 Aug Marco and Emiel are at a factory in
-- Turkey settling fabric weights, prices, minimum order quantities, delivery
-- dates and which samples to run. Salman is not there. Those agreements
-- currently live in someone's memory and a WhatsApp thread, and by the time
-- anyone needs them — at the next order, or when an invoice does not match —
-- they are half-remembered and disputed.
--
-- A decision is not a task. Nobody "completes" it. It is a fact about what the
-- company agreed, who agreed it, and when. It stays true until something
-- replaces it, which is why `supersedes` exists rather than editing history.
--
-- Design constraint that shaped everything below: this gets typed standing on a
-- factory floor, on a phone, probably in a hurry. Only ONE field is required.
-- Everything else can be filled in on the flight home. A decision captured
-- badly is worth enormously more than one not captured at all.
--
-- Additive and non-breaking. Run after 001, 002 and 004. Independent of 003.

begin;

-- ---------------------------------------------------------------------------
-- The record
-- ---------------------------------------------------------------------------

create table if not exists public.decisions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,

  -- The decision itself, as a plain sentence. This is the only required field.
  -- "280gsm French terry for the winter hoodie, not 320." That is a whole
  -- valid record.
  decision      text not null,

  -- What it is about. Deliberately the vocabulary of a factory conversation,
  -- not a generic taxonomy — these are the things that get argued about and
  -- later disputed.
  topic         text not null default 'other',

  -- Whether it is settled. `tentative` matters: a lot of what happens in a
  -- supplier meeting is "probably, pending a sample". Recording that honestly
  -- is more useful than pretending everything was final.
  status        text not null default 'agreed',

  -- Why, or what it replaces, or what it depends on. Optional.
  context       text not null default '',

  -- Who it was agreed with — the factory, supplier or agent. Free text on
  -- purpose: we do not have a suppliers table and inventing one to record a
  -- name would stop people writing anything down.
  counterparty  text not null default '',

  -- Who in our team agreed it. Free text for the same reason: on the day, the
  -- person typing may not be the person who decided.
  decided_by    text not null default '',

  -- Defaults to today, but editable, because these get written up on the plane.
  decided_on    date not null default current_date,

  -- The reference this decision is about, when there is one. "We agreed this
  -- fabric" is far more useful pointing at the photograph of that fabric.
  -- Composite FK so a decision can never point at another workspace's item.
  lookbook_item_id uuid,

  -- Decisions are not edited into new truth; they are replaced, and the old
  -- one stays readable. When a price is renegotiated you want to see that it
  -- moved, not just the current number.
  supersedes_id uuid,

  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,

  unique (workspace_id, id),

  -- No ON DELETE SET NULL on either of these. They are composite keys that
  -- include workspace_id, which is NOT NULL, so "set null" would try to null
  -- that too and fail at exactly the wrong moment. Nothing here is deleted
  -- through the app anyway — archiving is the pattern.
  constraint decisions_lookbook_fk foreign key (workspace_id, lookbook_item_id)
    references public.lookbook_items (workspace_id, id),
  constraint decisions_supersedes_fk foreign key (workspace_id, supersedes_id)
    references public.decisions (workspace_id, id),
  constraint decisions_no_self_supersede check (supersedes_id is null or supersedes_id <> id),

  -- The one real requirement: it has to actually say something.
  constraint decisions_decision_present check (char_length(btrim(decision)) between 3 and 2000),
  constraint decisions_context_length check (char_length(context) <= 4000),
  constraint decisions_counterparty_length check (char_length(counterparty) <= 160),
  constraint decisions_decided_by_length check (char_length(decided_by) <= 160),

  constraint decisions_topic_allowed check (topic in (
    'fabric', 'price', 'moq', 'delivery', 'sample', 'quality',
    'supplier', 'packaging', 'design', 'brand', 'other'
  )),
  constraint decisions_status_allowed check (status in (
    'agreed', 'tentative', 'superseded'
  )),

  -- Guards a fat-fingered year on a phone keyboard. Static bounds only:
  -- current_date is STABLE, not IMMUTABLE, and Postgres rejects it inside a
  -- CHECK. "Not in the future" is enforced in the app, where it can say so in
  -- a sentence instead of throwing a constraint name at Marco.
  constraint decisions_decided_on_sane check (
    decided_on >= date '2024-01-01' and decided_on < date '2100-01-01'
  )
);

create index if not exists decisions_workspace_recent_idx
  on public.decisions (workspace_id, decided_on desc, created_at desc)
  where archived_at is null;

create index if not exists decisions_lookbook_idx
  on public.decisions (workspace_id, lookbook_item_id)
  where lookbook_item_id is not null;

-- ---------------------------------------------------------------------------
-- Server-maintained fields, same pattern as the rest of the hub
-- ---------------------------------------------------------------------------

drop trigger if exists decisions_set_updated_at on public.decisions;
create trigger decisions_set_updated_at before update on public.decisions
  for each row execute function app_private.set_updated_at();

drop trigger if exists decisions_stamp_actor on public.decisions;
create trigger decisions_stamp_actor before insert or update on public.decisions
  for each row execute function app_private.stamp_actor();

drop trigger if exists decisions_prevent_workspace_move on public.decisions;
create trigger decisions_prevent_workspace_move before update on public.decisions
  for each row execute function app_private.prevent_workspace_move();

drop trigger if exists decisions_audit_change on public.decisions;
create trigger decisions_audit_change
  after insert or update or delete on public.decisions
  for each row execute function app_private.audit_row_change();

-- ---------------------------------------------------------------------------
-- Marking a decision superseded is a consequence, not a separate chore.
-- If someone records a replacement and forgets to update the old one, the
-- record silently shows two contradictory current decisions — which is worse
-- than having neither.
-- ---------------------------------------------------------------------------

create or replace function app_private.mark_superseded_decision()
returns trigger
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
begin
  if new.supersedes_id is not null then
    update public.decisions
       set status = 'superseded'
     where workspace_id = new.workspace_id
       and id = new.supersedes_id
       and status <> 'superseded';
  end if;
  return new;
end;
$$;

revoke all on function app_private.mark_superseded_decision() from public, anon, authenticated;

drop trigger if exists decisions_mark_superseded on public.decisions;
create trigger decisions_mark_superseded
  after insert or update of supersedes_id on public.decisions
  for each row execute function app_private.mark_superseded_decision();

-- ---------------------------------------------------------------------------
-- Access. Members read and write; viewers read only. Nothing is ever deleted
-- from the app — a decision that can be quietly removed is not a record.
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

commit;
