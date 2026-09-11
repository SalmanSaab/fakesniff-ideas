/* The public board must show what exists and write nothing.
 *
 * Until now it could edit an idea's status and risk, create ideas, mark triggers
 * used and append to activity — all with the anon key, which ships in the page
 * source. There is no sign-in on this page and never has been, so the database
 * cannot distinguish the four of us from anyone else on the internet. Salman,
 * 11 Sep: only the four of us should edit, and anyone else doing so is a breach.
 * That cannot be enforced here, so the writes move to the Hub, where accounts
 * and row-level security exist.
 *
 * This runs the real page in a fake DOM with a fetch that records every request
 * and rejects any non-GET, so a write attempt fails the test rather than
 * quietly reaching production.
 *
 *   node test-display-only.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

/* ---------------------------------------------------- static guarantees */

check("no write verb reaches the database layer", () => {
  /* Both quote styles. Codex, 11 Sep: a dormant helper written as method:'POST'
     passed this check while the identical double-quoted literal failed it.
     This is still a text search and cannot see a verb built at runtime — the
     recorded-fetch assertions below are what cover that. */
  const writes = [...html.matchAll(/method\s*:\s*["'`](POST|PATCH|PUT|DELETE)["'`]/g)].map((m) => m[1]);
  assert.deepEqual(writes, [], `the page still issues: ${writes.join(", ")}`);
});

check("the functions that wrote are gone, not just unreferenced", () => {
  for (const name of ["function newIdea", "async function update", "async function log"]) {
    assert.ok(!html.includes(name), `${name} is still defined`);
  }
});

check("nothing references the removed controls", () => {
  for (const sym of ['getElementById("add")', "newIdea(", 'id="setstatus"', 'id="setrisk"', "data-mk"]) {
    assert.ok(!html.includes(sym), `dangling reference: ${sym}`);
  }
});

check("status and risk are inert elements", () => {
  assert.match(html, /class="setline readonly"/, "the read-only status row is missing");
  const setlineButtons = html.match(/setline[^>]*>\s*\$\{[^}]*<button/g) || [];
  assert.deepEqual(setlineButtons, [], "a status or risk row still renders buttons");
});

/* CONTROL: passes against the original. A removal that took these with it would
   be a worse outcome than the bug. */
check("browsing, search and copy survive", () => {
  for (const [sym, what] of [["copyForAI", "copy for AI"], ["tsearch", "trigger search"],
                             ["renderTriggers", "trigger list"], ["showHow", "how this works"],
                             ["drawShirt", "shirt preview"]]) {
    assert.ok(html.includes(sym), `${what} was removed`);
  }
});

check("the Hub is offered for the things this page no longer does", () => {
  assert.match(html, /fakesniff-hub\/hub\.html#ideas/, "no link to the Hub's Idea Lab");
  assert.match(html, /class="hublink"/, "the Hub link has no styling hook");
});

/* ------------------------------------------------- behaviour, in a fake DOM */

const requests = [];

function el(tag = "div") {
  const node = {
    tagName: tag, innerHTML: "", textContent: "", value: "", dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => el(), querySelectorAll: () => [],
    getContext: () => ({
      fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }),
      drawImage() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      save() {}, restore() {}, translate() {}, scale() {}, clearRect() {},
      set fillStyle(_v) {}, set font(_v) {}, set textAlign(_v) {},
    }),
    width: 300, height: 300,
    focus() {}, remove() {}, closest: () => null,
    onclick: null, onsubmit: null, oninput: null,
  };
  return node;
}

const registry = new Map();
globalThis.window = globalThis;
globalThis.document = {
  getElementById: (id) => { if (!registry.has(id)) registry.set(id, el()); return registry.get(id); },
  querySelector: () => el(),
  querySelectorAll: () => [],
  createElement: (t) => el(t),
  addEventListener() {},
  documentElement: { lang: "", dir: "", style: {} },
  body: { classList: { add() {}, remove() {} }, appendChild() {} },
  head: { appendChild() {} },
};
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
};
try {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true,
  });
} catch { /* Node 24 exposes navigator read-only; the clipboard path is not under test */ }
globalThis.location = { reload() {}, href: "" };
/* The shirt preview draws to a canvas and preloads an image. Neither is under
   test; they only need to exist so the module reaches its first fetch. */
