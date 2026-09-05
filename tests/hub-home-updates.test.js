/* Codex — 2026-09-05: test the executed lifecycle, not its source spelling. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHomeUpdatesLifecycle } from "../hub-home-updates.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const f = { context: null, loads: 0, mounts: [], states: [], roots: { compose: { replaceChildren() { this.text = ""; } }, feed: { replaceChildren() { this.text = ""; } } } };
  f.member = (id = "A", role = "member", workspaceId = "one") => ({ key: `${id}|${role}|${workspaceId}`, ctx: { member: { id, role }, workspaceId } });
  f.module = { mountUpdates({ compose, feed, ctx }) {
    compose.text = `draft:${ctx.member.id}`;
    feed.text = `private:${ctx.workspaceId}`;
    const h = { ctx, refreshes: 0, destroys: 0, opens: 0,
      refresh() { this.refreshes++; }, destroy() { this.destroys++; }, openComposer() { this.opens++; } };
    f.mounts.push(h);
    return h;
  } };
  f.load = async () => f.module;
  f.lifecycle = createHomeUpdatesLifecycle({
    getContext: () => f.context, getRoots: () => f.roots,
    loadModule: () => { f.loads++; return f.load(); },
    onState: (status) => f.states.push(status)
  });
  return f;
}

test("updates never import or mount without verified membership or both roots", async () => {
  const f = fixture();
  await f.lifecycle.sync({ active: true });
  f.context = f.member();
  f.roots.feed = null;
  await f.lifecycle.sync({ active: true });
  assert.equal(f.loads, 0);
  assert.equal(f.mounts.length, 0);
});

test("Home mounts once, explicitly refreshes, and keeps the draft on navigation", async () => {
  const f = fixture(); f.context = f.member();
  const h = await f.lifecycle.sync({ active: true });
  assert.equal(h.refreshes, 1);
  f.roots.compose.text = "unsaved report";
  await f.lifecycle.sync({ active: false });
  await f.lifecycle.sync({ active: true, refresh: true });
  assert.equal(f.loads, 1);
  assert.equal(f.mounts.length, 1);
  assert.equal(f.roots.compose.text, "unsaved report");
  assert.equal(h.refreshes, 2);
  assert.equal(await f.lifecycle.openComposer(), true);
  assert.equal(h.opens, 1);
});

for (const change of ["account", "role", "workspace"]) test(`${change} change destroys immediately, including while Home is hidden`, async () => {
  const f = fixture(); f.context = f.member();
  const h = await f.lifecycle.sync({ active: true });
  f.context = change === "account" ? f.member("B") : change === "role" ? f.member("A", "viewer") : f.member("A", "member", "two");
  const pending = f.lifecycle.sync({ active: false });
  assert.equal(h.destroys, 1);
  assert.equal(f.roots.compose.text, "");
  assert.equal(f.roots.feed.text, "");
  await pending;
  const replacement = await f.lifecycle.sync({ active: true });
  assert.equal(replacement.ctx, f.context.ctx);
});

test("sign-out clears private content even if module cleanup throws", async () => {
  const f = fixture(); f.context = f.member();
  const h = await f.lifecycle.sync({ active: true });
  h.destroy = () => { throw new Error("cleanup failed"); };
  f.context = null;
  f.lifecycle.destroy();
  assert.equal(f.roots.compose.text, "");
  assert.equal(f.roots.feed.text, "");
  assert.equal(await f.lifecycle.openComposer(), false);
});

test("an import finishing after sign-out cannot mount private content", async () => {
  const f = fixture(), load = deferred(); f.context = f.member(); f.load = () => load.promise;
  const pending = f.lifecycle.sync({ active: true });
  await Promise.resolve();
  f.context = null; f.lifecycle.destroy();
  load.resolve(f.module);
  assert.equal(await pending, null);
  assert.equal(f.mounts.length, 0);
});

test("old imports cannot clear or overwrite a new account's mounted content", async () => {
  const f = fixture(), old = deferred(); f.context = f.member(); f.load = () => old.promise;
  const pending = f.lifecycle.sync({ active: true });
  await Promise.resolve();
  f.context = f.member("B"); f.load = async () => f.module;
  await f.lifecycle.sync({ active: true });
  old.reject(new Error("old import failed"));
  await pending;
  assert.equal(f.roots.feed.text, "private:one");
  assert.equal(f.roots.compose.text, "draft:B");
  assert.equal(f.states.at(-1), "ready");
});

test("failed import has a visible state and can retry without reloading the Hub", async () => {
  const f = fixture(); f.context = f.member(); f.load = async () => { throw new Error("network"); };
  assert.equal(await f.lifecycle.sync({ active: true }), null);
  assert.equal(f.states.at(-1), "error");
  f.load = async () => f.module;
  assert.ok(await f.lifecycle.sync({ active: true }));
  assert.equal(f.states.at(-1), "ready");
});

test("viewer gets the feed but never opens a composer", async () => {
  const f = fixture(); f.context = f.member("A", "viewer");
  const h = await f.lifecycle.sync({ active: true });
  assert.equal(h.refreshes, 1);
  assert.equal(await f.lifecycle.openComposer(), false);
  assert.equal(h.opens, 0);
});

test("a mounted module's failed refresh clears the shell error after a successful retry", async () => {
  const f = fixture(); f.context = f.member();
  const h = await f.lifecycle.sync({ active: true });
  h.refresh = async () => { throw new Error("offline"); };
  await f.lifecycle.sync({ active: true, refresh: true });
  assert.equal(f.states.at(-1), "error");
  h.refresh = async () => {};
  await f.lifecycle.sync({ active: true, refresh: true });
  assert.equal(f.states.at(-1), "ready");
  assert.equal(f.mounts.length, 1, "retry does not replace the existing draft");
});

test("duplicate refresh requests share one in-flight request and late failure is ignored", async () => {
  const f = fixture(); f.context = f.member();
  const h = await f.lifecycle.sync({ active: true }), read = deferred();
  h.refresh = () => { h.refreshes++; return read.promise; };
  const first = f.lifecycle.sync({ active: true, refresh: true });
  const second = f.lifecycle.sync({ active: true, refresh: true });
  await Promise.resolve();
  assert.equal(h.refreshes, 2);
  f.context = null; f.lifecycle.destroy();
  read.reject(new Error("old request"));
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(f.states.at(-1), "idle");
});
