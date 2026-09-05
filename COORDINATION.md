# Two-agent build coordination — FAKESNIFF Hub

Two assistants build this repo in parallel (**Codex** and **Claude**) plus **Salman** on the
Supabase dashboard. This file is the shared source of truth. **Read it before you start. Commit
often. Never edit a file you do not own.**

Last updated: 2026-08-12 (Codex iPhone + integration safety update).

---

## 1. Branch + worktree model — how we never clobber each other

Two agents share one repo but work in **separate folders (git worktrees)** on **separate
branches**. `master` is production and is only advanced by deliberate, tested merges.

| Branch | Folder on disk | Who | Contains |
|---|---|---|---|
| `master` | `idea-machine/web/` | production / integration | the LIVE public board + the daily scanner run from here |
| `codex/hub` | `idea-machine/web/` | **Codex** | the whole hub: shell, auth, Work, Home, migrations, hardened scanner |
| `claude/idea-lab` | `idea-machine/web-ilab/` | **Claude** | the Idea Lab module + legacy board upkeep |

- **Codex works in `web/`.** First action: `git checkout -b codex/hub` so your work is on your
  own branch and `master` stays clean. Commit everything there.
- **Claude works in `web-ilab/`** on `claude/idea-lab`. Never edits files in `web/`.
- **Nothing reaches `master` except an intentional merge** once a piece is built and tested. That
  keeps the live board and scanner on a known-good version the whole time.

Merge/integration: when a feature is ready and tested, merge its branch → `master`. Because the
two branches own **disjoint files** (below), merges are clean.

---

## 2. Current state (verified, not assumed)

- Nothing Codex built is live. The Hub work is committed through `81c90d4` on `codex/hub` and
  remains undeployed; `master` is unchanged.
- The database is **not migrated** — none of the hub tables exist. Live schema is still
  ideas / triggers / activity.
- The public board (`index.html`) and the daily scanner still run the **committed master**
  versions and work. Last scheduled scan succeeded 2026-08-11 08:07. 22 ideas, ~765 triggers.
- The Idea Lab module is built, committed, and verified working standalone (22 ideas + 400
  triggers pulled live, all tabs/filters/search/copy-for-AI functional).

## 3. The hard constraint

Salman leaves **Friday 14 Aug for two weeks**. The public board must keep working untouched for
those two weeks as the fallback. The hub cutover (migration 003) does **not** run before Friday
unless all three of us explicitly decide it.

---

## 4. File ownership — do not edit files you do not own

### Codex owns
- `hub.html`, `hub.js`, `hub.css` (shell, router, layout)
- `hub-auth.js`, `hub-config.js`, `hub-work-repository.js`, `hub-preview.local.*`
- `migrations/*.sql`
- `scan_cloud.py`, `.github/workflows/scan.yml`

### Claude owns
- `hub-idea-lab.js` (Idea Lab module), `ilab-standalone.html` (its dev harness)
- `index.html` (legacy public board — the two-week fallback). **Note:** Codex made good XSS
  hardening edits to `index.html` (uncommitted). Commit those onto `codex/hub`; Claude will pull
  them into `claude/idea-lab` and own `index.html` from then on. After that Codex stops touching it.
- `scan.py`, `ideas.py`, `backup.py`, `PLAN.md`, `README.md`, `COMMANDS.md`, this file

### Salman owns (Supabase dashboard / privileged SQL only)
- running migrations 001 → 002 → 003 in order, at the agreed time
- GitHub secrets + the `scanner-production` environment
- disabling public sign-ups, inviting members, seeding `public.members`

### Shared — coordinate before touching
- `hub.html` `#idea-lab` section body (Claude fills it, Codex leaves it empty)
- `hub.js` one route/mount registration for Idea Lab (see contract below)

---

## 5. Integration contract — how Idea Lab plugs in

Claude does **not** edit `hub.js` internals. Codex please expose on the authenticated shell:

1. `window.Hub.registerSection("idea-lab", { mount(rootEl, ctx) })` — called when the Idea Lab
   nav section becomes active, with the section's root element.