globalThis.Image = class { set src(_v) {} addEventListener() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.setInterval = () => 0;          // the board polls every 30s; not here

/* Two ideas and one trigger, shaped like the real tables. */
const IDEAS = [
  { id: 1, line: "NOTHING IS REAL", concept: "(a statement)", category: "statement",
    risk: "clean", status: "new", added_by: "Salman", updated_by: null,
    sparked_by: "", source_url: "", created_at: "2026-09-01T10:00:00Z" },
  { id: 2, line: "I WALK THE LINE", concept: "", category: "statement",
    risk: "check", status: "shortlist", added_by: "Emiel", updated_by: "Marco",
    sparked_by: "", source_url: "", created_at: "2026-09-02T10:00:00Z",
    trigger_id: 9 },                       // the Hub's way of recording the link
];
const TRIGGERS = [
  /* Linked from the Hub, flag never set — the case that would read as unused. */
  { id: 9, title: "a headline", source: "somewhere", url: "https://example.test",
    category: "statement", used: false, created_at: "2026-09-03T10:00:00Z" },
  /* Legacy: flagged by the old board, no idea points at it. */
  { id: 10, title: "an older headline", source: "somewhere", url: "",
    category: "statement", used: true, created_at: "2026-08-03T10:00:00Z" },
  /* Genuinely untouched. */
  { id: 11, title: "a fresh headline", source: "somewhere", url: "",
    category: "statement", used: false, created_at: "2026-09-04T10:00:00Z" },
];

globalThis.fetch = async (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  requests.push({ url: String(url), method });
  if (method !== "GET") {
    /* A denial, the way the database will answer once anon loses write access. */
    return { ok: false, status: 401, text: async () => "permission denied" };
  }
  const body = String(url).includes("/triggers") ? TRIGGERS
             : String(url).includes("/ideas") ? IDEAS
             : [];
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const open = html.indexOf("<script");
const scriptStart = html.indexOf(">", open) + 1;
const script = html.slice(scriptStart, html.lastIndexOf("</script>"));
if (open === -1 || !script.trim()) { console.log("  FAIL  could not extract the page script"); process.exit(1); }
globalThis.localStorage.setItem("fs_who", "Salman");   // past the who-are-you gate
let pageError = null;
try {
  await import("data:text/javascript," + encodeURIComponent(script));
} catch (e) {
  pageError = e;
}
await new Promise((r) => setTimeout(r, 60));

/* CONTROL: passes against the original too. It must keep passing — the point of
   the change is that browsing still works. */
check("the board read the ideas and triggers it displays", () => {
  const gets = requests.filter((r) => r.method === "GET");
  assert.ok(gets.some((r) => r.url.includes("/ideas")), "it never fetched ideas");
  assert.ok(gets.some((r) => r.url.includes("/triggers")), "it never fetched triggers");
});

/* CONTROL, and weaker than it looks: the original board also writes nothing on
   load, because its writes only fired on a click or a form submit. This catches
   a write during startup and nothing else. The static checks above are what
   actually establish that the write paths are gone. Kept because a write
   appearing at load time would be a real regression. */
check("it issued no write of any kind", () => {
  const writes = requests.filter((r) => r.method !== "GET");
  assert.deepEqual(writes, [],
    `the board attempted: ${writes.map((w) => `${w.method} ${w.url}`).join(", ")}`);
});

/* Fetching is not showing. This is the one behavioural check that the board
   still does its job after the removal. */
/* Codex, 11 Sep: this file used to print a startup exception as a NOTE and carry
   on. A candidate with a deliberate throw after startup still scored 9 passes and
   exit 0 — the page was broken and the suite said it was fine. An exception is a
   failure. */
check("the page ran without throwing", () => {
  assert.equal(pageError, null,
    `the page threw during startup: ${pageError && pageError.message}`);
});

check("the fetched ideas actually reach the page", () => {
  const painted = [...registry.values()].map((n) => n.innerHTML).join("");
  assert.ok(painted.includes("NOTHING IS REAL"),
    "an idea was fetched but never rendered; the board would look empty");
  assert.ok(painted.includes("I WALK THE LINE"), "the second idea never rendered");
});

/* Codex, 11 Sep: the Hub records the link as ideas.trigger_id and never sets
   triggers.used. With creation moved there, material somebody already used would
   keep showing as available here. Both branches are exercised: trigger 9 is
   linked with the flag false, trigger 10 carries the legacy flag with no link,
   trigger 11 is neither. */
check("material used from the Hub stops being offered as available", () => {
  /* The board opens on "not used", so this is the view that matters: if the
     predicate still read triggers.used alone, trigger 9 — linked from the Hub
     with the flag never set — would sit here as free material. */
  const shown = (registry.get("triggers") || { innerHTML: "" }).innerHTML;
  assert.ok(shown, "the trigger list never rendered");
  assert.ok(!shown.includes("a headline"),
    "a trigger linked from the Hub is still offered as not used");
  assert.ok(!shown.includes("an older headline"),
    "a trigger with the legacy used flag is still offered as not used");
  assert.ok(shown.includes("a fresh headline"),
    "an untouched trigger vanished from the list");

  const count = registry.get("c-trig");
  assert.equal(String(count && count.textContent), "1",
    `the "not used" count is ${count && count.textContent}; only trigger 11 is free`);
});

console.log(`\n  ${requests.length} requests, ` +
  `${requests.filter((r) => r.method === "GET").length} GET, ` +
  `${requests.filter((r) => r.method !== "GET").length} write\n`);

process.exit(failures ? 1 : 0);
