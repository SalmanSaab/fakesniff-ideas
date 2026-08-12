# Brief for Codex — restart after budget reset

Welcome back. A lot happened while you were out of budget. Read this first, then
`AGENT-LOG.md`, then `COORDINATION.md`.

## What changed while you were away

**Claude took over the files you owned**, because the hub had to keep moving and
you were unavailable. That means `hub.html`, `hub.js`, `migrations/` and the rest were
edited by Claude. Nothing of yours was thrown away — everything is merged, and your
architecture is intact and still the backbone.

Specifically:
- Your gate items are **resolved**: Idea Lab now has external same-origin CSS, migrated
  write paths (`ideas.trigger_id` instead of `triggers.used`, `activity_events` instead of
  the legacy table), viewer read-only mode, and a full keyboard/focus/label pass.
- **The Idea Lab loader is in** `hub.html` (the one you deliberately withheld). All three of
  your conditions were met first.
- **Migrations 001 and 002 have now actually been run** on a throwaway staging Supabase
  project (`ojbxrtxhlnmapdrwmaod`) and verified: 9 task fields, 6 workstreams, the WIP index,
  and `manage_task_state` (your hardened version, not the foundation one). They are no longer
  "statically reviewed only".
- **Sign-in changed to password-first.** Supabase's built-in email sender is rate limited and
  magic links land in junk — poor for non-technical daily users. Magic link is still there as
  a secondary button.
- **New module: the Lookbook** (`hub-lookbook.js/.css`, `migrations/…_004_lookbook.sql`) —
  a visual reference library from Emiel's first-use feedback. Nav is renumbered: Lookbook is
  04, Designs 05, Decisions 06.
- The hub is deployed for testing at **https://salmansaab.github.io/fakesniff-hub-staging/**
  pointed at the staging database. The live public idea board is untouched and still running.

## The situation

**Salman leaves Friday 14 Aug for two weeks. Turkey is 24 Aug.** The public idea board at
`salmansaab.github.io/fakesniff-ideas` stays live as the fallback the whole time. Migration
003 (the anon cutover) does **not** run until he is back and the hub is proven.

**Nothing in the hub has been used by a real person yet.** That is the biggest risk, not
missing features.

## Your lane now

Claude owns: `hub-idea-lab.*`, `hub-lookbook.*`, `index.html`, `scan.py`, the docs.

**You own, and these are the priorities in order:**

1. **The Work module, end to end.** You built it; nobody has created a task in it. Sign in to
   the staging hub and drive it as a user would: create work, assign an owner, move it through
   the lanes, hit the WIP limits, trigger the approval gate. Fix what breaks.
2. **Translate the database rules into human guidance.** This is the one that matters for
   adoption. Migration 002 enforces a lot at the DB level — every active task needs owner + due
   date + next action + completion condition; "this week" caps at 3; one "doing" per person;
   review needs a separate approver. **Marco and Emiel are non-technical.** If the UI lets them
   hit those as raw Postgres errors, they will stop using the hub that day. Catch each
   constraint and say the human thing: *"Give this an owner and a due date before moving it to
   This week."*
3. **Home dashboard** — make it read as something worth opening on a Tuesday morning. First-use
   feedback said it feels static. It is partly that staging is empty, but partly real.
4. **Do not touch migration 003.**

## Comms with Claude

We cannot message each other directly — separate programs, different sessions. So:

- **`AGENT-LOG.md` in the repo is the channel.** Read the bottom of it before you start;
  append an entry and commit before you stop. `OPEN REQUESTS` is where cross-agent asks live.
- **Salman is the live relay.** If you need Claude to do something now, put it under
  `OPEN REQUESTS` **and** tell Salman in your reply so he can pass it over. Claude can push a
  notification to his phone when it needs you, so the round trip is quick.
- Prefix commits `Codex —` so the history stays legible.

## Ground rules unchanged

- Work in `idea-machine/web/` on `codex/hub`. Claude works in `web-ilab/` on `claude/idea-lab`.
- Do not merge the hardened `scan_cloud.py` / `scan.yml` to `master` until the GitHub secrets
  exist and a staged run has passed — it fails closed and would break the daily scan that
  currently feeds the live board.
- Everything must work on an **iPhone**. Salman works remote from his phone.
