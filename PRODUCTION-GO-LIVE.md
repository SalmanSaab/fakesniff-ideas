# Production go-live — run this before you fly

Written 13 Aug 2026. You leave 14 Aug. Turkey is 24 Aug, while you are away.

**The point of this document:** the Hub currently runs on a throwaway database.
If it stays there, Marco and Emiel land in a factory with nothing. This moves it
onto the real project **without touching the public idea board**, which stays
live as the fallback the whole fortnight.

**Do not run migration 003.** Not today, not while you are away. It removes
anonymous access and the public board dies with it. Once it commits, `rollback`
cannot undo it. That is decided.

---

## Before you start

- Supabase dashboard → the **production** project (`kayxejofqyxoqlberrgw`), not
  the staging one. Check the URL twice. Everything below is irreversible enough
  to matter.
- SQL Editor, one migration per run. **Do not paste two at once.**
- After each one, run the check underneath it before moving on.
- If anything errors: stop, run `rollback;`, and do not continue to the next
  step. A half-applied migration is worse than none.

---

## Step 1 — migration 001, foundation

Paste the whole of `migrations/20260811_001_hub_v1_foundation.sql`. It creates
the FAKESNIFF workspace itself, so there is nothing to set up first.

**Check it worked, and that the board is unharmed:**

```sql
select count(*) as ideas_still_there from public.ideas;
select count(*) as triggers_still_there from public.triggers;
select id, name from public.workspaces;
select count(*) as ideas_missing_workspace
  from public.ideas where workspace_id is null;
```

Expect: your idea count unchanged, one workspace named FAKESNIFF, and
`ideas_missing_workspace` = 0.

**Then open the public board in a browser.** It must still load ideas. If it
does not, stop and tell Claude before doing anything else.

## Step 2 — migration 002, work module

Paste `migrations/20260811_002_hub_v1_work_module.sql`.

```sql
select count(*) from public.workstreams;
select count(*) from public.tasks;
```

Both should return 0 rows without erroring. Empty is correct — nothing has been
created yet.

## Step 3 — migration 004, lookbook

Paste `migrations/20260812_004_lookbook.sql`.

```sql
select count(*) from public.lookbook_items;
select id, public from storage.buckets where id = 'lookbook';
```

Expect 0 items and a `lookbook` bucket with **public = false**. If that bucket
says true, stop — the photos would be readable by anyone.

## Step 4 — close the door before anyone is invited

Dashboard → **Authentication → Providers → Email**, and **turn off public
sign-ups**. Do this *before* step 5. If sign-ups are open, anyone who finds the
URL can create an account.

## Step 5 — invite Marco and Emiel

Dashboard → **Authentication → Users → Invite**. Send to their real work
addresses. They each get an email and set their own password. **You never see
or type their password** — do not offer to set one for them.

Once both have accepted, add them to the workspace. Membership is not in the
app yet, so this is SQL:

```sql
insert into public.members (workspace_id, user_id, display_name, role)
select '6b9f4ba4-e480-4c08-b67e-4d389db3f9d1', u.id, v.display_name, v.role
from (values
  ('marco@…',  'Marco',   'owner'),
  ('emiel@…',  'Emiel',   'admin'),
  ('salmansaab35@gmail.com', 'Salman', 'owner')
) as v(email, display_name, role)
join auth.users u on u.email = v.email
on conflict (workspace_id, user_id) do update
  set role = excluded.role, display_name = excluded.display_name;
```

Replace the two placeholder addresses with their real ones. Roles allowed:
`viewer`, `member`, `admin`, `owner`.

**Marco is `owner`** — he pays for it and should not be able to be locked out.
**Emiel is `admin`** — full use, no ability to remove Marco.
**You are `owner`** too, so there are two people who can recover the workspace
if one loses access while you are away.

**Verify all three landed:**

```sql
select m.display_name, m.role, u.email
from public.members m join auth.users u on u.id = m.user_id;
```

Three rows. If one is missing, that person never accepted the invite — chase it
before you fly, not after.

## Step 6 — tell Claude

Say "production is migrated" and Claude points the Hub at the real project and
deploys it. That part is not yours.

## Step 7 — the one thing to check the next morning

The scanner runs daily on the old code, which keeps working because 001 gave
`workspace_id` a default. Confirm it actually did:

```sql
select max(created_at) from public.triggers;
```

If that timestamp is from today, ingestion survived the migration. If it is
older than yesterday, the scanner broke and Claude needs to know.

---

## What you are explicitly not doing

- **Not** running migration 003.
- **Not** replacing the scanner. The legacy one still works and swapping it the
  day before you leave adds risk for no gain.
- **Not** taking the public board down. It stays up the entire time you are
  away, and it is the fallback if anything about the Hub goes wrong.

---

## If something breaks while you are away

Marco and Emiel cannot fix a database. The realistic recovery is: **the public
idea board still works**, and it is untouched by everything above. Point them
at it and let the Hub wait until you are back. Nothing in this document puts
that board at risk — that is the whole reason 003 is not in it.
