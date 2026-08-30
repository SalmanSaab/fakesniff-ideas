/* FAKESNIFF Hub — language. Owner: Claude. Translations: shared.
 *
 * Marco owns this company, is the main user, and reads English poorly. The Hub
 * was built entirely in English, which made it a tool he tolerates rather than
 * one he uses. This is the machinery that fixes that properly, rather than the
 * assistant translating around the edges.
 *
 * ── How it works ───────────────────────────────────────────────────────────
 *
 *   t("lookbook.add")            -> "Add a reference" / "Referentie toevoegen"
 *   t("decisions.title_len", {n: 240})
 *   applyTranslations(root)      -> rewrites every [data-t] inside root
 *
 * Two rules that keep this from rotting:
 *
 * 1. English is the source of truth and always present. A missing translation
 *    falls back to English and logs once in development. A screen that renders
 *    "decisions.save_button" because someone forgot a key is worse than a
 *    screen in the wrong language.
 *
 * 2. Keys are namespaced by module, so ownership is obvious and two people
 *    translating different screens never touch the same lines.
 *
 * ── Why not a library ──────────────────────────────────────────────────────
 *
 * The Hub ships as plain modules with no build step and a CSP that forbids
 * anything not same-origin. Pulling in an i18n framework would mean a bundler,
 * a vendored copy to hash-pin, and a dependency to keep current, for behaviour
 * that is a lookup and a substitution. This is that lookup.
 */

export const LANGUAGES = Object.freeze([
  ["en", "English"],
  ["nl", "Nederlands"],
  ["tr", "Türkçe"],
  ["ar", "العربية"],
]);

/* Arabic runs right to left. Naming it here rather than checking the code in
   three places means adding Hebrew or Farsi later is one line. */
const RTL = new Set(["ar"]);

const STORAGE_KEY = "fakesniff-hub-language";
const listeners = new Set();
const missing = new Set();

let current = readStored();
let dictionaries = { en: {} };

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some(([code]) => code === v) ? v : "en";
  } catch {
    return "en";
  }
}

export function currentLanguage() {
  return current;
}

export function isRightToLeft(code = current) {
  return RTL.has(code);
}

/** Register a dictionary. Modules call this with their own namespace. */
export function addTranslations(code, entries) {
  dictionaries[code] = { ...(dictionaries[code] || {}), ...entries };
}

/**
 * Look up a key. Falls back to English, then to the key itself — but a key
 * appearing on screen is a bug, so it is logged the first time it happens.
 *
 * `vars` are substituted as {name}. Values are inserted as text by the caller,
 * never as markup, so a translation can never introduce HTML.
 */
export function t(key, vars) {
  const table = dictionaries[current] || {};
  let text = table[key];

  if (text === undefined) {
    text = (dictionaries.en || {})[key];
    if (text === undefined) {
      if (!missing.has(key)) {
        missing.add(key);
        console.warn(`i18n: no English text for "${key}"`);
      }
      return key;
    }
    if (current !== "en" && !missing.has(current + ":" + key)) {
      missing.add(current + ":" + key);
      console.warn(`i18n: "${key}" is not translated into ${current} yet`);
    }
  }

  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, name) =>
    (name in vars ? String(vars[name]) : whole));
}

/**
 * Rewrite everything marked up for translation inside `root`.
 *
 *   <h2 data-t="lookbook.heading">Lookbook</h2>
 *   <input data-t-placeholder="lookbook.search">
 *   <button data-t-aria="common.close">
 *
 * The English stays in the HTML as the written source, so the file is still
 * readable and still works if this module never loads.
 */
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-t]").forEach((el) => {
    el.textContent = t(el.dataset.t);
  });
  root.querySelectorAll("[data-t-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.tPlaceholder));
  });
  root.querySelectorAll("[data-t-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.tAria));
  });
  root.querySelectorAll("[data-t-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.tTitle));
  });
}

/** Change language everywhere. Modules re-render by listening. */
export function setLanguage(code) {
  if (!LANGUAGES.some(([c]) => c === code) || code === current) return;
  current = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* session only */ }

  document.documentElement.lang = code;
  document.documentElement.dir = isRightToLeft(code) ? "rtl" : "ltr";
  applyTranslations(document);
  listeners.forEach((fn) => { try { fn(code); } catch { /* one bad listener must not stop the rest */ } });
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply the stored choice on load, before anything renders in the wrong language. */
export function initLanguage() {
  document.documentElement.lang = current;
  document.documentElement.dir = isRightToLeft(current) ? "rtl" : "ltr";
  applyTranslations(document);
  return current;
}

/* Development aid: what still needs translating, per language. Used by the
   check in tests rather than by anything shipped. */
export function untranslatedKeys(code) {
  const english = Object.keys(dictionaries.en || {});
  const theirs = dictionaries[code] || {};
  return english.filter((k) => theirs[k] === undefined);
}
