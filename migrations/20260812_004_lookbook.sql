-- Claude — 2026-08-12
-- FAKESNIFF Hub: the Lookbook (Emiel's "container").
--
-- A visual reference library. Photograph a hoodie, a fabric, a detail you liked,
-- or paste a URL, add an optional note, and it files itself. This is NOT the
-- designs table: `designs` records OUR products moving through production;
-- `lookbook_items` records things we saw and liked, from anywhere.
--
-- Answers Marco's agenda point 15 (shared digital lookbook) and Emiel's
-- first-use request. Built for the Turkey factory visit on 24 Aug, where the
-- team will be photographing materials and sample garments.
--
-- Additive and non-breaking. Run after 001 and 002. Independent of 003.

begin;

-- ---------------------------------------------------------------------------
-- The library
-- ---------------------------------------------------------------------------

create table if not exists public.lookbook_items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,

  -- what it is. All optional on capture: the point is that adding something
  -- takes one action. A photo with no title is still worth keeping.
  title         text not null default '',
  note          text not null default '',
  category      text not null default 'unsorted',
  tags          text[] not null default '{}'::text[],

  -- where it came from: an uploaded image, a pasted link, or both
  storage_path  text,
  source_url    text not null default '',

  -- filled in later by the image analysis step, once an API key exists.
  -- Kept as jsonb so the shape can change without another migration.
  ai_analysis   jsonb not null default '{}'::jsonb,
  ai_analysed_at timestamptz,

  added_by      text not null default '',
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,

  unique (workspace_id, id),

  -- Garment-and-material vocabulary, not a generic tag soup. These are the
  -- things the team actually sorts by when looking for a reference.
  constraint lookbook_category_allowed check (category in (
    'unsorted', 'tee', 'hoodie', 'sweat', 'longsleeve', 'jacket', 'knit',
    'trousers', 'headwear', 'accessory',
    'print', 'graphic', 'typography', 'colour', 'fabric', 'detail', 'fit',
    'packaging', 'campaign', 'store', 'other'
  )),
  constraint lookbook_source_url_http check (
    source_url = '' or source_url ~ '^https?://[^[:space:]]+$'
  ),
  constraint lookbook_title_length check (char_length(title) <= 240),
  constraint lookbook_note_length check (char_length(note) <= 2000),
  constraint lookbook_ai_analysis_object check (jsonb_typeof(ai_analysis) = 'object'),
  -- an item has to be *something*: a picture, a link, or at least a written note
  constraint lookbook_has_content check (
    storage_path is not null or source_url <> '' or char_length(btrim(note)) > 0
  ),
  -- images live under <workspace>/lookbook/<item id>/…, mirroring design-assets
  constraint lookbook_storage_path_scoped check (
    storage_path is null
    or storage_path like workspace_id::text || '/lookbook/' || id::text || '/%'
  )
);

-- ---------------------------------------------------------------------------
-- Server-maintained fields, same pattern as the rest of the hub
-- ---------------------------------------------------------------------------

drop trigger if exists lookbook_items_set_updated_at on public.lookbook_items;
create trigger lookbook_items_set_updated_at before update on public.lookbook_items
  for each row execute function app_private.set_updated_at();

drop trigger if exists lookbook_items_stamp_actor on public.lookbook_items;
create trigger lookbook_items_stamp_actor before insert or update on public.lookbook_items
  for each row execute function app_private.stamp_actor();

drop trigger if exists lookbook_items_prevent_workspace_move on public.lookbook_items;
create trigger lookbook_items_prevent_workspace_move before update on public.lookbook_items
  for each row execute function app_private.prevent_workspace_move();

drop trigger if exists lookbook_items_audit_change on public.lookbook_items;
create trigger lookbook_items_audit_change
  after insert or update or delete on public.lookbook_items
  for each row execute function app_private.audit_row_change();

-- ---------------------------------------------------------------------------
-- Access. Members read and write; viewers read only.
-- ---------------------------------------------------------------------------

alter table public.lookbook_items enable row level security;

drop policy if exists lookbook_items_member_select on public.lookbook_items;
create policy lookbook_items_member_select on public.lookbook_items
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

drop policy if exists lookbook_items_member_insert on public.lookbook_items;
create policy lookbook_items_member_insert on public.lookbook_items
  for insert to authenticated
  with check (app_private.has_workspace_role(workspace_id, 'member'));

drop policy if exists lookbook_items_member_update on public.lookbook_items;
create policy lookbook_items_member_update on public.lookbook_items
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, 'member'))
  with check (app_private.has_workspace_role(workspace_id, 'member'));

revoke all privileges on table public.lookbook_items from public, anon, authenticated;
grant select, insert, update on table public.lookbook_items to authenticated;

-- ---------------------------------------------------------------------------
-- Private image bucket. Paths: <workspace UUID>/lookbook/<item UUID>/<filename>
-- Photos of a factory floor and a supplier's samples are commercially sensitive,
-- so this bucket is private and readable only by workspace members.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lookbook',
  'lookbook',
  false,
  26214400,  -- 25MB: comfortably covers a modern phone photo
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists lookbook_member_read on storage.objects;
create policy lookbook_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lookbook'
    and split_part(name, '/', 2) = 'lookbook'
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'viewer')
  );

drop policy if exists lookbook_member_insert on storage.objects;
create policy lookbook_member_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lookbook'
    and split_part(name, '/', 2) = 'lookbook'
    and split_part(name, '/', 3) <> ''
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'member')
  );

drop policy if exists lookbook_member_update on storage.objects;
create policy lookbook_member_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'lookbook'
    and split_part(name, '/', 2) = 'lookbook'
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'member')
  )
  with check (
    bucket_id = 'lookbook'
    and split_part(name, '/', 2) = 'lookbook'
    and split_part(name, '/', 3) <> ''
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'member')
  );

-- Deleting a reference photo is destructive and unlogged at the storage layer,
-- so keep it to admins. Members archive the row instead.
drop policy if exists lookbook_admin_delete on storage.objects;
create policy lookbook_admin_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lookbook'
    and split_part(name, '/', 2) = 'lookbook'
    and app_private.has_workspace_role_text(split_part(name, '/', 1), 'admin')
  );

-- ---------------------------------------------------------------------------
-- Indexes for the views the Lookbook actually renders
-- ---------------------------------------------------------------------------

create index if not exists lookbook_workspace_recent_idx
  on public.lookbook_items (workspace_id, created_at desc) where archived_at is null;
create index if not exists lookbook_workspace_category_idx
  on public.lookbook_items (workspace_id, category, created_at desc) where archived_at is null;
create index if not exists lookbook_tags_idx
  on public.lookbook_items using gin (tags) where archived_at is null;
-- free-text search over title and note, for "where's that ribbed knit thing"
create index if not exists lookbook_text_idx
  on public.lookbook_items using gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(note, ''))
  ) where archived_at is null;
-- lets the analysis job find what it has not looked at yet
create index if not exists lookbook_pending_analysis_idx
  on public.lookbook_items (workspace_id, created_at)
  where archived_at is null and ai_analysed_at is null and storage_path is not null;

commit;
