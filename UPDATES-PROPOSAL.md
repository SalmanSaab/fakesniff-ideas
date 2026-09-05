# Daily updates — data contract, module and mount proposal

*Claude, 5 September 2026. For Codex's second read before any implementation,
per the bounded release agreed in `AGENT-CHAT.md` (Codex, 5 Sep).*

> **SUPERSEDED IN THREE PLACES. Read the code, not this, for what shipped.**
>
> Codex's second read found two real database defects in what is proposed below,
> and its integration review found six behavioural ones. This document is kept
> because the reasoning is still useful, but three things in it are **wrong**:
>
> 1. **The grants.** Whole-table `insert`/`update` would have let a caller set
>    `created_at`, backdate `reported_on`, fake `edited_at` and archive a report
>    through the API. Shipped: column-level grants only.
> 2. **The blank check.** `trim()` removes spaces and nothing else, so a report
>    of tabs or newlines would have passed. Shipped: `~ '\S'`.
> 3. **The mount contract.** "Self-mount if the containers exist" was rejected —
>    containers exist while signed out, so their presence cannot be what starts a
>    private read. Shipped: explicit init from `hub.js` after verified membership.
>
> Also corrected: the module now keeps the draft current on every keystroke,
> puts load status on the feed rather than in a composer a viewer does not have,
> re-reads and compares before treating a duplicate-key retry as success, freezes
> the form during a save, and discards obsolete reads.

Nothing here is built. This document exists to be disagreed with cheaply.

---

## What this is, restated so we are bound to the same thing

Marco's section 9 asks for a short update at the end of a working day or block.
Emiel asked for the same thing unprompted. Neither asked for a task system or a
calendar, and the personal agenda comes from Work, which already has owners, due
dates and next actions.

So: **a person writes a few lines about a working block. Everyone else can read
them, newest first, with who and when.** That is the whole feature.

**The promise, stated plainly because Emiel expects more:** it is visible in Home
when Home is opened or refreshed. **Nobody is notified.** Codex is right that this
has to be said to him in words rather than discovered.

---

## 1. The data

### Table name

`public.work_updates`.

Not `daily_updates`: the agreed behaviour supports more than one working block
per day, so "daily" would be wrong in the schema even though the interface calls
it the daily update. The Dutch label is what the team says; the table says what
it stores.

### Migration

`migrations/20260905_007_work_updates.sql`. Additive, creates one table, touches
nothing existing.

**No dependency on 006 in either direction.** 007 does not read, alter or assume
anything 006 creates, and 006's RPCs are not extended to carry updates. The
numbering gap if 006 is closed or hidden is intentional and harmless.

### Shape

```sql
create table if not exists public.work_updates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,
  author_id     uuid not null default auth.uid()
                  references auth.users(id) on delete restrict,

  done          text not null default '',
  open          text not null default '',
  next          text not null default '',

  reported_on   date not null
                  default (now() at time zone 'Europe/Amsterdam')::date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  edited_at     timestamptz,
  archived_at   timestamptz
);
```

Three columns rather than one body, because Marco's example is three headings and
his stated need is to identify the result, the blocker and the next step in about
a minute. One free-text blob would make that a reading exercise every time.

`reported_on` uses **Europe/Amsterdam**, following the precedent set in migration
002 where `due_at` was converted with the same zone. A report written at 23:30 in
Leeuwarden belongs to that day, not to UTC's next one.

`author_id` defaults to `auth.uid()` and is pinned by the insert policy below, so
authorship comes from the session and not from the request body.

`edited_at` stays null until the author changes the content. It is the edited
marker; the interface shows it, nothing else depends on it.

`archived_at` exists to match every other table in this schema. **No interface
uses it in this release** and no delete policy is created. A mistaken update is
corrected by editing it.

### Constraints

```sql
alter table public.work_updates
  add constraint work_updates_not_empty
  check (length(trim(done)) + length(trim(open)) + length(trim(next)) > 0);

alter table public.work_updates
  add constraint work_updates_length
  check (length(done) <= 1000 and length(open) <= 1000 and length(next) <= 1000);
```

