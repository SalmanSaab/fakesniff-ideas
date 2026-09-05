/* Codex — regressions from the 5 September second read.
 * Run against the integrated module by default. Before Claude's files are
 * integrated, HUB_UPDATES_MODULE may point to their file: URL for read-only
 * verification; dictionaries and i18n come from that same module directory. */
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDocument, deferred, response, settle } from "../helpers/updates-dom.js";

const moduleUrl = new URL(process.env.HUB_UPDATES_MODULE || "../../hub-updates.js", import.meta.url);
const { mountUpdates } = await import(moduleUrl.href);
const { addTranslations } = await import(new URL("./hub-i18n.js", moduleUrl).href);
const { default: en } = await import(new URL("./lang/en.js", moduleUrl).href);
addTranslations("en", en);

const member = { id: "11111111-1111-4111-8111-111111111111", role: "member" };
const workspaceId = "22222222-2222-4222-8222-222222222222";
const existing = {
  id: "33333333-3333-4333-8333-333333333333",
  author_id: member.id,
  done: "An existing report",
  open: "",
  next: "",
  reported_on: "2026-09-05",
  created_at: "2026-09-05T12:00:00Z",
  updated_at: "2026-09-05T12:00:00Z",
  edited_at: null,
};

function mount(t, fetchImpl, role = "member") {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousFetch = globalThis.fetch;
  const document = createTestDocument();
  globalThis.document = document;
  globalThis.fetch = fetchImpl;
  const compose = document.createElement("div");
  const feed = document.createElement("div");
  document.body.append(compose, feed);
  const handle = mountUpdates({
    compose,
    feed,
    ctx: {
      restUrl: "https://example.invalid/rest/v1",
      anonKey: "public-test-key",
      workspaceId,
      member: { ...member, role },
      getAccessToken: async () => "test-session",
    },
  });
  t.after(() => {
    handle.destroy();
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  return { handle, compose, feed };
}

function field(ui, name = "done") {
  const element = ui.compose.querySelector(`textarea[name="${name}"]`);
  assert.ok(element, `the ${name} field is available`);
  return element;
}

function type(ui, value, name = "done") {
  const element = field(ui, name);
  assert.ok(!element.isDisabled(), `the ${name} field accepts input`);
  element.value = value;
  element.dispatch("input");
}

function submit(ui) {
  const button = ui.compose.querySelector('button[type="submit"]');
  assert.ok(button, "the composer has a submit button");
  assert.ok(!button.isDisabled(), "the submit button is available");
  button.click();
}

function namedButton(root, text) {
  return root.querySelectorAll("button").find((button) => button.textContent === text);
}

function alerts(ui) {
  return [...ui.compose.querySelectorAll('[role="alert"]'), ...ui.feed.querySelectorAll('[role="alert"]')];
}

function members() {
  return response([{ user_id: member.id, display_name: "Salman" }]);
}

for (const initial of [true, false]) {
  test(`${initial ? "initial loading" : "refreshing an existing feed"} preserves text typed while the request is pending`, async (t) => {
    const delayed = deferred();
    let delayReads = initial;
    const ui = mount(t, async (url) => {
      if (String(url).includes("/members")) return members();
      return delayReads ? delayed.promise : response([existing]);
    });
    if (!initial) {
      await ui.handle.refresh();
      delayReads = true;
    }
    const refreshing = ui.handle.refresh();
    type(ui, "Photographed the new shirts; still selecting the best shot.");
    delayed.resolve(response([existing]));
    await refreshing;
    assert.equal(field(ui).value, "Photographed the new shirts; still selecting the best shot.");
    assert.ok(ui.feed.textContent.includes(existing.done), "the feed still refreshes");
  });
}

test("a viewer sees a failed read as an error, then a successful empty read as empty", async (t) => {
  let offline = true;
  const ui = mount(t, async (url) => {
    if (offline) throw new Error("Failed to fetch");
    return String(url).includes("/members") ? members() : response([]);
  }, "viewer");
  await ui.handle.refresh();
  assert.equal(ui.compose.querySelector("form"), null, "read access does not grant a posting form");
  assert.ok(alerts(ui).some((element) => element.textContent.trim()), "the failed feed is visibly announced");
  assert.ok(!ui.feed.textContent.includes(en["updates.empty"]), "failed loading must not claim nobody posted");
  offline = false;
  await ui.handle.refresh();
  assert.equal(alerts(ui).length, 0, "successful retry clears the failure");
  assert.ok(ui.feed.textContent.includes(en["updates.empty"]), "a verified empty feed is described as empty");
});

test("an uncertain POST retry never clears changed text unless that text was stored", async (t) => {
  const stored = new Map();
  let attempts = 0;
  const ui = mount(t, async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (options.method === "POST") {
      attempts += 1;
      const report = JSON.parse(options.body);
      if (stored.has(report.id)) {
        return response({ code: "23505", message: 'duplicate key value violates unique constraint "work_updates_pkey"' }, 409);
      }
      stored.set(report.id, { ...existing, ...report });
      if (attempts === 1) throw new Error("Failed to fetch");
      return response(null, 201);
    }
    if (options.method === "PATCH") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const record = stored.get(id);
      if (!record) return response([]);
      Object.assign(record, JSON.parse(options.body));
      return response([record]);
    }
    if (url.pathname.endsWith("/members")) return members();
    const id = url.searchParams.get("id")?.replace(/^eq\./, "");
    return response([...stored.values()].filter((record) => !id || record.id === id));
  });
  type(ui, "Original report before the response was lost");
  submit(ui);
  await settle();
  assert.equal(stored.size, 1, "the first request reached the server");
  const correction = "Corrected report after the uncertain response";
  type(ui, correction);
  submit(ui);
  await settle();
  assert.equal(stored.size, 1, "retrying the same report must not create a duplicate");
  assert.ok(
    [...stored.values()].some((record) => record.done === correction) || field(ui).value === correction,
    "the changed text must either be saved or remain available in the composer",
  );
});

