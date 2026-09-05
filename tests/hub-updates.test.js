/* The daily update — the boundary that decides whether Marco reads a sentence
 * or reads `work_updates_not_empty`.
 *
 * Codex required an unexpected database error to be covered as well as the two
 * named constraints, and that is the case that matters most: the two we named
 * are the two we already thought of. The one that reaches Marco will be a third.
 *
 * humanUpdateError is importable with no DOM and no network on purpose, so this
 * file needs neither. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addTranslations } from "../hub-i18n.js";
import { humanUpdateError } from "../hub-updates.js";
import en from "../lang/en.js";
import nl from "../lang/nl.js";

/* hub-updates.js deliberately registers nothing on import — Codex asked for a
   module with no import-time side effects. hub.js supplies the dictionaries in
   the browser; here the test supplies them, the same way the Home/Work i18n
   test does. Without this t() returns the key and every assertion below is
   quietly meaningless rather than failing. */
addTranslations("en", en);
addTranslations("nl", nl);

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = fs.readFileSync(
  path.join(webRoot, "migrations", "20260905_007_work_updates.sql"), "utf8",
);
const moduleSrc = fs.readFileSync(path.join(webRoot, "hub-updates.js"), "utf8");

/* Anything that would tell a person the database exists. */
const LEAKS = [
  /constraint/i, /violates/i, /relation/i, /row-level/i, /pgrst/i,
  /sqlstate/i, /work_updates/i, /null value/i, /column/i, /42501/,
];

function assertSafe(sentence, from) {
  assert.equal(typeof sentence, "string", `${from} produced no sentence`);
  assert.ok(sentence.trim().length > 0, `${from} produced an empty sentence`);
  for (const leak of LEAKS) {
    assert.ok(!leak.test(sentence), `${from} leaked ${leak} in: ${sentence}`);
  }
}

test("the two named constraints become sentences, not names", () => {
  const empty = humanUpdateError(
    new Error('new row for relation "work_updates" violates check constraint "work_updates_not_empty"'),
  );
  assertSafe(empty, "work_updates_not_empty");
  assert.equal(empty, en["updates.err_empty"]);

  const long = humanUpdateError(
    new Error('new row for relation "work_updates" violates check constraint "work_updates_length"'),
  );
  assertSafe(long, "work_updates_length");
  assert.equal(long, en["updates.err_long"]);
});

test("a permission failure explains access rather than policies", () => {
  for (const raw of [
    'new row violates row-level security policy for table "work_updates"',
    "permission denied for table work_updates",
    "42501",
  ]) {
    assertSafe(humanUpdateError(new Error(raw)), raw);
  }
});

test("a network failure says nothing was lost", () => {
  for (const raw of ["Failed to fetch", "NetworkError when attempting to fetch resource", "Load failed"]) {
    const sentence = humanUpdateError(new Error(raw));
    assertSafe(sentence, raw);
    assert.equal(sentence, en["updates.err_network"]);
  }
});

/* The case Codex asked for, and the one that will actually happen. */
test("an unforeseen database error still returns a plain sentence and drops the raw text", () => {
  for (const raw of [
    'insert or update on table "work_updates" violates foreign key constraint "work_updates_author_id_fkey"',
    "could not serialize access due to concurrent update",
    "PGRST204: column work_updates.mood does not exist in the schema cache",
    'null value in column "workspace_id" of relation "work_updates" violates not-null constraint',
    "deadlock detected",
    "SQLSTATE 23514",
    "\u0000\u0001 garbage",
    "",
  ]) {
    const sentence = humanUpdateError(new Error(raw));
    assertSafe(sentence, `unforeseen: ${raw}`);
    assert.ok(
      !sentence.includes(raw) || raw === "",
      `raw server text was passed through: ${raw}`,
    );
  }
});

test("undefined, null and non-error values do not crash the boundary", () => {
  for (const raw of [undefined, null, 0, {}, [], "plain string"]) {
    assertSafe(humanUpdateError(raw), `value ${JSON.stringify(raw)}`);
  }
});

/* ------------------------------------------------------------------- copy */

/* Dutch genuinely uses these words. Listing them by name rather than relaxing
   the rule, so a sentence that never got translated still fails. */