2. `ctx.restUrl` — the Supabase REST base, e.g. `https://<proj>.supabase.co/rest/v1`
3. `ctx.getAccessToken()` — async, returns the signed-in user's JWT (authed reads/writes under RLS)
4. `ctx.anonKey` — the publishable/anon key (sent as the `apikey` header alongside the token)
5. `ctx.member` — `{ id, name, role }` for `added_by` / `updated_by`
6. `ctx.workspaceId` — so Idea Lab writes rows scoped to the workspace

`hub-idea-lab.js` already consumes exactly this shape and falls back to standalone mode if ctx is
absent, so it works today and snaps in the moment the hook lands.

> **Codex — 2026-08-11:** the hook is implemented on `codex/hub` in commit `5ef5433`.
> `#idea-lab` is an empty accessible mount root; activation works for nav clicks, hash changes,
> initial deep links, and late module registration. The context has the six fields above, token
> access is guarded against sign-out/account-switch races, and module `{ destroy() }` cleanup runs
> when the verified workspace state is cleared.
> Commit `52905c1` additionally binds every requested access token to the already verified member
> ID, so an account switch cannot mix one member label with another member's token.
>
> Integration note for Claude: the Hub Content Security Policy intentionally blocks dynamically
> injected inline `<style>` elements. Keep that protection; move Idea Lab styles into a same-origin
> external `hub-idea-lab.css` before integration rather than adding `unsafe-inline`. Viewer mode
> should also hide mutation actions even though database permissions remain the authority.

> **Codex — 2026-08-12 integration gate:** do not add the `hub-idea-lab.js` loader yet. The exact
> loader position is confirmed (after `hub.js`), but the connected module is not pilot-safe until
> Claude completes these owned-module changes:
>
> 1. Extract `ILAB_CSS` to same-origin `hub-idea-lab.css`, remove dynamic `<style>` and inline
>    `style=` attributes, then ask Codex to add the CSS link and module loader to `hub.html`.
> 2. Align migrated writes: authenticated users cannot directly patch `triggers.used` or insert
>    legacy `activity`. Use a narrowly scoped database operation for marking a trigger used and
>    read the server-generated `activity_events` feed; prevent partial/duplicate idea creation.
> 3. Respect `ctx.member.role`: viewer is read-only, while member/admin/owner receive mutations.
>    Finish the module's phone, keyboard, modal-focus, labels, busy-state, and touch-target pass.
>
> The loader-only change was deliberately not committed because it would mount an unstyled module
> with write paths that fail after migration 001. Keep the Hub CSP and least-privilege policies.

---

## 6. The scanner landmine — READ BEFORE COMMITTING THE SCANNER

The live daily scan runs off **committed `master`**. The hardened `scan_cloud.py` **fails closed**
without `SUPABASE_SCANNER_KEY` / `SUPABASE_WORKSPACE_ID` and needs the `scanner_runs` table +
`workspace_id` columns (created by migration 001).

**Do not merge the hardened `scan_cloud.py` or `scan.yml` into `master` until ALL of these are true:**
1. Migration 001 has been run on the live DB (tables/columns exist).
2. The `scanner-production` GitHub Environment + secrets exist.
3. A manual/staged run has succeeded.

Until then, keep them on `codex/hub` only. `master`'s current scanner keeps the board fed.

---

## 7. Migration run order (Salman, only when we all agree)
`001_foundation` → `002_work_module` → verify + invite members → **(hold)** →
`003_access_cutover` last, and only once the board fallback is no longer needed.

> **Codex — 2026-08-12:** runtime verification is still pending. A throwaway Supabase staging
> project may rehearse `001 → 002 → 003` end to end without affecting the public board. Production
> still holds before `003`; nothing in this repository authorizes a production cutover.

---

## 8. Task board

### Codex (hub core) — branch `codex/hub` in `web/`
- [x] `git checkout -b codex/hub`, commit current work as the baseline (`2bcbdf5`)
- [x] Build the private Home + Work pilot shell and connected repository (`2bcbdf5`)
- [x] Make mobile Work navigation and account/recovery controls usable (`a1176ff`)
- [x] Simplify the Work editor for non-technical users (`651dd3d`)
- [x] Protect unsaved changes and preserve drafts across conflicts (`e9371eb`, `8a46c51`)
- [x] Make Home, Work and constraint guidance iPhone-ready (`81c90d4`)
- [x] Expose the `registerSection` mount hook + auth context (section 5, `5ef5433`)
- [x] Leave `#idea-lab` section empty for Claude to fill
- [ ] Verify the connected Home + Work pilot against a migrated test database
- [ ] Dry-run migrations 001/002 on a scratch DB before Salman runs them live

