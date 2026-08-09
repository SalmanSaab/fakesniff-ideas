-- Fakesniff idea base
-- Paste into Supabase: SQL Editor -> New query -> Run

create table if not exists ideas (
  id          bigint generated always as identity primary key,
  line        text not null,
  concept     text default '',
  category    text default 'other',
  status      text default 'new',
  risk        text default 'clean',
  sparked_by  text default '',
  source_url  text default '',
  added_by    text default '',
  notes       text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  updated_by  text default ''
);

create table if not exists triggers (
  id         bigint generated always as identity primary key,
  title      text not null,
  url        text default '',
  source     text default '',
  category   text default 'other',
  used       boolean default false,
  found_at   timestamptz default now(),
  unique (title, source)
);

-- who changed what, so the three of you can see activity
create table if not exists activity (
  id         bigint generated always as identity primary key,
  who        text not null,
  what       text not null,
  idea_id    bigint,
  at         timestamptz default now()
);

create index if not exists ideas_status_idx    on ideas (status);
create index if not exists ideas_category_idx  on ideas (category);
create index if not exists triggers_used_idx   on triggers (used);
create index if not exists activity_at_idx     on activity (at desc);

-- Row level security.
-- This base is opened from a shared link, there are no user accounts, so the
-- three of you act as the anonymous role. Ideas are not sensitive data, but note
-- that anyone holding the link and key could read or edit. Fine for a private
-- team board, not for anything confidential.
alter table ideas    enable row level security;
alter table triggers enable row level security;
alter table activity enable row level security;

drop policy if exists ideas_all    on ideas;
drop policy if exists triggers_all on triggers;
drop policy if exists activity_all on activity;

create policy ideas_all    on ideas    for all to anon using (true) with check (true);
create policy triggers_all on triggers for all to anon using (true) with check (true);
create policy activity_all on activity for all to anon using (true) with check (true);

-- keep updated_at honest
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ideas_touch on ideas;
create trigger ideas_touch before update on ideas
  for each row execute function touch_updated_at();
