/* Two mistakes I made translating Decisions, now caught automatically:
   calling t() with a key nobody defined, and leaving raw English behind in a
   module that is supposed to be translated. Both render as something wrong on
   Marco's screen and neither shows up as a crash. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import en from "../lang/en.js";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/* Codex — 2026-08-30: Work's policy and repository now share this guard. Home
   and Work copy inside hub.js has a section-aware guard in its own test; the
   same file still contains shell/auth copy covered outside this module scan. */
const TRANSLATED = [
  "hub-decisions.js",
  "hub-lookbook.js",
  "hub-designs.js",
  "hub-idea-lab.js",
  "hub-work-policy.js",
  "hub-work-repository.js"
];

const read = (f) => fs.readFileSync(path.join(webRoot, f), "utf8");
const keysUsedIn = (src) =>
  [...src.matchAll(/\bt\(\s*"([a-z]+\.[a-z0-9_]+)"/g)].map((m) => m[1]);

test("every key a module asks for exists in english", () => {
  for (const file of TRANSLATED) {
    for (const key of keysUsedIn(read(file))) {
      assert.ok(key in en, `${file} calls t("${key}") but english has no such key`);
    }
  }
});

test("placeholder names in a key match what the caller passes", () => {
  for (const file of TRANSLATED) {
    const src = read(file);
    for (const m of src.matchAll(/\bt\(\s*"([a-z]+\.[a-z0-9_]+)"\s*,\s*\{([^}]*)\}/g)) {
      const [, key, argsRaw] = m;
      if (!(key in en)) continue;
      const wanted = new Set([...en[key].matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
      const given = new Set([...argsRaw.matchAll(/(\w+)\s*:/g)].map((x) => x[1]));
      for (const name of wanted) {
        assert.ok(given.has(name),
          `${file}: t("${key}") needs {${name}} but the call does not pass it`);
      }
    }
  }
});

test("a translated module has no english sentences left in it", () => {
  /* Anything long enough to be a sentence, in a string, that is not a key,
     a header value or part of a URL. Comments are stripped first — they are
     for us, not for Marco. */
  const allowed = /^(Content-Type|Bearer |application\/json|return=|count=|POST|PATCH|GET)/;
  for (const file of TRANSLATED) {
    const src = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const leftovers = [...src.matchAll(/"([A-Z][a-z]+(?: [a-z]+){3,}[^"]*)"/g)]
      .map((m) => m[1])
      .filter((v) => !allowed.test(v));
    assert.deepEqual(leftovers, [],
      `${file} still has untranslated English: ${leftovers.join(" | ")}`);
  }
});