test("a delayed correction cannot erase a new draft opened while it is saving", async (t) => {
  const delayed = deferred();
  let patchStarted = false;
  const ui = mount(t, async (url, options = {}) => {
    if (options.method === "PATCH") { patchStarted = true; return delayed.promise; }
    return String(url).includes("/members") ? members() : response([existing]);
  });
  await ui.handle.refresh();
  const edit = namedButton(ui.feed, en["updates.correct"]);
  assert.ok(edit, "the author can correct their report");
  edit.click();
  type(ui, "Correction being saved");
  submit(ui);
  await settle();
  assert.ok(patchStarted, "the correction is pending");

  const cancel = namedButton(ui.compose, en["common.cancel"]);
  let freshDraft = false;
  // Two valid designs: freeze cancellation until saving finishes, or allow a
  // new draft and ensure the old completion cannot clear it.
  if (cancel && !cancel.isDisabled()) {
    cancel.click();
    const area = field(ui);
    if (!area.isDisabled()) {
      type(ui, "New report typed after cancelling the pending correction");
      freshDraft = true;
    }
  }
  delayed.resolve(response([{ ...existing, done: "Correction being saved" }]));
  await settle();
  if (freshDraft) {
    assert.equal(field(ui).value, "New report typed after cancelling the pending correction");
  } else {
    assert.ok(!field(ui).isDisabled(), "the composer becomes usable after saving finishes");
  }
});

test("an older failed refresh cannot replace the result of a newer successful refresh", async (t) => {
  const older = deferred();
  let reads = 0;
  const ui = mount(t, async (url) => {
    if (String(url).includes("/members")) return members();
    reads += 1;
    return reads === 1 ? older.promise : response([existing]);
  });
  const first = ui.handle.refresh();
  await settle();
  await ui.handle.refresh();
  assert.ok(ui.feed.textContent.includes(existing.done), "the newer report is already visible");
  older.reject(new Error("Failed to fetch"));
  await first;
  assert.equal(alerts(ui).length, 0, "the obsolete request cannot add an error to a successful refresh");
  assert.ok(ui.feed.textContent.includes(existing.done), "the newer report remains visible");
});
