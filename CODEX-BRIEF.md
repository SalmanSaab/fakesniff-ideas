# Brief for Codex — parallel hub build

Claude and you are building this repo at the same time. Salman is coordinating. Full detail is in
`COORDINATION.md`; this is the short start-here.

## The setup (already done by Claude)
- We use **git worktrees** so we never share a folder. You stay in `idea-machine/web/`. Claude
  works in a separate worktree `idea-machine/web-ilab/`. Neither of us can touch the other's files.
- `master` = production. The live public board and the daily scanner run from committed `master`.
  It stays on a known-good version; nothing reaches it except deliberate, tested merges.

## Do this first
1. In `web/`: `git checkout -b codex/hub` and commit your current hub work there. That gets your
   work onto your own branch and keeps `master` clean. (Your uncommitted changes come with you.)
2. Keep building the hub on `codex/hub`: shell, auth, Home, Work, migrations.

## Two things Claude needs from you
1. **A mount hook** so the Idea Lab module plugs in without anyone editing `hub.js` by hand:
   `window.Hub.registerSection("idea-lab", { mount(rootEl, ctx) })`, called when the Idea Lab
   nav section activates. Leave the `#idea-lab` section body empty — Claude fills it.
2. **Auth context** passed as `ctx` to that mount: `restUrl`, `getAccessToken()`, `anonKey`,
   `member {id,name,role}`, `workspaceId`. `hub-idea-lab.js` already consumes exactly this shape.

## Two things NOT to do
1. **Do not merge the hardened `scan_cloud.py` or `scan.yml` into `master`** until migration 001
   is live, the `scanner-production` GitHub secrets exist, and a staged run has passed. The
   hardened scanner fails closed and would break the daily scan that currently feeds the board.
   Keep them on `codex/hub`.
2. **Do not run migration 003 (access cutover).** That is Salman's call and only after the board
   fallback is no longer needed. Salman leaves Friday for two weeks; the board must survive.

## Ownership (so we don't collide)
- You own: `hub.*`, `hub-auth.js`, `hub-config.js`, `hub-work-repository.js`, `migrations/*`,
  `scan_cloud.py`, `scan.yml`.
- Claude owns: `hub-idea-lab.js`, `index.html`, `scan.py`, `ideas.py`, `PLAN.md`, `COORDINATION.md`.
- `index.html`: commit your XSS hardening onto `codex/hub`; Claude will pull it and own the file
  after that, so you can stop touching it.

## How we combine
When a piece is built and tested, merge its branch → `master`. Disjoint files = clean merges.
Update `COORDINATION.md` if you touch anything shared.
