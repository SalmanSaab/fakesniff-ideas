/* Codex — 2026-08-31: the shell is a daily-work map, not a flat module list.
   These tests protect the phone destinations and the mount/hash contract; the
   responsive result is also smoke-tested in a real browser. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../hub.html", import.meta.url), "utf8");
const source = await readFile(new URL("../hub.js", import.meta.url), "utf8");
const css = await readFile(new URL("../hub.css", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("desktop navigation groups the Hub around daily jobs", () => {
  const navStart = html.indexOf('<nav class="primary-nav"');
  const navEnd = html.indexOf("</nav>", navStart);
  const nav = html.slice(navStart, navEnd);
  assert.match(nav, /data-t="nav\.today_group"[\s\S]*href="#home"/);
  assert.match(nav, /data-t="nav\.run_group"[\s\S]*href="#work"[\s\S]*href="#decisions"/);
  assert.match(nav, /data-t="nav\.create_group"[\s\S]*href="#lookbook"[\s\S]*href="#idea-lab"[\s\S]*href="#designs"/);
  assert.doesNotMatch(nav, /nav-index|nav-meta|Internal control tower/);
});

test("phone navigation keeps four daily destinations and one truthful More menu", () => {
  for (const id of ["home", "work", "lookbook", "decisions"]) {
    assert.match(html, new RegExp(`href="#${id}"[^>]*data-mobile-nav="primary"`));
  }
  for (const id of ["idea-lab", "designs"]) {
    assert.match(html, new RegExp(`href="#${id}"[^>]*data-mobile-nav="secondary"`));
  }
  assert.match(html, /id="mobile-more-button"[^>]*aria-expanded="false"[^>]*aria-haspopup="dialog"[^>]*aria-controls="mobile-more-menu"[^>]*data-t-aria="nav\.more_aria"/);
  assert.match(html, /id="mobile-more-menu"[\s\S]*href="#idea-lab"[\s\S]*href="#designs"/);
  assert.match(html, /id="mobile-more-menu"[\s\S]*id="mobile-signout-button"/);
  assert.match(css, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.primary-nav \.nav-link\[data-mobile-nav="secondary"\]\s*\{\s*display:\s*none;/);
  assert.match(css, /inset:\s*auto 0 0;/);
  assert.match(css, /href="#decisions"\]\s*\{\s*order:\s*3;[\s\S]*href="#lookbook"\]\s*\{\s*order:\s*4;/);
  assert.match(css, /padding-bottom:\s*calc\(var\(--mobile-nav-height\) \+ var\(--safe-bottom\)\)/);
  assert.match(css, /min-height:\s*calc\(var\(--topbar-height\) \+ var\(--safe-top\)\)/);
  assert.match(css, /@media \(max-width: 820px\), \(max-width: 960px\) and \(max-height: 560px\)/);
  assert.match(css, /\.hub-notice\s*\{\s*bottom:\s*calc\(var\(--mobile-nav-height\) \+ 14px \+ var\(--safe-bottom\)\)/);
});

test("creation destinations mark the phone menu current without changing section ids", () => {
  const activate = functionSource("activateSection", "applyEnvironmentMarker");
  assert.match(activate, /MOBILE_CREATE_SECTIONS\.has\(normalized\)/);
  assert.match(activate, /mobileMoreButton\.classList\.toggle\("is-current", createSectionActive\)/);
  assert.match(activate, /t\("nav\.more_current", \{ section: sectionLabel\(normalized\) \}\)/);
  assert.doesNotMatch(activate, /mobileMoreButton\.setAttribute\("aria-current"/);
  assert.match(activate, /topbarTitle\.dataset\.t = titleKey/);
  for (const id of ["home", "work", "idea-lab", "lookbook", "designs", "decisions"]) {
    assert.match(html, new RegExp(`<section id="${id}" class="page-section`));
    assert.match(html, new RegExp(`<section id="${id}"[^>]*tabindex="-1"`));
  }
  assert.match(source, /const REGISTERABLE_SECTION_IDS = new Set\(\["idea-lab", "lookbook", "decisions", "designs"\]\)/);
});

test("the More menu is native-dialog keyboard safe and closes after use or sign-out", () => {
  const open = functionSource("openMobileMoreNavigation", "closeMobileMoreNavigation");
  const close = functionSource("closeMobileMoreNavigation", "bindEvents");
  assert.match(open, /mobileMoreMenu\.showModal\(\)/);
  assert.match(open, /querySelector\("a"\)\?\.focus\(\)/);
  assert.match(close, /mobileMoreMenu\.close\(\)/);
  assert.match(source, /mobileMoreMenu\.addEventListener\("close"[\s\S]*aria-expanded", "false"/);
  assert.match(source, /restoreMobileMoreFocus[\s\S]*mobileMoreButton\.focus\(\)/);
  assert.match(source, /event\.target === mobileMoreMenu[\s\S]*closeMobileMoreNavigation\(\)/);
  const teardown = functionSource("clearWorkspaceState", "hasEditRole");
  assert.match(teardown, /closeMobileMoreNavigation\(false\)/);
});

test("Home starts with one direct create action and three honest destination shortcuts", () => {
  assert.match(html, /class="home-start"[\s\S]*id="home-focus-action"/);
  assert.match(html, /id="home-new-work-action"[^>]*href="#work"/);
  assert.match(html, /class="home-quick-action" href="#idea-lab"/);
  assert.match(html, /class="home-quick-action" href="#lookbook"/);
  assert.match(html, /class="home-quick-action" href="#decisions"/);
  assert.match(html, />Open Idea Lab<|>Open Lookbook<|>Open Decisions</);
  assert.doesNotMatch(html, /class="panel rhythm-panel"/);
  assert.doesNotMatch(html, /Maximum three|Approver-controlled|Waiting needs a reason|Every active item gets one owner/);
  assert.doesNotMatch(css, /#home \.home-changes-panel\s*\{\s*order:/);
  assert.match(source, /homeNewWorkAction\.addEventListener\("click"[\s\S]*window\.setTimeout\(openNewTask, 0\)/);
});

test("Work wraps into readable lanes instead of a sideways desktop strip", () => {
  const rethinkStart = css.indexOf("daily-work shell rethink");
  const rethink = css.slice(rethinkStart);
  assert.match(rethink, /\.board\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*overflow:\s*visible;/);
  assert.match(rethink, /max-width:\s*1180px[\s\S]*\.board\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(rethink, /max-width:\s*820px[\s\S]*\.board\s*\{\s*display:\s*block;/);
});

test("floating module actions clear the phone navigation", () => {
  const rethink = css.slice(css.indexOf("daily-work shell rethink"));
  assert.match(rethink, /body #ilab-add,[\s\S]*body #lb-add,[\s\S]*body \.dc-add,[\s\S]*body \.as-open[\s\S]*bottom:\s*calc\(var\(--mobile-nav-height\) \+ 14px \+ var\(--safe-bottom\)\)/);
});

test("short landscape phones use the bottom shell and desktop rails can scroll", () => {
  const rethink = css.slice(css.indexOf("daily-work shell rethink"));
  assert.match(rethink, /\.side-rail\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*overscroll-behavior:\s*contain;/);
  assert.match(rethink, /max-width: 960px\) and \(max-height: 560px\)[\s\S]*\.side-rail\s*\{[\s\S]*inset:\s*auto 0 0;[\s\S]*overflow:\s*visible;/);
});

test("user-triggered section changes focus the page while deep links do not steal focus", () => {
  const activate = functionSource("activateSection", "applyEnvironmentMarker");
  assert.match(activate, /\{ focus = false \} = \{\}/);
  assert.match(activate, /if \(focus\) window\.requestAnimationFrame\(\(\) => get\(normalized\)\?\.focus\(\)\)/);
  assert.match(source, /primaryNav\.addEventListener\("click"[\s\S]*activateSection\([^\n]+\{ focus: true \}\)/);
  assert.match(source, /home-quick-grid[\s\S]*activateSection\([^\n]+\{ focus: true \}\)/);
  assert.match(source, /window\.addEventListener\("hashchange", \(\) => activateSection\(sectionIdFromHash\(\)\)\)/);
});

test("global Work refresh does not pretend to refresh registered modules", () => {
  const activate = functionSource("activateSection", "applyEnvironmentMarker");
  assert.match(activate, /CORE_REFRESH_SECTIONS\.has\(normalized\)/);
  assert.match(activate, /refreshButton\.hidden = !canRefreshHere/);
  assert.match(activate, /mobileRefreshButton\.hidden = !canRefreshHere/);
  assert.deepEqual([...source.matchAll(/const CORE_REFRESH_SECTIONS = new Set\(\[([^\]]+)\]\)/g)].length, 1);
});

test("access and shell chrome use the shared language dictionaries", () => {
  for (const marker of [
    'data-t="shell.skip_workspace"', 'data-t="auth.private_workspace"',
    'data-t="auth.email"', 'data-t="auth.password"', 'data-t="auth.signin"',
    'data-t="nav.home"', 'data-t="nav.work"', 'data-t="nav.lookbook"',
    'data-t="nav.decisions"', 'data-t="common.signout"'
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const key of [
    "auth.signin_invited", "auth.verifying_membership", "auth.access_denied",
    "auth.workspace_verify_failed", "auth.signing_in", "auth.login_mismatch",
    "auth.check_inbox", "auth.signed_out", "auth.expired", "auth.retry_failed"
  ]) assert.match(source, new RegExp(`"${key.replace(".", "\\.")}"`));

  assert.doesNotMatch(source, /textContent = "Signing in…"|"Idea Lab is temporarily unavailable"|"Loaded just now"/);
  assert.match(source, /t\("shell\.section_unavailable", \{ section: sectionLabel\(sectionId\) \}\)/);
});

test("language can be changed before sign-in without duplicating the assistant's signed-in picker", () => {
  assert.match(html, /id="access-language-picker"[\s\S]*<option value="en">EN<\/option>[\s\S]*<option value="nl">NL<\/option>/);
  assert.doesNotMatch(html, /id="shell-language-picker"/);
  assert.match(source, /const languagePickers = \[get\("access-language-picker"\)\]/);
  assert.match(source, /languagePickers\.forEach\(\(picker\) => picker\.addEventListener\("change"[\s\S]*setLanguage\(event\.target\.value\)/);
  const boot = functionSource("boot");
  assert.match(boot, /initLanguage\(\);[\s\S]*syncLanguagePickers\(\);[\s\S]*onLanguageChange\(renderLanguageChange\)/);
});

test("access states and signed-in placeholders stay on the active language", () => {
  const accessView = functionSource("setAccessText", "showSetupMode");
  assert.match(accessView, /element\.dataset\.t = key/);
  assert.match(accessView, /element\.textContent = t\(key\)/);
  assert.match(source, /showSignedOut\("auth\.expired"\)/);
  assert.match(source, /showChecking\("auth\.starting_secure"\)/);
  assert.doesNotMatch(source, /setAccessView\(\{[\s\S]{0,160}\bcopy:\s*t\(/);
  for (const key of [
    "designs.kicker", "designs.heading", "designs.tagline",
    "decisions.kicker", "decisions.heading", "decisions.tagline",
    "shell.module_loading", "shell.private_module_note", "shell.footer_line", "shell.back_to_top"
  ]) assert.match(html, new RegExp(`data-t="${key.replace(".", "\\.")}"`));
});
