/* Codex — 2026-09-05: explicit Home lifecycle, separate from rendering and
   transport. The shell supplies only a verified, current membership context.
   Navigation preserves the mounted draft; identity changes destroy it. */
export function createHomeUpdatesLifecycle({ loadModule, getContext, getRoots, onState = () => {} }) {
  let entry = null;

  function destroy() {
    const previous = entry;
    entry = null; // Invalidate pending imports/refreshes before disposing DOM.
    if (previous) {
      try { previous.handle?.destroy(); } catch { /* Still clear private roots. */ }
      previous.roots.compose.replaceChildren();
      previous.roots.feed.replaceChildren();
      previous.handle = null;
    }
    onState("idle");
  }

  function isCurrent(candidate) {
    return entry === candidate && getContext()?.key === candidate.key;
  }

  function refreshEntry(candidate) {
    if (!isCurrent(candidate) || !candidate.handle) return Promise.resolve(false);
    if (candidate.refreshing) return candidate.refreshing;
    // Module owns feed errors and recovery. A rejected refresh still gets a
    // plain shell fallback; no raw exception escapes into the interface.
    candidate.refreshing = Promise.resolve().then(() => {
      if (!isCurrent(candidate)) return false;
      return candidate.handle.refresh();
    }).then(() => {
      if (!isCurrent(candidate)) return false;
      onState("ready", candidate.ctx);
      return true;
    }, () => {
      if (isCurrent(candidate)) onState("error", candidate.ctx);
      return false;
    }).finally(() => { candidate.refreshing = null; });
    return candidate.refreshing;
  }

  function sync({ active = false, refresh = false } = {}) {
    const verified = getContext();
    const roots = getRoots();
    if (!verified?.key || !roots?.compose || !roots?.feed) {
      destroy();
      return Promise.resolve(null);
    }
    if (entry && (entry.key !== verified.key || entry.roots.compose !== roots.compose || entry.roots.feed !== roots.feed)) destroy();
    if (!active) return Promise.resolve(entry?.handle || null);
    if (entry?.handle) {
      const current = entry;
      return refresh ? refreshEntry(current).then(() => isCurrent(current) ? current.handle : null) : Promise.resolve(current.handle);
    }
    if (entry?.loading) return entry.loading;

    const candidate = { key: verified.key, ctx: verified.ctx, roots, handle: null, loading: null, refreshing: null };
    entry = candidate;
    onState("loading", candidate.ctx);
    candidate.loading = Promise.resolve().then(loadModule).then((module) => {
      if (!isCurrent(candidate)) return null;
      // Contract: mount is synchronous; network loading is explicit refresh().
      const handle = module.mountUpdates({ ...roots, ctx: candidate.ctx });
      if (!handle || !["destroy", "refresh", "openComposer"].every((key) => typeof handle[key] === "function")) {
        try { handle?.destroy?.(); } catch { /* Shell fallback below. */ }
        throw new TypeError("Invalid updates lifecycle");
      }
      candidate.handle = handle;
      onState("ready", candidate.ctx);
      return refreshEntry(candidate).then(() => isCurrent(candidate) ? handle : null);
    }).catch(() => {
      if (isCurrent(candidate)) {
        try { candidate.handle?.destroy(); } catch { /* Clear even after failed mount. */ }
        candidate.handle = null;
        roots.compose.replaceChildren();
        roots.feed.replaceChildren();
        onState("error", candidate.ctx);
      }
      return null;
    }).finally(() => { candidate.loading = null; });
    return candidate.loading;
  }

  async function openComposer() {
    const handle = await sync({ active: true });
    if (!handle || handle !== entry?.handle || !isCurrent(entry)) return false;
    if (!["member", "admin", "owner"].includes(entry.ctx.member.role)) return false;
    handle.openComposer();
    return true;
  }

  return Object.freeze({ sync, openComposer, destroy });
}
