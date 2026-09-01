/* Codex — 2026-08-30: Home/Work translation coverage. These checks protect
   Marco's everyday path and the database-error boundary in both languages. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addTranslations, setLanguage, t } from "../hub-i18n.js";
import en from "../lang/en.js";
import nl from "../lang/nl.js";
import { translateWorkRepositoryError, validateWorkValues, workStatusLabel } from "../hub-work-policy.js";

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

test.afterEach(() => setLanguage("en"));

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

test("the Work board count is truthful in English and Dutch", () => {
  setLanguage("en");
  assert.equal(t("work.nav_items_one", { n: "1" }), "1 work item on the board");
  assert.equal(t("work.nav_items_other", { n: "2" }), "2 work items on the board");
  setLanguage("nl");
  assert.equal(t("work.nav_items_one", { n: "1" }), "1 werkitem op het bord");
  assert.equal(t("work.nav_items_other", { n: "2" }), "2 werkitems op het bord");
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
  assert.equal(validation.message, "Kies wie dit oppakt voordat je het naar Deze week verplaatst.");

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

test("every Work recovery sentence is complete, Dutch, and action-led", () => {
  /* Codex — 2026-08-30: these are the sentences Marco sees when confidence is
     lowest, so this protects tone as well as translation completeness. */
  const errorKeys = Object.keys(en).filter((key) => key.startsWith("work.error_"));
  const databaseLanguage = /constraint|violates?|relation|row-level|postgres|sqlstate|pgrst|tasks_[a-z0-9_]+/i;
  const strayEnglish = /\b(?:choose|refresh|save|owner|approver|reviewer|workspace|could not|try again)\b/i;
  assert.ok(errorKeys.length >= 45, "expected the complete Work recovery dictionary");
  for (const key of errorKeys) {
    assert.ok(key in nl, `${key} is missing from Dutch`);
    assert.notEqual(nl[key], en[key], `${key} was left in English`);
    assert.match(nl[key], /[.!?]$/, `${key} is not a complete sentence`);
    assert.doesNotMatch(nl[key], databaseLanguage, `${key} contains database language`);
    assert.doesNotMatch(nl[key], strayEnglish, `${key} contains English guidance`);
  }

  assert.equal(nl["work.error_owner_before_stage"], "Kies wie dit oppakt voordat je het naar {stage} verplaatst.");
  assert.equal(nl["work.error_inactive_reviewer_admin"], "De beoordelaar is niet meer actief. Vraag iemand die de Hub beheert om een andere beoordelaar te kiezen voordat je dit naar Beoordeling of Klaar verplaatst.");
  assert.equal(nl["work.error_active_details"], "Controleer wie dit oppakt, de deadline, de volgende stap en wanneer het Klaar is. Probeer daarna opnieuw op te slaan.");
  assert.equal(nl["work.error_legacy_rule"], "Dit oudere item kan zo niet worden opgeslagen. Vraag iemand die de Hub beheert om het bij te werken.");
  assert.equal(nl["work.error_save_unknown"], "Opslaan lukt nu niet. Controleer je verbinding, vernieuw de Hub en probeer het daarna nog eens.");
});

test("all known Work database failures keep their Dutch recovery boundary", () => {
  setLanguage("nl");
  const identifiers = [
    "tasks_title_length", "tasks_status_allowed", "tasks_priority_allowed",
    "tasks_position_nonnegative", "tasks_kind_allowed", "tasks_flags_allowed",
    "tasks_source_url_http", "tasks_latest_file_url_https", "tasks_waiting_has_reason",
    "tasks_review_has_separate_approver", "tasks_active_work_fields_present",
    "tasks_done_fields_present", "tasks_workstream_fk", "tasks_owner_fk",
    "tasks_approver_fk", "tasks_source_design_fk", "tasks_source_idea_fk"
  ];
  const forbidden = /constraint|violates?|relation|row-level|postgres|sqlstate|pgrst|tasks_[a-z0-9_]+/i;
  for (const identifier of identifiers) {
    const result = translateWorkRepositoryError({
      serverMessage: `new row for relation tasks violates constraint ${identifier}`,
      code: identifier.endsWith("_fk") ? "23503" : "23514"
    }, {});
    assert.match(result.message, /[.!?]$/, identifier);
    assert.doesNotMatch(result.message, forbidden, identifier);
  }
  setLanguage("en");
});

