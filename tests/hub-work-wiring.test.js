import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hubSource = await readFile(new URL("../hub.js", import.meta.url), "utf8");
const hubHtml = await readFile(new URL("../hub.html", import.meta.url), "utf8");
const hubCss = await readFile(new URL("../hub.css", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = hubSource.indexOf(`function ${name}`);
  const end = nextName ? hubSource.indexOf(`function ${nextName}`, start + 1) : hubSource.length;
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return hubSource.slice(start, end);
}

test("plain-language Work validation runs before native browser validation", () => {
  const source = functionSource("saveTask", "archiveTask");
  const policyIndex = source.indexOf("validationError(values, id)");
  const nativeIndex = source.indexOf("form.checkValidity()");
  assert.notEqual(policyIndex, -1);
  assert.notEqual(nativeIndex, -1);
  assert.ok(policyIndex < nativeIndex);
});

test("each editor opening resets status option locks", () => {
  const source = functionSource("setFormReadOnly", "syncRequirements");
  assert.match(source, /statusInput\.querySelectorAll\("option"\)/);
  assert.match(source, /option\.disabled = false/);
});

test("a pending save freezes editor fields", () => {
  const source = functionSource("setSaving", "reloadLatestConflict");
  assert.match(source, /querySelectorAll\("input, select, textarea"\)/);
  assert.match(source, /control\.disabled = true/);
  assert.match(source, /aria-busy/);
});

test("stale drafts have an in-dialog recovery action", () => {
  assert.match(hubHtml, /id="reload-latest-work-button"/);
  assert.match(hubSource, /reloadLatestButton\.addEventListener\("click", reloadLatestConflict\)/);
  assert.match(hubSource, /showTranslatedFormError\("work\.changed_unsaved"\)/);
});

test("conflict reload retains both same-field values for an explicit choice", () => {
  const source = functionSource("reloadLatestConflict", "startMutation");
  assert.match(hubHtml, /id="work-conflict-review"/);
  assert.match(source, /state\.conflictReview = unresolvedKeys\.length/);
  assert.match(source, /protectedFields: \[\.\.\.protectedFields\]/);
  assert.match(source, /draftValues: conflict\.draftValues/);
  assert.match(source, /latestValues/);
  assert.match(hubSource, /resolveConflictChoice\(button\.dataset\.conflictKey/);
  /* Codex — 2026-08-30: authority guidance is now a complete translated
     sentence variant instead of an English-fragment suffix. */
  assert.match(hubSource, /protectedConflictFields\(\{ protectedFields \}\)/);
  assert.match(hubSource, /keepLatest\.setAttribute\("aria-describedby", latestId\)/);
  assert.match(hubSource, /useMine\.setAttribute\("aria-describedby", mineId\)/);
});

test("conflict reload preserves archived draft references and current approval authority", () => {
  const source = functionSource("reloadLatestConflict", "startMutation");
  assert.match(source, /conflict\.draftValues\.workstreamId/);
  assert.match(source, /reconcileWorkDraft\(/);
  assert.match(source, /if \(!canEdit\(\)\)/);
});

test("resolving one conflict keeps edits made elsewhere in the live form", () => {
  const source = functionSource("resolveConflictChoice", "showFormError");
  const snapshotIndex = source.indexOf("review.mergedValues = valuesFromForm()");
  const applyIndex = source.indexOf("applyValuesToForm(review.mergedValues)");
  assert.notEqual(snapshotIndex, -1);
  assert.notEqual(applyIndex, -1);
  assert.ok(snapshotIndex < applyIndex);
  assert.match(source, /work-more-details[\s\S]*\.open = true/);
  assert.match(source, /getClientRects\(\)\.length/);
});

test("status conflict review does not clear draft-only approval or blocker details", () => {
  const requirements = functionSource("syncRequirements", "taskById");
  const reload = functionSource("reloadLatestConflict", "startMutation");
  assert.match(requirements, /statusChoicePending/);
  assert.match(requirements, /if \(!statusChoicePending\)/);
  assert.ok(reload.indexOf("state.conflictReview = unresolvedKeys.length") < reload.indexOf("applyValuesToForm(merged.values)"));
});

test("conflict reload announces success inside the modal", () => {
  const source = functionSource("reloadLatestConflict", "startMutation");
  assert.match(hubHtml, /id="work-dialog-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /showTranslatedDialogStatus\("work\.latest_[a-z]+"[\s\S]*focus: true/);
  assert.doesNotMatch(source, /showNotice\(t\("work\.latest_/);
});

test("Home exposes one dynamic next-action control", () => {
  assert.match(hubHtml, /id="home-focus-action"/);
  assert.match(hubSource, /selectHomeFocus\(state\.tasks/);
  assert.match(hubSource, /get\("home-focus-action"\)\.addEventListener\("click"/);
});

// Codex — 2026-08-13: an empty board is a valid first-use state, not an endless loading state.
test("Home gives an actionable empty-workspace fallback", () => {
  assert.doesNotMatch(hubHtml, /Loading your next move/i);
  assert.match(hubHtml, /data-t="home\.nothing_planned"/);
  const source = functionSource("renderHomeFocus", "renderSummary");
  assert.match(source, /t\("home\.focus_create"\)/);
  assert.match(source, /t\("home\.focus_create_detail"\)/);
  assert.match(source, /t\("home\.create_first"\)/);
  assert.match(source, /action\.dataset\.homeAction = "create"/);
  assert.match(source, /action\.dataset\.homeAction = "open-work"/);
  assert.match(source, /t\("home\.focus_no_work_detail"\)[\s\S]*action\.hidden = true/);
  assert.match(source, /state\.stale[\s\S]*action\.dataset\.homeAction = "refresh"/);
  assert.match(hubSource, /homeAction === "refresh"[\s\S]*requestWorkspaceRefresh\(\)/);
});

test("Home checks sanitized changes only while Home is visible", () => {
  assert.match(hubHtml, /id="home-changes-title" data-t="home\.since_last_look"/);
  assert.match(hubHtml, /id="home-changes-list"/);
  const activate = functionSource("activateSection", "registerSection");
  assert.match(activate, /normalized !== "home"[\s\S]*disconnectHomeActivityObserver/);
  assert.match(activate, /refreshHomeActivity\(\)/);

  const source = functionSource("refreshHomeActivity", "renderHomeFocus");
  assert.match(source, /state\.activeSectionId !== "home"/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /state\.repository\.loadHomeChanges\(userId, 5\)/);
  assert.match(source, /normalizeHomeChanges\(raw\)/);
  assert.match(source, /const rendered = renderHomeActivity\(\)/);
  assert.match(source, /rendered\.receiptGroups/);
  assert.match(hubSource, /IntersectionObserver[\s\S]*intersectionRatio >= 0\.6/);
  assert.match(hubSource, /observer\.unobserve\(entry\.target\)/);
  assert.match(hubSource, /state\.repository\.acknowledgeHomeChanges\(userId, exactIds\)/);
  assert.doesNotMatch(source, /requestAnimationFrame/);
  assert.match(source, /homeActivityRequestIsCurrent/);
  assert.doesNotMatch(source, /state\.stale\s*=\s*true|showAppError\(/);
});

test("returning coordinates one Work refresh before one Home check", () => {
  const source = functionSource("refreshHomeAfterReturning", "clearFieldError");
  assert.match(source, /const workRefreshOwnsReturn = refreshAfterReturning\(\)/);
  assert.match(source, /!workRefreshOwnsReturn/);
  assert.match(source, /!state\.refreshing/);
  assert.match(source, /lastRefreshedAt >= 30_000/);
  const refresh = functionSource("refreshTasks", "saveTask");
  assert.match(refresh, /state\.homeActivityRequestSequence \+= 1/);
  assert.match(refresh, /disconnectHomeActivityObserver\(\)/);
});

test("the core shell marks staging without depending on the assistant", () => {
  const marker = functionSource("applyEnvironmentMarker", "registerSection");
  assert.match(marker, /document\.body\.classList\.toggle\("is-staging", isStaging\)/);
  const bootSource = functionSource("boot");
  assert.match(bootSource, /state\.config = validation\.config;[\s\S]*applyEnvironmentMarker\(state\.config\)/);
});

test("returning to a stale, closed board quietly refreshes it", () => {
  const source = functionSource("refreshAfterReturning", "clearFieldError");
  assert.match(source, /Date\.now\(\) - state\.lastRefreshedAt >= 30_000/);
  assert.match(source, /dialog\.open/);
  assert.match(source, /refreshTasks\(\{ quiet: true \}\)/);
  assert.match(hubSource, /visibilitychange.*refreshHomeAfterReturning/);
  assert.match(hubSource, /function refreshHomeAfterReturning\(\)[\s\S]*refreshAfterReturning\(\)/);
  assert.match(hubSource, /refreshWhenDialogCloses/);
});

test("a failed refresh replaces an unusable Home create action", () => {
  const source = functionSource("refreshTasks", "saveTask");
  const staleIndex = source.indexOf("state.stale = true");
  const focusIndex = source.indexOf("renderHomeFocus()", staleIndex);
  assert.notEqual(staleIndex, -1);
  assert.ok(focusIndex > staleIndex);
});

test("an optional area never blocks creating work", () => {
  const source = functionSource("renderWorkspace", "setSyncState");
  assert.doesNotMatch(source, /activeWorkstreams|Area setup is incomplete/);
  assert.match(source, /newWorkButton\.disabled = !canEdit\(\)/);
});

// Codex — 2026-08-13: initial module links must not depend on hashchange.
test("boot consumes Decisions and Lookbook deep links before any configuration early return", () => {
  assert.match(hubHtml, /<section id="lookbook" class="page-section"/);
  assert.match(hubHtml, /<section id="decisions" class="page-section"/);
  const source = functionSource("boot");
  const bindIndex = source.indexOf("bindEvents()");
  const activateIndex = source.indexOf("activateSection(sectionIdFromHash())");
  const validationIndex = source.indexOf("validateHubConfig");
  assert.notEqual(bindIndex, -1);
  assert.notEqual(activateIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.ok(bindIndex < activateIndex);
  assert.ok(activateIndex < validationIndex);
  // Codex — 2026-08-13: the phone layout must not override the router's
  // hidden inactive sections with a higher-specificity bare Home selector.
  assert.match(hubCss, /#home\.is-active\s*\{\s*display:\s*flex;/);
  assert.doesNotMatch(hubCss, /#home\s*\{[^}]*display:\s*flex;/);
});