const SAME_IN_DUTCH = new Set(["updates.open"]);

test("every updates key exists in both languages", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("updates."));
  assert.ok(keys.length >= 18, `expected the full updates namespace, found ${keys.length}`);
  for (const key of keys) {
    assert.ok(nl[key], `nl is missing ${key}`);
    if (SAME_IN_DUTCH.has(key)) continue;
    assert.notEqual(nl[key], en[key], `${key} is still English in nl`);
  }
});

/* ---------------------------------------------------------------- schema */

test("the migration does not depend on migration 006", () => {
  assert.ok(!/home_changes|006/i.test(sql.replace(/^--.*$/gm, "")),
    "007 references 006 outside its comments");
});

test("write grants are column level, so metadata stays server owned", () => {
  assert.ok(/grant insert \(id, workspace_id, done, open, next\)/i.test(sql),
    "insert grant is not column scoped");
  assert.ok(/grant update \(done, open, next\)/i.test(sql),
    "update grant is not column scoped");
  /* The failure this guards against is a whole-table grant creeping back in
     beside the column grants, which silently re-opens created_at, reported_on,
     edited_at and archived_at to the caller. */
  assert.ok(!/grant\s+(insert|update)\s+on\s+table\s+public\.work_updates/i.test(sql),
    "a whole-table write grant is present alongside the column grants");
});

test("the blank check rejects whitespace, not only empty strings", () => {
  /* trim(x) = '' removes spaces and nothing else, so a report of newlines or
     tabs would have passed. Codex caught this in review. */
  assert.ok(/check \(done ~ '\\S' or open ~ '\\S' or next ~ '\\S'\)/.test(sql),
    "work_updates_not_empty is not whitespace aware");
  assert.ok(!/trim\(done\)\s*=\s*''/.test(sql), "the old space-only check is back");
});

test("reports are not copied into the activity feed", () => {
  assert.ok(!/audit_row_change/.test(sql.replace(/^--.*$/gm, "")),
    "audit_row_change is attached; every report would be duplicated into activity_events");
});

test("there is no delete policy", () => {
  assert.ok(!/for delete/i.test(sql), "a delete policy exists; deletion is not in this release");
});

/* -------------------------------------------------------------- lifecycle */

test("importing the module has no side effects", () => {
  /* Codex requires no boot-time DOM lookup, fetch or self-mount on import.
     The proof is this file: it imports hub-updates.js at the top, in Node,
     where there is no document. If the module touched the DOM while loading,
     every test here would already have failed at import rather than at this
     assertion. So the check is that the environment really is DOM-less and the
     import really did succeed. */
  assert.equal(typeof globalThis.document, "undefined",
    "this test proves nothing if the environment has a document");
  assert.equal(typeof humanUpdateError, "function", "the module did not import cleanly");

  /* And the stylesheet goes in on mount rather than on load. */
  const mountAt = moduleSrc.indexOf("export function mountUpdates");
  assert.ok(mountAt > 0, "mountUpdates is not exported");
  assert.ok(moduleSrc.indexOf("ensureStyles()") > mountAt,
    "ensureStyles runs at module scope instead of inside mount");
});

test("destroy aborts in-flight requests before clearing", () => {
  const destroy = moduleSrc.slice(moduleSrc.indexOf("destroy()"));
  assert.ok(/alive = false/.test(destroy), "destroy does not mark the instance dead");
  assert.ok(/\.abort\(\)/.test(destroy), "destroy does not abort outstanding requests");
  assert.ok(/stopListening\(\)/.test(destroy), "destroy leaves the language listener attached");
  assert.ok(destroy.indexOf(".abort()") < destroy.indexOf('compose.textContent = ""'),
    "containers are cleared before requests are aborted, so a late response can repaint them");
});

test("a missing container mounts nothing and requests nothing", () => {
  assert.ok(/if \(!compose \|\| !feed \|\| !ctx\) return inertHandle\(\)/.test(moduleSrc),
    "mount does not short circuit when a container is absent");
});

test("user text is never written as markup", () => {
  const body = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/innerHTML/.test(body), "the module writes innerHTML somewhere");
});