test("Work failure routing names the field and the recovery in Dutch", () => {
  setLanguage("nl");
  const active = "tasks_active_work_fields_present";
  const done = "tasks_done_fields_present";
  const cases = [
    [active, "23514", {}, "work.error_active_owner", "work-owner"],
    [active, "23514", { ownerId: "member" }, "work.error_active_due", "work-date"],
    [active, "23514", { ownerId: "member", dueOn: "2026-09-01" }, "work.error_active_next", "work-next-action"],
    [active, "23514", { ownerId: "member", dueOn: "2026-09-01", nextAction: "Bel Marco" }, "work.error_active_completion", "work-completion"],
    [active, "23514", { ownerId: "member", dueOn: "2026-09-01", nextAction: "Bel Marco", completion: "Akkoord" }, "work.error_active_details", ""],
    [done, "23514", {}, "work.error_completed_owner", "work-owner"],
    [done, "23514", { ownerId: "member" }, "work.error_completed_result", "work-completion"],
    [done, "23514", { ownerId: "member", completion: "Klaar" }, "work.error_completed_details", ""],
    ["tasks_review_has_separate_approver", "23514", { approverId: "member" }, "work.error_reviewer_not_owner", "work-approver"],
    ["unmapped duplicate", "23505", {}, "work.error_concurrent_save", ""],
    ["unmapped foreign key", "23503", {}, "work.error_linked_changed", ""],
    ["permission denied", "42501", {}, "work.error_access_changed", ""],
    ["expired token", "PGRST301", {}, "work.error_access_changed", ""],
    ["unexpected internal failure", "XX999", {}, "work.error_save_unknown", ""]
  ];
  for (const [serverMessage, code, current, key, fieldId] of cases) {
    const result = translateWorkRepositoryError({ serverMessage, code }, current);
    assert.equal(result.key, key, `${serverMessage} chose the wrong recovery`);
    assert.equal(result.fieldId, fieldId, `${serverMessage} points to the wrong field`);
    assert.equal(result.message, nl[key], `${serverMessage} did not use the Dutch recovery sentence`);
  }
});

test("Work validation covers inactive Done owners and both link formats in Dutch", () => {
  setLanguage("nl");
  const base = {
    title: "Voorbeeld", status: "done", ownerId: "former", approverId: "",
    dueOn: "", nextAction: "", completion: "Afgerond", blocker: "", flags: [],
    sourceUrl: "", latestFileUrl: ""
  };
  const inactive = validateWorkValues(base, { editableMemberIds: new Set(["active"]) });
  assert.equal(inactive.key, "work.error_owner_inactive");
  const source = validateWorkValues({ ...base, status: "backlog", ownerId: "", completion: "", sourceUrl: "HTTPS://voorbeeld.nl" });
  assert.equal(source.key, "work.error_source_url");
  const file = validateWorkValues({ ...base, status: "backlog", ownerId: "", completion: "", latestFileUrl: "http://voorbeeld.nl" });
  assert.equal(file.key, "work.error_file_url");
});

test("Work displays database enums and untouched seed areas through Dutch labels", () => {
  setLanguage("nl");
  const statuses = {
    backlog: "Backlog",
    this_week: "Deze week",
    doing: "Bezig",
    review: "Beoordeling / Besluit",
    waiting: "Wachten / Vastgelopen",
    done: "Klaar",
    legacy_value: "Onbekende fase"
  };
  for (const [status, label] of Object.entries(statuses)) assert.equal(workStatusLabel(status), label);

  assert.match(hubSource, /workstream\.name === seeded\.source \? t\(seeded\.key\) : workstream\.name/);
  assert.match(hubSource, /appendOption\(workstreamSelect, workstream\.id, workstreamName\(workstream\.id\)\)/);
  assert.doesNotMatch(hubSource, /appendOption\(workstreamSelect, workstream\.id, workstream\.name\)/);
  assert.match(hubSource, /PRIORITY_LABEL_KEYS\[priority\] \|\| "work\.priority_unknown"/);
  assert.match(hubSource, /flagLabel\(flag\) \|\| t\("work\.flag_unknown"\)/);
  assert.equal(nl["work.area_operations"], "Bedrijfsvoering");
  assert.equal(nl["work.area_product_design"], "Product & ontwerp");
  assert.equal(nl["work.area_brand_content"], "Merk & content");
  assert.equal(nl["work.area_automation"], "Automatisering");
  assert.equal(nl["work.area_administration"], "Administratie");
});

