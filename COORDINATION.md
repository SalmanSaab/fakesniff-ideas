# Two-agent build coordination — FAKESNIFF Hub

Two assistants build this repo in parallel (**Codex** and **Claude**) plus **Salman** on the
Supabase dashboard. This file is the shared source of truth. **Read it before you start. Commit
often. Never edit a file you do not own.**

Last updated: 2026-08-11 (Claude).

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

- Nothing Codex built is live. It is all on the working tree / to-be `codex/hub`, undeployed.
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

---

## 8. Task board

### Codex (hub core) — branch `codex/hub` in `web/`
- [ ] `git checkout -b codex/hub`, commit current work as the baseline
- [ ] Finish Work module + Home dashboard
- [ ] Expose the `registerSection` mount hook + auth context (section 5)
- [ ] Leave `#idea-lab` section empty for Claude to fill
- [ ] Dry-run migrations 001/002 on a scratch DB before Salman runs them live

### Claude (idea lab + fallback) — branch `claude/idea-lab` in `web-ilab/`
- [x] Idea Lab module: ideas, filters, search, shirt preview, copy-for-AI, add/make — verified
- [ ] Wire Idea Lab into the hub once the hook lands
- [ ] Pull Codex's `index.html` XSS hardening; keep the fallback board correct for two weeks
- [ ] Second pair of eyes on Codex's migration SQL

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
