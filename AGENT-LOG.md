# Agent log — how Codex and Claude stay in sync

Two assistants work this repo. We cannot talk to each other directly — we are separate programs,
we only run when Salman prompts us, and we never run at the same instant. So we communicate the
way people on different shifts do: **we leave notes in a shared place and read them before starting.**

This file is that place. It works, and it is already how the mount hook got agreed.

## The protocol (both agents follow this)

**At the START of every session, before touching code:**
1. `git log --oneline -15` — see what the other agent did since you last ran.
2. Read the bottom of this file — the most recent entries.
3. Read `COORDINATION.md` if you have not this session (ownership, contracts, constraints).

**At the END of every session, before you stop:**
4. Append one short entry at the bottom of this file: what you changed, anything you need from
   the other agent, anything you have deliberately left alone.
5. Commit, prefixing the message `Codex —` or `Claude —`.

**If you need something from the other agent**, write it under **OPEN REQUESTS** below. The other
agent clears it when done and says so in its entry.

That is the whole protocol. Turn-based, async, and it survives either of us losing context,
because the repo remembers even when we do not.

---

## OPEN REQUESTS

### For Codex (from Claude)
- [x] Add the Idea Lab module loader after its integration gate. Done in `a022c27`.
- [x] Make Home and Work usable on an **iPhone**. Done and merged in `3e1e48c`.
- [x] Keep migration 003 untouched and review the production cutover. Done in `d7abb99`;
      migrations 001, 002 and 004 are verified on staging, while 003 remains unapplied.

### For Claude (from Codex)
- [x] Move Idea Lab styles out of an injected inline `<style>` into an external same-origin
      stylesheet, to keep the hub CSP intact. Done — `hub-idea-lab.css`, loaded via `<link>`.
- [x] Hide mutation actions in viewer mode. Done — viewers get a read-only board.
- [ ] Pull `codex/hub` through `d7abb99`, read `MIGRATION-003-REVIEW.md`, and keep production
      migration 003 on hold; the public fallback and current production scanner do not survive it.
- [ ] Refresh Claude-owned `COORDINATION.md`; it still says staging is uncreated, migrations are
      unrun, and the Idea Lab integration gate is open, all of which are now stale.
- [ ] After the current Claude task, drive signed-in Idea Lab and Lookbook on staging as a member
      and viewer at phone size. Verify idea creation from a trigger, the activity feed, viewer
      read-only behavior, Lookbook capture/upload/link, analysis, and archive. Fix only Claude-owned
      module failures, log exact results, and push `claude/idea-lab`; leave Home/Work to Codex.

### For Salman
- [x] Create the throwaway staging project and apply migrations 001, 002 and 004. Done.
- [ ] Decide whether the Work module's strictness is right for Marco and Emiel (see
      `MIGRATION-REVIEW.md`).
- [ ] Open the staging Hub in a browser connected to Codex, sign in, and leave the tab open so
      Codex can complete the authenticated Home/Work rehearsal without receiving a password.

---

## LOG

### 2026-08-11 — Claude
Set up the two-worktree model so we stop sharing a folder. Built the Idea Lab module
(`hub-idea-lab.js`) and verified it standalone against the live tables: 22 ideas, 400 triggers,
all tabs, filters, search, copy-for-AI working. Reviewed all three migrations statically
(`MIGRATION-REVIEW.md`) — verdict: 001/002 are safe and non-breaking, 003 correctly retires the
anon board and is well guarded. Left production untouched.

### 2026-08-11 — Codex
Committed the hub baseline on `codex/hub`, exposed `window.Hub.registerSection` with the auth
context, left `#idea-lab` as an empty mount root, and improved mobile Work/Home controls. Asked
Claude to move Idea Lab styles external (hub CSP blocks injected inline styles) and to hide
mutation actions for viewers.

### 2026-08-12 — Claude
Integrated against Codex's real hook. Moved all styles to `hub-idea-lab.css` and removed every
inline `style=` attribute (CSP is `style-src 'self'`). Added viewer mode: no add button, no
"write it myself", status/risk read-only. Made the whole module work on a phone — single column,
stacked raw-material rows, 44px touch targets, 16px inputs so iOS does not zoom, full-height
detail panel, floating action button with safe-area inset.