test("Work copy uses complete placeholder sentences instead of English fragments", () => {
  for (const key of [
    "work.card_next_value", "work.card_blocked_value", "work.conflict_latest_value",
    "work.conflict_yours_value", "work.saved_in"
  ]) {
    assert.match(en[key], /\{(?:value|title)\}/, `${key} is not a complete value template`);
    assert.match(nl[key], /\{(?:value|title)\}/, `${key} lost its value placeholder in Dutch`);
  }
  for (const key of Object.keys(en).filter((candidate) => candidate.startsWith("work."))) {
    assert.equal(en[key], en[key].trim(), `${key} relies on English whitespace for concatenation`);
    assert.equal(nl[key], nl[key].trim(), `${key} relies on Dutch whitespace for concatenation`);
    assert.doesNotMatch(en[key], /\{note\}/, `${key} still splices an optional sentence fragment`);
    assert.doesNotMatch(nl[key], /\{note\}/, `${key} still splices an optional sentence fragment`);
  }
});

test("multi-field conflict guidance uses the active language's conjunction", () => {
  assert.equal(
    new Intl.ListFormat("nl-NL", { type: "conjunction" }).format(["fase", "beoordelaar"]),
    "fase en beoordelaar"
  );
  assert.equal(
    new Intl.ListFormat("en-GB", { type: "conjunction" }).format(["status", "approver"]),
    "status and approver"
  );
  const start = hubSource.indexOf("function conflictFieldList");
  const end = hubSource.indexOf("function conflictValueLabel", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = hubSource.slice(start, end);
  assert.match(source, /new Intl\.ListFormat\(hubLocale\(\), \{ type: "conjunction" \}\)/);
  assert.doesNotMatch(source, /\.join\(", "\)/);
  assert.equal(nl["work.latest_choose"], "De laatste versie is geladen. Kies voor {fields} wat je wilt houden voordat je opslaat.");
  assert.equal(en["work.latest_choose"], "Latest version loaded. Choose what to keep for {fields} before saving.");
});

test("an open stage error retranslates its stage name instead of mixing languages", () => {
  setLanguage("en");
  const issue = validateWorkValues({
    title: "Example",
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
  assert.equal(issue.vars.stage, "This week");
  assert.equal(issue.vars.stageCode, "this_week");
  setLanguage("nl");
  const vars = { ...issue.vars, stage: workStatusLabel(issue.vars.stageCode) };
  assert.equal(t(issue.key, vars), "Kies wie dit oppakt voordat je het naar Deze week verplaatst.");
  assert.match(hubSource, /if \(vars\?\.stageCode\) vars\.stage = statusLabel\(vars\.stageCode\)/);
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
  assert.match(source, /const draft = dialog\.open \? rawValuesFromForm\(\) : null/);
  assert.doesNotMatch(source, /applyValuesToForm\(draft\)/);
  assert.match(source, /get\("work-workstream"\)\.value = draft\.workstreamId/);
  assert.match(source, /syncRequirements\(\{ clearError: false \}\)/);
  assert.match(source, /retranslateFormError\(\)/);
  assert.match(source, /retranslateDialogStatus\(\)/);
  assert.match(source, /disconnectHomeActivityObserver\(\)/);
  assert.match(source, /scheduleHomeActivityAcknowledgement\(/);
  assert.doesNotMatch(source, /loadWorkspace|refreshTasks|clearFormError/);
  assert.equal(t("work.guidance_doing"), en["work.guidance_doing"]);
});

test("conflicting due dates use the active locale", () => {
  const start = hubSource.indexOf("function conflictValueLabel");
  const end = hubSource.indexOf("function protectedConflictFields", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = hubSource.slice(start, end);
  assert.match(source, /key === "dueOn"[\s\S]*formatDate\(value\)/);
  assert.doesNotMatch(source, /key === "dueOn"[\s\S]*String\(value\)/);
});
