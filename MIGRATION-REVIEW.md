# Migration review — Claude, 2026-08-11

Reviewed all three of Codex's migrations against the live database's current state.

## Verdict

**The migrations are well-built: transactional, idempotent, guarded, and additive.** 001 and 002
do **not** break the live anon board or the current committed scanner — they preserve the legacy
`ideas_all` / `triggers_all` / `activity_all` policies and grants, keep the old
`triggers_title_source_key` constraint the scanner conflicts on, and give the new `workspace_id`
a default so anon writes keep working. 003 (cutover) is correctly the point where the anon board
is retired, and it is guarded by six preflight checks (including "a scan has succeeded") so it
cannot run prematurely. Safe to run **in order, at the right time**.

## Things that need a human decision

### 1. The Work module encodes a rigid methodology (→ Salman to confirm)
Migration 002 enforces, at the database level: every active task (this week / doing / review /
waiting) must have an owner + due date + next action + completion condition; the "this week" lane
is capped at 3; one "doing" task per person; review needs a separate approver. This is a
deliberate, disciplined way to work — but it is a lot of ceremony for three non-technical people,
and the database will hard-reject saves that break the rules. **Decision for Salman/team:** is
this the workflow you want, or should Codex loosen it? Either way the UI must translate these
rules into gentle guidance, not raw SQL errors, per the non-technical-users principle.

### 2. Cutover (003) kills the anon fallback (→ timing decision)
After 003, the public board and the standalone Idea Lab stop working entirely — everything must go
through the signed-in hub. So 003 runs **only** once the hub is proven and the team can sign in.
Given Salman is away two weeks and the board is the fallback, **003 holds until he is back and the
hub is verified.** Already documented; restating because it is the highest-risk step.

## Changes I need to make to MY module (Idea Lab) before it runs inside the authed hub
These are correct behaviours for the standalone anon board today, but the migrated/authed schema is
stricter. I own `hub-idea-lab.js`; I will implement these at wire-in time.

- **"mark trigger used" write will be denied.** Authenticated users get SELECT-only on `triggers`
  (they are scanner-owned). My module currently PATCHes `triggers.used = true`. In authed mode I
  must instead write `ideas.trigger_id` (the FK Codex added) and **derive** "used" from whether an
  idea references that trigger. Cleaner, and matches the intended trigger→idea→design→task chain.
- **Manual activity insert will be denied.** Authenticated users cannot INSERT into `activity`.
  The migration auto-writes an audit row to `activity_events` via a trigger on every idea change,
  so in authed mode I drop my manual `log()` and read the feed from `activity_events`.
- Standalone (pre-migration) mode keeps today's behaviour; I branch on `ctx`.

## Low-risk notes for Codex (scanner)
- 001 adds NOT VALID check constraints on `triggers.category` (must be in the allowed list) and
  `triggers.url` (`^https?://…`, no whitespace). NOT VALID skips existing rows but **is enforced on
  new inserts.** The current feeds satisfy this, but a malformed feed URL or an out-of-list category
  would now fail the insert (and, in a batch, drop its chunk). Worth having the scanner clamp
  category to the allowed set and validate the URL before insert, so a bad feed row can't wedge a batch.

## Bottom line
Nothing here blocks Codex from continuing. The migration SQL is good. The two real decisions are
product/timing ones for Salman, and the two write-path adjustments are mine to make when Idea Lab
wires into the hub.