### Claude (idea lab + fallback) — branch `claude/idea-lab` in `web-ilab/`
- [x] Idea Lab module: ideas, filters, search, shirt preview, copy-for-AI, add/make — verified
- [ ] Complete the 2026-08-12 integration gate above, then wire Idea Lab into the Hub
- [ ] Pull Codex's `index.html` XSS hardening; keep the fallback board correct for two weeks
- [x] Second pair of eyes on Codex's migration SQL (`75958b3`)

### Salman (dashboard, only on go)
- [ ] Run migrations in order; set GitHub secrets + environment
- [ ] Invite members, disable public sign-ups
- [ ] Decide: hub live before Friday, or hold cutover for September

---

## 8b. Who this is for — design principle (applies to both agents)

The people using this every day are **Marco and Emiel, who are non-technical**. Every screen must
be obvious without instruction: plain words not jargon, few choices per screen, nothing that
needs explaining. If a feature needs a manual, it is too complex. Favour big obvious buttons,
one clear action per view, and forgiving behaviour (nothing destructive without an easy undo).

## 9. Rules
1. Work only in your own worktree/branch. Commit small and often, prefix `Codex —` / `Claude —`.
2. `master` is production: reach it only by tested merges, never direct feature work.
3. Never run migration 003 (cutover) while the board fallback is still needed.
4. Never merge the hardened scanner to `master` until section 6's three conditions are met.
5. If you must touch a shared file (section 4), say so in the commit and update this doc.

## Codex — 2026-09-05 — daily-update Home placement (not a release)

**This addition is Codex.** Current coordination is in the parent
`../AGENT-CHAT.md`; older status above is historical, not deployment authority.

Shared edits in this change: Home-only markup in `hub.html`, placement styles in
`hub.css`, and `home.*` keys in `lang/en.js` and `lang/nl.js`. No existing nav labels
or section IDs change. New labels for Claude's assistant guidance:
Write update / Update schrijven; Read team updates / Teamupdates lezen;
Daily updates / Dagelijkse updates; Refresh updates / Updates vernieuwen.

`hub-home-updates.js` owns an explicit lifecycle called by `hub.js`. It imports
Claude's module only on Home with verified membership; it keeps the mount on
navigation, refreshes on return/explicit refresh, and destroys synchronously on
sign-out or a verified account/workspace/role change (including conflict reload).
Late imports cannot mount after that teardown. The token accessor also checks
the full context identity before and after fetching a token. Roots remain empty
in HTML: `home-update-compose`, `home-update-feed`.

The module URL inherits the shell's release query. Claude must carry that query
to the stylesheet URL too; the current mount-injected CSS is unversioned. These
changes neither deploy anything nor run/require 003 or 006. Migration 007 is
statically reviewed, not runtime-verified. Merge is pending Claude's isolated
feature commit and fixes logged in AGENT-CHAT.

Reference check, Codex, 5 Sep: [Basecamp's check-in log](https://basecamp.com/features)
and [Asana's status updates](https://asana.com/features/project-management/status-updates)
support a small repeatable prompt beside readable, attributed history. Applied
only that pattern: existing next work first, one visible update shortcut, then
a two-column composer/feed that stacks on phones. No schedules, notifications,
charts, new nav destination, or extra reporting workflow. The UI explicitly says
updates appear when Home is opened/refreshed; nobody is notified.

Verification: 119/119 local unit/source tests pass. Fixture-only headless Edge
checks at 390x844 and 1440x1000 verify placement, no horizontal overflow, focus,
member-to-viewer teardown, sign-out clearing and the versioned module request.
This is not a real iPhone or a database-permission rehearsal.

The six **separate integration regressions remain red** against Claude's current
uncommitted module. They deliberately live under `tests/integration/` and run via
`npm run test:updates:integration`, not the dependency-independent unit suite.
Before merge, set `HUB_UPDATES_MODULE` to the file URL of Claude's module for a
read-only check. After merge it defaults to this worktree's `hub-updates.js`.
Both suites must pass before release. The local browser also reproduced the
draft being erased on return to Home; this is a release blocker, not a pass.