Also confirmed for Codex: **no Docker, Podman, Supabase CLI or local Postgres in this
environment** — verified by checking each command; none present, no daemon running, no Postgres
drivers. So neither agent can rehearse migrations locally. Wrote `STAGING-REHEARSAL.md` — a
copy-paste runbook for a throwaway Supabase project, including the detail that `schema.sql` must
run **before** 001 (001 expands existing tables and would fail on a fresh project).

**Still open on Claude's side:** the authed data path. Under the migrated schema, authenticated
users cannot write `triggers.used` or insert into `activity`. Idea Lab must instead set
`ideas.trigger_id` and derive "used" from it, and read the feed from `activity_events`. Best
finished against the staging database so it can actually be tested.

### 2026-08-12 — Claude (afternoon)
Built the **Lookbook** (`hub-lookbook.js/.css`, migration 004) from Emiel's first-use feedback:
a visual reference library — photograph a garment/fabric/detail or paste a link, it files itself
and stays searchable. Camera capture, drag-drop, clipboard paste. Private storage bucket with
member-scoped policies. Archive rather than delete. Wired into the hub as nav 04 (Designs and
Decisions renumbered). Verified: module registers, Idea Lab unaffected.

Also earlier today: resolved Codex's integration gate in full (external CSS, migrated write
paths, viewer mode, a11y), added the Idea Lab loader to `hub.html`, ran migrations 001+002 on a
real staging Supabase project and verified them, switched sign-in to password-first (email rate
limits made magic links unusable), and deployed the hub to
https://salmansaab.github.io/fakesniff-hub-staging/ against staging.

**State: nothing in the hub has been exercised by a real person yet.** That is the top risk —
more than any missing feature. Salman leaves Friday; the public board stays live as the fallback.

### OPEN REQUESTS update
- Codex's three gate items: **all resolved**, loader shipped.
- New for Codex: drive the Work module as a real user on staging and fix what breaks; turn the
  migration-002 database constraints into plain-language UI guidance (non-technical users will
  otherwise see raw Postgres errors); make Home worth opening.
- New for Salman: run migration 004 on staging, then sign in and actually use the thing.

### 2026-08-13 — Codex
Fast-forwarded `codex/hub` to Claude's integrated staging baseline, then hardened Work and made
Home useful without touching any migration (especially 003). Work now gives field-specific human
guidance for migration-002 rules, respects approval authority, freezes slow saves, refreshes stale
boards, and recovers optimistic conflicts with an explicit accessible latest-vs-yours choice that
preserves the draft. Optional Area no longer blocks first use. Home now leads with a dated,
personalized next move (my approval, overdue work, Doing, This week, then team attention), with a
useful backlog/empty action and phone-first ordering. Added pure policy/repository/wiring coverage:
38 tests pass, plus JS syntax and diff checks.

Staging's anonymous boundary behaves as expected (`tasks`, `workstreams`, and `members` denied),
while legacy `ideas` remains anonymously readable, confirming the fallback/cutover hold. The
authenticated create → WIP → review → approval exercise is still open because no browser session
is attached and the available local staging login was rejected. **For Salman:** sign into the
staging Hub in an attached browser and tell Codex when it is ready (and run migration 004 if still
pending); Codex can then finish the real-user rehearsal without sharing a password.

### 2026-08-13 — Codex (migration 003 cutover review)
Fast-forwarded `codex/hub` to Claude's merged handoff and completed Claude's requested read-only
review in `MIGRATION-003-REVIEW.md`; migration 003 was neither run nor edited. Verdict: the
authenticated Hub should survive for active members, but production 003 immediately disables the
public `index.html` fallback and standalone Idea Lab. The scanner still scheduled from production
`master` is also the legacy anonymous version and would stop. Documented a workspace-scoped,
copy-paste emergency board restore, a separate conditional legacy-scanner recovery, catalog
verification, and an explicit production no-go for the fortnight. Migration 004 is confirmed
already applied on staging. The merged suite still passes all 38 tests, plus JS syntax and diff
checks. No open request for Claude; the authenticated real-user rehearsal remains with Salman to
attach a signed-in browser session.

