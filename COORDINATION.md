# Two-agent build coordination — FAKESNIFF Hub

Two assistants are building this repo in parallel (Codex and Claude), plus Salman on the
Supabase dashboard. This file is the shared source of truth. **Read it before editing any file
you do not own. Commit often.**

Last updated: 2026-08-11.

---

## Current state (verified, not assumed)

- Nothing Codex built is live yet. It is all uncommitted / undeployed.
- The database is **not migrated** — none of the hub tables exist. Live schema is still
  ideas / triggers / activity from the original board.
- The public board (`index.html`) and the daily scanner still run the **original committed**
  versions and work. This morning's 7am scan succeeded. 22 ideas, 765 triggers.
- The hub is a full authenticated company platform: Home + Work built, Idea Lab / Designs /
  Decisions are empty stubs.

## The hard constraint

Salman leaves **Friday 14 Aug for two weeks**. The public board must keep working untouched for
those two weeks as the fallback. The hub cutover (migration 003) does NOT run before Friday
unless we all explicitly decide to.

---

## File ownership — do not edit files you do not own

### Codex owns
- `hub.html`, `hub.js`, `hub.css` (the shell, router, layout)
- `hub-auth.js`, `hub-config.js`, `hub-work-repository.js`
- `hub-preview.local.*`
- `migrations/*.sql`
- `scan_cloud.py`, `.github/workflows/scan.yml`

### Claude owns
- `hub-idea-lab.js`, `hub-idea-lab.css` (the Idea Lab module — new files)
- `index.html` (the legacy public board — kept alive as the two-week fallback)
- `scan.py` (the local scanner), `ideas.py`, `backup.py`, `PLAN.md`, `README.md`, `COMMANDS.md`
- this file

### Salman owns (Supabase dashboard / privileged SQL only)
- running migrations 001 → 002 → 003 in order, at the agreed time
- GitHub secrets + the `scanner-production` environment
- disabling public sign-ups, inviting members, seeding `public.members`

### Shared — coordinate before touching
- `hub.html` — the `#idea-lab` section body (Claude fills it; Codex leaves it empty)
- `hub.js` — one route-registration line for Idea Lab (see integration contract)

---

## Integration contract (how Idea Lab plugs in without collisions)

Claude does NOT edit hub.js internals. Codex please expose, on the authenticated shell:

1. A module mount hook, e.g. `window.Hub.registerSection("idea-lab", { mount(rootEl, ctx) })`,
   called when the `#idea-lab` nav section becomes active.
2. `ctx.db` — the **authenticated** Supabase client (so Idea Lab reads/writes ideas + triggers
   under the same session + RLS as Work, not the anon key).
3. `ctx.member` — `{ id, name, role }` for the signed-in user, for `added_by` / `updated_by`.
4. `ctx.workspaceId` — so Idea Lab writes rows scoped to the workspace.

Until that hook exists, Claude builds Idea Lab standalone against its own files and the existing
ideas/triggers tables, and wires it in once the hook lands.

---

## Task board

### Codex (hub core)
- [ ] Commit current hub work to master as the clean baseline (do this first)
- [ ] Finish Work module + Home dashboard
- [ ] Expose the module hook + auth context above
- [ ] Verify migrations 001/002 apply cleanly on a scratch DB before Salman runs them live

### Claude (idea lab + fallback)
- [ ] Idea Lab module: ideas grid, filters, raw-material search, shirt preview, copy-for-AI
- [ ] Idea Lab: add-idea + make-from-trigger, writing under the authed session
- [ ] Keep `index.html` public board alive and correct for the two weeks away
- [ ] Second pair of eyes on Codex's migration SQL

### Salman (dashboard, only when we all say go)
- [ ] Run migrations in order on the live DB
- [ ] Set GitHub secrets + environment
- [ ] Invite members, disable public sign-ups
- [ ] Decide: hub live before Friday, or hold cutover for September

---

## Rules
1. Commit small and often, with `Codex —` or `Claude —` in the message so we can tell work apart.
2. Never run migration 003 (cutover) until the board fallback is no longer needed.
3. Never commit `scan_cloud.py`'s hardened version to master until the GitHub secrets AND the
   migration are live — it fails closed and would break the daily scan.
4. If you must touch a shared file, say so in your commit and update this doc.
