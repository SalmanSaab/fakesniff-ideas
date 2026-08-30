/* Guards the two ways a translated interface rots:
   a key on screen because nobody wrote English for it, and a language
   silently falling behind English without anyone noticing. */
import test from "node:test";
import assert from "node:assert/strict";
import en from "../lang/en.js";
import nl from "../lang/nl.js";

const LANGUAGES = { nl };

test("english is complete and has no empty strings", () => {
  const keys = Object.keys(en);
  assert.ok(keys.length > 0, "english dictionary is empty");
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, "string", `${key} is not a string`);
    assert.ok(value.trim().length > 0, `${key} is empty`);
  }
});

test("every key is namespaced, so ownership of a screen is obvious", () => {
  for (const key of Object.keys(en)) {
    assert.match(key, /^[a-z]+\.[a-z0-9_]+$/, `${key} is not namespaced as module.key`);
  }
});

test("no translation invents a key english does not have", () => {
  for (const [code, dict] of Object.entries(LANGUAGES)) {
    for (const key of Object.keys(dict)) {
      assert.ok(key in en, `${code} has "${key}" which english does not`);
    }
  }
});

test("placeholders survive translation", () => {
  const vars = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(",");
  for (const [code, dict] of Object.entries(LANGUAGES)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(vars(value), vars(en[key]),
        `${code}.${key} does not use the same {placeholders} as english`);
    }
  }
});

test("dutch is complete — this fails loudly when english gains a key", () => {
  const missing = Object.keys(en).filter((k) => nl[k] === undefined);
  assert.deepEqual(missing, [],
    `dutch is missing ${missing.length} key(s). Marco reads this interface; ` +
    `an untranslated string is a screen he cannot use.`);
});