Not every prompt has to be filled, per the agreed scope — only that the update
is not entirely blank. The length cap protects Marco's one-minute read as much as
the database.

**Both names go into `humanError` before the module ships.** A person must never
see `work_updates_not_empty`. Proposed wording, English and Dutch:

| Constraint | English | Dutch |
|---|---|---|
| `work_updates_not_empty` | "Write at least one line before posting." | "Schrijf minstens één regel voordat je plaatst." |
| `work_updates_length` | "That is longer than an update should be. Keep each part under 1000 characters." | "Dat is langer dan een update hoort te zijn. Houd elk deel onder de 1000 tekens." |

### Row-level security

Same helper every other table uses, `app_private.has_workspace_role`.

```sql
alter table public.work_updates enable row level security;

-- Anyone who can see the workspace can read the team's updates.
create policy work_updates_member_select on public.work_updates
  for select to authenticated
  using (app_private.has_workspace_role(workspace_id, 'viewer'));

-- You may only write as yourself.
create policy work_updates_author_insert on public.work_updates
  for insert to authenticated
  with check (
    app_private.has_workspace_role(workspace_id, 'member')
    and author_id = auth.uid()
  );

-- You may only correct your own.
create policy work_updates_author_update on public.work_updates
  for update to authenticated
  using (
    app_private.has_workspace_role(workspace_id, 'member')
    and author_id = auth.uid()
  )
  with check (
    app_private.has_workspace_role(workspace_id, 'member')
    and author_id = auth.uid()
  );
```

**No delete policy.** Deletion is not part of this release.

A viewer can read and cannot write. That is deliberate: Marco reads, and reading
must never require the permission to post.

```sql
revoke all privileges on table public.work_updates from public, anon, authenticated;
grant select, insert, update on table public.work_updates to authenticated;
```

### Triggers

- `prevent_workspace_move` — attach, matching every other table.
- `set_updated_at` plus edited marker — a small `before update` function setting
  `updated_at = now()`, and `edited_at = now()` only when `done`, `open` or
  `next` actually changed.
- **`audit_row_change` — deliberately NOT attached.**
- **`stamp_actor` — not attached.** It stamps `created_by`/`updated_by`, which
  this table does not have; `author_id` is the actor.

The audit decision is worth stating rather than leaving as an omission. Attaching
it would write every update into `activity_events`, which is what Home already
reads, and the agreed scope says reports must not be stored as hand-written audit
events. An update is a first-class thing a person wrote, not a side effect of a
row changing.

### One decision that is yours, because Home is yours

**How does the feed reach Home?** Two options and I have a preference, not a
verdict.

**(a) Home reads `work_updates` directly.** One representation, no duplication,
no risk of the feed and the table disagreeing. My preference.

**(b) Posting also emits an `activity_events` row** so it appears in the existing
recent-activity list.

I would not do (b). It creates a second copy of the same fact, and the agreed
promise is a readable dated list rather than an entry in an audit stream. But you
own Home's reading path and if (b) fits what is already there, say so and I will
build to it.

---

## 2. The module

`hub-updates.js` and `hub-updates.css`, mine, in `web-ilab`.

### What it renders

**Compose.** Three short text areas and one button. Nothing else — no title, no
date picker, no tags, no attachments.

```
Gedaan
Open of geblokkeerd
Volgende
                                            [ Update plaatsen ]
```

On success the button's toast says `Update geplaatst`. The control says what
happens and the confirmation says it happened, in the same words.

Sized so that all three fields and the button fit above the fold on a 390×844
phone, because the two-minute test is on a phone.

**Feed.** Newest first, grouped by `reported_on`. Each entry:

```
donderdag 4 september
  Emiel · 17:42 · bewerkt
  Gedaan      8 influencers benaderd, 3 reacties
  Open        Meta wacht op antwoord, zaak 4471
  Volgende    Recruit a Student bellen
```

Author name comes from `members.display_name`, not from the auth user, so it
matches the name used everywhere else in the Hub.

Only the author sees an edit control on their own entries. Everyone sees
`bewerkt` when `edited_at` is set.

### Exported interface

```js
export function mountUpdates({ compose, feed, client, workspaceId, memberId });
export function humanUpdateError(error);   // for the shared error boundary
```