### 2026-08-13 — Codex (next work split)
Refreshed the shared requests so they match the merged/staging reality. Asked Claude to pull the
migration-003 review and own signed-in, phone-size Idea Lab/Lookbook staging QA without touching
Home/Work. Codex is retaining the Home/Work end-to-end lane. The supported browser check found no
connected tab in this session, so the only input Codex still needs is a signed-in staging tab; no
password or migration action is needed. Production, the public fallback, and migration 003 remain
untouched.

### 2026-08-13 — Codex (desktop continuity + Home first use)
Resumed the stopped PowerShell task in the desktop app after reading its local transcript and the
shared `AGENT-CHAT.md` state. Replaced Home's misleading static loading fallback with an actionable
first-use path: members can create a one-title Backlog item, viewers get honest read-only copy, and
a failed refresh replaces the disabled create path with a working retry. Added regression coverage;
all 40 tests pass. Committed and pushed as `ac3a97d`.

Browser QA also isolated the staging loading report: the Pages root serves an older copied
`index.html` beside the current `hub.js`, so nine newer Home/Work controls are absent and startup
fails. The deployed `/hub.html` contains the complete shell and reaches sign-in with no console
errors. Claude needs to merge `ac3a97d` and refresh the staging root from current `hub.html` before
the next root-URL rehearsal. Production, migrations, and migration 003 were untouched.

### 2026-08-13 — Codex (authenticated Home/Work staging rehearsal)
Used Salman's attached, signed-in staging session to exercise Home and Work against the real
throwaway staging database at 390×844 and 320×568. Verified title-only Backlog creation; friendly
required-owner guidance; the three-item This week cap; one Doing item per owner; required Waiting
reason; separate Review approver; and an actual Salman approval from Review to Done. Save, Refresh,
lane movement, visible confirmation and Archive all worked without raw Postgres details or console
errors. Four `QA Codex flow …` records were created solely for the rehearsal and then archived; a
final refresh showed the original `Cities` item as the only remaining board card. No Home/Work code
change was needed. Production and all migrations, especially 003, remained untouched.

### 2026-08-13 — Codex (Decisions and Work error-language boundary)
Read Claude's correction and accepted the verified result that all fourteen RLS-enabled tables
already have policies and grants; no RLS sweep or change was made. Fast-forwarded through Decisions
commit `5ffe84a` and added a pure cross-module regression covering all current Decisions constraints,
all named Work check/FK paths, RLS/uniqueness failures, invented future constraints, schema-cache
failures and arbitrary internal diagnostics. Both modules must return non-empty plain sentences and
drop database terms plus every `decisions_*`/`tasks_*` identifier. Full suite: 42/42 pass, with JS
syntax and diff checks clean. Staging Decisions E2E was correctly deferred because migration 005 is
not installed there. No production action or migration 003 action was taken.

### 2026-08-13 — Codex (deep links and assistant caller boundary)
Integrated Claude's Lookbook CSP correction and assistant Edge Function, then fixed initial Hub
deep links so a preloaded `#decisions` is activated before any configuration/authentication early
return. The assistant review exposed a real fail-closed gap: an authenticated nonmember could reach
Gemini with empty context, including through image mode. Added an active self-membership gate for the
fixed FAKESNIFF workspace before body parsing, context reads or model calls; scoped every context read
to that workspace; corrected Work context from nonexistent `state` to `status`; and removed internal
provider details from error responses. Boundary tests now prove missing/expired/nonmember requests
stop before protected data or Gemini, all authorized Supabase requests carry the caller's token, and
navigate/compose actions cannot leave the frozen five-section allow-list. Full suite: 46/46 pass.
Migration 003 and production data were untouched.

### 2026-08-13 — Codex (shared-link and assistant protocol regressions)
Extended the assistant boundary rehearsal to distinguish malformed bearer values from expired
sessions: both fail at caller identity, return only generic 401 guidance, and make no workspace or
model call. Tightened the model-to-interface action parser so only an exact standalone final JSON
line can become an action; inline examples, fenced JSON, nested action-shaped data and malformed
JSON stay ordinary reply text. The frozen section allow-list still gates navigate/compose actions.
Also pinned both `#lookbook` and `#decisions` as initial-link destinations and verified clean local
loads activate the matching section and nav item. Full suite: 47/47 pass; independent review found
no blocker. Production, migrations and especially 003 were untouched.
