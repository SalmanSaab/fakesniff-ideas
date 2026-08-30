/* Codex — 2026-08-30: Home/Work translation coverage. These checks protect
   Marco's everyday path and the database-error boundary in both languages. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addTranslations, setLanguage, t } from "../hub-i18n.js";
import en from "../lang/en.js";
import nl from "../lang/nl.js";
import { translateWorkRepositoryError, validateWorkValues } from "../hub-work-policy.js";

const html = await readFile(new URL("../hub.html", import.meta.url), "utf8");
const hubSource = await readFile(new URL("../hub.js", import.meta.url), "utf8");
const policySource = await readFile(new URL("../hub-work-policy.js", import.meta.url), "utf8");

addTranslations("en", en);
addTranslations("nl", nl);

const originalDocument = globalThis.document;
globalThis.document = {
  documentElement: {},
  querySelectorAll() { return []; }
};

test.after(() => {
  setLanguage("en");
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

test("every Home and Work markup key exists in English and Dutch", () => {
  const start = html.indexOf('<section id="home"');
  const end = html.indexOf('<section id="idea-lab"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const ownedMarkup = html.slice(start, end);
  const keys = [...ownedMarkup.matchAll(/data-t(?:-placeholder|-aria|-title)?="((?:home|work)\.[a-z0-9_]+)"/g)]
    .map((match) => match[1]);
  assert.ok(keys.length > 50, "expected translated Home/Work markup");
  for (const key of keys) {
    assert.ok(key in en, `${key} is missing from English`);
    assert.ok(key in nl, `${key} is missing from Dutch`);
  }
  assert.match(ownedMarkup, /id="home-title"[^>]*>[\s\S]*<br><em data-t="home\.hero_emphasis"/);
});

test("every literal Home and Work runtime key exists in both dictionaries", () => {
  const sources = `${hubSource}\n${policySource}`;
  const keys = new Set([...sources.matchAll(/["`]((?:home|work)\.[a-z0-9_]+)["`]/g)].map((match) => match[1]));
  assert.ok(keys.size > 100, "expected generated Home/Work copy to use translation keys");
  for (const key of keys) {
    if (!(key in en) && sources.includes(`pluralKey("${key}"`)) {
      for (const suffix of ["one", "other"]) {
        assert.ok(`${key}_${suffix}` in en, `${key}_${suffix} is missing from English`);
        assert.ok(`${key}_${suffix}` in nl, `${key}_${suffix} is missing from Dutch`);
      }
      continue;
    }
    assert.ok(key in en, `${key} is missing from English`);
    assert.ok(key in nl, `${key} is missing from Dutch`);
  }
});

test("Work validation and repository failures are useful Dutch without database language", () => {
  setLanguage("nl");
  const validation = validateWorkValues({
    title: "Voorbeeld",
    status: "this_week",
    ownerId: "",
    approverId: "",
    dueOn: "",
    nextAction: "",
    completion: "",
    blocker: "",
    sourceUrl: "",
    latestFileUrl: ""
  });
  assert.equal(validation.message, "Kies een eigenaar voordat je dit naar Deze week verplaatst.");

  const cases = [
    { serverMessage: "violates check constraint tasks_waiting_has_reason", code: "23514" },
    { serverMessage: "relation decisions_private vanished; row-level policy", code: "XX999" },
    { serverMessage: "tasks_one_doing_per_owner_active_uidx", code: "23505" }
  ];
  const forbidden = /constraint|violates|relation|row-level|tasks_[a-z_]+|decisions_[a-z_]+/i;
  for (const error of cases) {
    const result = translateWorkRepositoryError(error, {});
    assert.ok(result.message.length > 20);
    assert.doesNotMatch(result.message, forbidden);
    assert.doesNotMatch(result.message, new RegExp(error.serverMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  setLanguage("en");
});

test("Home and Work dates and counts follow the active locale", () => {
  assert.match(hubSource, /nl: "nl-NL"/);
  assert.doesNotMatch(hubSource, /new Intl\.DateTimeFormat\("en-GB"/);
  assert.match(hubSource, /new Intl\.DateTimeFormat\(hubLocale\(\), \{\s*weekday:/);
  assert.match(hubSource, /new Intl\.NumberFormat\(hubLocale\(\)/);
  const date = new Date("2026-08-13T00:00:00");
  assert.equal(new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short" }).format(date), "Thursday 13 Aug");
  assert.equal(new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "short" }).format(date), "donderdag 13 aug");
  assert.equal(new Intl.NumberFormat("nl-NL").format(1234), "1.234");
});

test("a language change rerenders without losing the open Work draft or inline error", () => {
  const start = hubSource.indexOf("function renderOwnedLanguageChange");
  const end = hubSource.indexOf("function bindEvents", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = hubSource.slice(start, end);
  assert.match(source, /const draft = dialog\.open \? valuesFromForm\(\) : null/);
  assert.match(source, /applyValuesToForm\(draft\)/);
  assert.match(source, /syncRequirements\(\{ clearError: false \}\)/);
  assert.match(source, /retranslateFormError\(\)/);
  assert.doesNotMatch(source, /loadWorkspace|refreshTasks|clearFormError/);
  assert.equal(t("work.guidance_doing"), en["work.guidance_doing"]);
});