`mountUpdates` returns a handle with `refresh()` and `destroy()` so Home can
refresh it with the rest of the page and tear it down on sign-out.

### What it does not do

Listing these because each one is a thing someone will ask for and the answer
needs to already exist: no notifications, no email, no push, no comments, no
attachments, no AI-written or AI-summarised updates, no streaks, no time
tracking, no calendar, no export, no second navigation item, and **saving an
update never completes a task, changes a Work item or creates a commitment.**

That last one matters most. A report is an account of work. If posting one could
silently close something, nobody could write an honest update.

---

## 3. The mount contract — the thing to agree before anyone touches shared markup

There is **no new section and no new nav item.** This mounts inside Home, which is
yours.

**Proposal: you place two empty containers with stable ids, I self-mount on them
if they exist.**

```html
<div id="home-update-compose"></div>
<div id="home-update-feed"></div>
```

`hub-updates.js` looks for those two ids on boot. **If either is absent it does
nothing and logs nothing** — so your Home can move them, rename the wrapper, or
ship without them, and the worst case is the feature is invisible rather than the
page breaking.

That keeps the line clean: **you own where it sits and how the page reads around
it. I own what happens inside those two boxes.** No shared file needs both of us
in it except `hub.html` once, for two empty divs, and `lang/*.js` for the keys.

If you would rather call an init explicitly from Home's boot path than have me
self-mount, say so — that is your call and either works.

### Shared files I would touch, and only these

| File | What |
|---|---|
| `hub.html` | Two empty divs inside Home. Nothing else |
| `lang/en.js`, `lang/nl.js` | New `updates.*` keys |

Everything else is new files.

### The legibility path, which is yours not mine

The agreed sequence is: find my next action → open or update that item → record
the working-block update → read the team's latest updates. Three of those four
are Work and Home. **I am building the third box, not the path.** If the path
does not read for someone with no history with the tool, that is the design pass
and it is yours.

---

## 4. i18n

New namespace `updates.*`, English as source, Dutch complete or the existing test
fails. Roughly 18 keys: three prompts, three field placeholders, the button, the
confirmation, the edited marker, the empty state, the two error sentences, and
date and time formatting labels.

**The Dutch is the version that matters here.** Marco is the reader and the whole
feature is for him. It gets written as a colleague would write it, not as
software Dutch, and the prompts stay one word each so the form does not look like
a questionnaire.

---

## 5. How we will know it is done

Straight from the agreed definition, so this is checkable rather than argued:

1. **Emiel finds his assigned next action**, posts a real short update from his
   phone in roughly two minutes, with no coaching, and reloads it.
2. **Marco opens Home and identifies the result, the blocker and the next step in
   roughly one minute.**
3. A second member's update is visible to the first, and **a viewer can read and
   cannot post.**
4. **Authorship cannot be forged** — an insert claiming another `author_id` is
   refused by the policy, not by the interface.
5. **A failed save loses nothing.** Network failure keeps the typed text and says
   so in a sentence.
6. **The existing Work path still passes**, full suite green.
7. **No constraint name reaches a person** for either new constraint.

Point 1 needs a real agreed work item assigned to Emiel. Inventing one to
populate the screen would prove nothing.

## 6. Budget, honestly

The fuse is one working day, six combined active engineering hours across both
agents, including review and verification, and your reference research comes out
of the same budget.

My half — migration, module, CSS, i18n, tests — is about three hours if nothing
surprises me. That leaves three for your Home placement, the clarity changes and
up to an hour of reference research. **That is the entire budget with nothing
spare**, and I would rather say so now than report it as an overrun later.

If it does not fit, my proposal for what gets cut first is the edit path: post
and read is the loop, correcting a typo is not. Say if you would cut something
else.

## 7. What I want from your second read

1. **(a) or (b)** on how the feed reaches Home.
2. **Self-mount on ids, or an explicit init call** from your boot path.
3. **The container ids**, if you want different ones.
4. Anything in the schema that is wrong or too generous. Particularly whether
   viewers should read updates at all, which I have assumed yes because Marco
   reading must not require posting rights.

006 and 003 untouched. Nothing built, nothing deployed.
