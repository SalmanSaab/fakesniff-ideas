/* FAKESNIFF Hub — Decisions. Owner: Claude.
 *
 * What was agreed, who agreed it, and when. Built for the Turkey factory visit
 * on 24 Aug: fabric weights, prices, minimum order quantities, delivery dates
 * and which samples to run all get settled in a room Salman is not in, and
 * currently survive only in someone's memory and a WhatsApp thread.
 *
 * Two things shape every decision below.
 *
 * 1. This is typed standing on a factory floor, on a phone, in a hurry. Only
 *    the title is required. Everything else can be filled in on the flight
 *    home. A decision captured badly beats one not captured.
 *
 * 2. Marco and Emiel are not technical. The database has real constraints and
 *    they will be hit. A person must never see "decisions_title_length" — they
 *    see a sentence telling them what to change. That translation is the most
 *    important code in this file.
 */

import { t, onLanguageChange } from "./hub-i18n.js";

const TOPICS = [
  ["fabric", "decisions.topic_fabric"],
  ["price", "decisions.topic_price"],
  ["moq", "decisions.topic_moq"],
  ["delivery", "decisions.topic_delivery"],
  ["sample", "decisions.topic_sample"],
  ["quality", "decisions.topic_quality"],
  ["supplier", "decisions.topic_supplier"],
  ["packaging", "decisions.topic_packaging"],
  ["design", "decisions.topic_design"],
  ["brand", "decisions.topic_brand"],
  ["other", "decisions.topic_other"],
];
const TOPIC_LABEL = new Map(TOPICS);   /* value is a key, not text */

/* 001 defines these four. 'decided' additionally requires the detail field,
   which is why the form asks for it before letting you choose that status. */
const STATUSES = [
  ["proposed", "decisions.state_proposed"],
  ["decided", "decisions.state_decided"],
  ["superseded", "decisions.state_superseded"],
  ["cancelled", "decisions.state_cancelled"],
];
const STATUS_LABEL = new Map(STATUSES);

const MAX_TITLE = 240;
const MAX_NAME = 160;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeEnum = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

function whenText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ---------------------------------------------------------------------------
 * Turning a database complaint into something a person can act on.
 *
 * Postgres says: new row for relation "decisions" violates check constraint
 * "decisions_decided_state". Marco reads that and stops using the Hub that
 * day. Every constraint this table can raise is named here; anything that
 * slips through falls back to a plain sentence rather than the raw text,
 * because a constraint name on screen is always a bug.
 * ------------------------------------------------------------------------ */
const CONSTRAINT_MESSAGES = [
  [/decisions_title_length/i,        () => t("decisions.err_title_len", { n: MAX_TITLE })],
  [/decisions_decided_state/i,       () => t("decisions.err_needs_detail")],
  [/decisions_status_allowed/i,      () => t("decisions.err_state")],
  [/decisions_topic_allowed/i,       () => t("decisions.err_topic")],
  [/decisions_counterparty_length/i, () => t("decisions.err_with_len", { n: MAX_NAME })],
  [/decisions_decided_by_name_length/i, () => t("decisions.err_by_len", { n: MAX_NAME })],
  [/decisions_lookbook_fk/i,         () => t("decisions.err_photo_gone")],
  [/decisions_workstream_fk/i,       () => t("decisions.err_workstream")],
  [/decisions_owner_fk/i,            () => t("decisions.err_owner")],
  [/violates row-level security|permission denied|42501/i, () => t("decisions.err_readonly")],
  [/duplicate key/i,                 () => t("decisions.err_duplicate")],
];

/* Exported so it can be tested without a DOM or a network, the same way Codex's
   work policy is. This is the function that decides whether Marco sees a
   sentence or a constraint name, so it should be the easiest thing here to
   write a test against. */
export function humanError(raw) {
  const text = String(raw?.message || raw || "");
  for (const [pattern, sentence] of CONSTRAINT_MESSAGES) {
    if (pattern.test(text)) return sentence();
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return t("decisions.err_network");
  }
  /* Deliberately not returning `text`. An unrecognised database error is still
     a database error, and showing it teaches people the Hub is broken. */
  return t("decisions.err_unknown");
}

/* Same pattern as the Lookbook: an external same-origin stylesheet, so the hub
   CSP (style-src 'self') stays intact. An inline <style> would be blocked. */
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || document.querySelector("link[data-dc-styles]")) return;
  stylesInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-dc-styles", "");
  link.href = new URL("hub-decisions.css", import.meta.url).href;
  document.head.appendChild(link);
}

export function mount(root, ctx) {
  injectStyles();
  const c = normaliseCtx(ctx);
  const readOnly = c.mode !== "authed" || c.member.role === "viewer";

  let items = [];
  let topicFilter = "all";
  let query = "";
  let editing = null;

  root.classList.add("dc", "fs-scope");
  if (readOnly) root.classList.add("dc-readonly");
  root.innerHTML = shell();

  const $ = (sel) => root.querySelector(sel);
  let listEl, errEl, sheet;

  /* Claude — 2026-08-30: pulled out of the mount body so a language change can
     rebuild the markup and re-attach, rather than leaving listeners pointing at
     elements that no longer exist. */
  function wire() {
    listEl = $("#dc-list");
    errEl = $("#dc-error");
    sheet = $("#dc-sheet");

    $("#dc-search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); render(); });
    $("#dc-filters").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-topic]");
      if (!chip) return;
      topicFilter = chip.dataset.topic;
      render();
    });
    $("#dc-add")?.addEventListener("click", () => openSheet(null));
    $("#dc-close").addEventListener("click", closeSheet);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
    $("#dc-form").addEventListener("submit", save);

    listEl.addEventListener("click", (e) => {
      const card = e.target.closest("[data-id]");
      if (!card) return;
      const found = items.find((i) => i.id === card.dataset.id);
      if (found) openSheet(found);
    });
  }
  wire();

  document.addEventListener("keydown", onKey);
  /* Claude — 2026-08-30: the vocabulary and every label are resolved at render
     time, so switching language only needs a redraw. Without this the page
     keeps the words it was built with until someone reloads. */
  const stopLang = onLanguageChange(() => { root.innerHTML = shell(); wire(); render(); });
  const timer = setInterval(load, 60000);
  void load();

  return () => {
    clearInterval(timer);
    stopLang();
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("hub-sheet-open");
    root.innerHTML = "";
    root.classList.remove("dc", "dc-readonly", "fs-scope");
  };

  /* ---------------------------------------------------------------- data */

  async function rest(path, options = {}) {
    if (c.mode !== "authed") throw new Error(t("decisions.sign_in"));
    const token = await c.getAccessToken();
    const res = await fetch(`${c.restUrl}${path}`, {
      ...options,
      headers: {
        apikey: c.anonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await res.text();
    if (!res.ok) {
      let detail = body;
      try { const j = JSON.parse(body); detail = j.message || j.details || body; } catch { /* keep text */ }
      throw new Error(detail);
    }
    return body ? JSON.parse(body) : null;
  }

  async function load() {
    if (c.mode !== "authed") { showError(t("decisions.sign_in")); return; }
    try {
      const rows = await rest(
        "/decisions?select=id,title,decision,context,status,topic,counterparty,decided_by_name"
        + ",decided_at,updated_at,created_at,lookbook_item_id"
        + "&archived_at=is.null&order=updated_at.desc&limit=200"
      );
      items = Array.isArray(rows) ? rows : [];
      showError("");
      render();
    } catch (err) {
      showError(humanError(err));
    }
  }

  async function save(event) {
    event.preventDefault();
    const btn = $("#dc-save");
    const title = $("#dc-title").value.trim();

    /* Checked here as well as in the database, so the common mistake gets a
       helpful sentence instantly instead of a round trip. */
    if (!title) { fieldError(t("decisions.need_title")); return; }
    if (title.length > MAX_TITLE) { fieldError(t("decisions.title_too_long", { n: title.length, max: MAX_TITLE })); return; }

    const status = safeEnum($("#dc-status").value, STATUSES.map(([v]) => v), "proposed");
    const detail = $("#dc-detail").value.trim();
    if (status === "decided" && !detail) {
      fieldError(t("decisions.err_needs_detail"));
      $("#dc-detail").focus();
      return;
    }

    const payload = {
      title,
      decision: detail,
      context: $("#dc-context").value.trim(),
      status,
      topic: safeEnum($("#dc-topic").value, TOPICS.map(([v]) => v), "other"),
      counterparty: $("#dc-counterparty").value.trim().slice(0, MAX_NAME),
      decided_by_name: $("#dc-by").value.trim().slice(0, MAX_NAME),
    };

    btn.disabled = true;
    fieldError("");
    try {
      if (editing) {
        await rest(`/decisions?id=eq.${encodeURIComponent(editing.id)}`, {
          method: "PATCH", body: JSON.stringify(payload),
          headers: { Prefer: "return=minimal" },
        });
      } else {
        await rest("/decisions", {
          method: "POST",
          body: JSON.stringify({ ...payload, workspace_id: c.workspaceId }),
          headers: { Prefer: "return=minimal" },
        });
      }
      closeSheet();
      await load();
    } catch (err) {
      fieldError(humanError(err));
    } finally {
      btn.disabled = false;
    }
  }

  async function archive() {
    if (!editing) return;
    try {
      await rest(`/decisions?id=eq.${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived_at: new Date().toISOString() }),
        headers: { Prefer: "return=minimal" },
      });
      closeSheet();
      await load();
    } catch (err) {
      fieldError(humanError(err));
    }
  }

  /* -------------------------------------------------------------- render */

  function visible() {
    return items.filter((it) => {
      if (topicFilter !== "all" && it.topic !== topicFilter) return false;
      if (!query) return true;
      return [it.title, it.decision, it.context, it.counterparty, it.decided_by_name]
        .some((v) => String(v || "").toLowerCase().includes(query));
    });
  }

  function render() {
    root.querySelectorAll("[data-topic]").forEach((chip) => {
      chip.classList.toggle("on", chip.dataset.topic === topicFilter);
    });

    const rows = visible();
    if (!rows.length) {
      listEl.innerHTML = `<p class="dc-empty">${
        items.length
          ? t("decisions.nothing_matches")
          : (readOnly
              ? t("decisions.empty_readonly")
              : t("decisions.empty"))
      }</p>`;
      return;
    }
    listEl.innerHTML = rows.map(card).join("");
  }

  function card(it) {
    const when = whenText(it.decided_at || it.updated_at);
    const meta = [
      t(TOPIC_LABEL.get(it.topic) || "decisions.topic_other"),
      it.counterparty ? t("decisions.with_prefix", { name: it.counterparty }) : "",
      when,
    ].filter(Boolean);
    return `<button class="dc-card" data-id="${esc(it.id)}" type="button">
      <span class="dc-status dc-${esc(it.status)}">${esc(t(STATUS_LABEL.get(it.status) || it.status))}</span>
      <span class="dc-title">${esc(it.title)}</span>
      ${it.decision ? `<span class="dc-what">${esc(it.decision)}</span>` : ""}
      <span class="dc-meta">${meta.map(esc).join(" · ")}</span>
    </button>`;
  }

  /* --------------------------------------------------------------- sheet */

  function openSheet(item) {
    if (readOnly && !item) return;
    editing = item;
    $("#dc-heading").textContent = t(item ? "decisions.sheet_view" : "decisions.sheet_new");
    $("#dc-title").value = item?.title || "";
    $("#dc-detail").value = item?.decision || "";
    $("#dc-context").value = item?.context || "";
    $("#dc-topic").value = item?.topic || "other";
    $("#dc-status").value = item?.status || "proposed";
    $("#dc-counterparty").value = item?.counterparty || "";
    $("#dc-by").value = item?.decided_by_name || "";
    fieldError("");

    const archiveBtn = $("#dc-archive");
    archiveBtn.hidden = !item || readOnly;
    archiveBtn.onclick = archive;
    $("#dc-form").querySelectorAll("input, textarea, select, #dc-save")
      .forEach((el) => { el.disabled = readOnly; });

    sheet.classList.add("open");
    document.body.classList.add("hub-sheet-open");
    (readOnly ? $("#dc-close") : $("#dc-title")).focus();
  }

  function closeSheet() {
    sheet.classList.remove("open");
    document.body.classList.remove("hub-sheet-open");
    editing = null;
  }

  function onKey(e) {
    if (e.key !== "Escape" || !sheet.classList.contains("open")) return;
    closeSheet();
  }

  function showError(message) {
    errEl.textContent = message;
    errEl.hidden = !message;
  }

  function fieldError(message) {
    const el = $("#dc-formerror");
    el.textContent = message;
    el.hidden = !message;
  }

  function shell() {
    const chips = [["all", "decisions.all"], ...TOPICS]
      .map(([v, label]) => `<button class="dc-chip" data-topic="${v}" type="button">${esc(t(label))}</button>`)
      .join("");
    const topicOptions = TOPICS.map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`).join("");
    const statusOptions = STATUSES.map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`).join("");

    return `
    <div class="dc-bar">
      <span class="dc-mark">${esc(t("decisions.heading"))}<small>${esc(t("decisions.tagline"))}</small></span>
    </div>
    <p id="dc-error" class="dc-errbox" hidden></p>
    <input id="dc-search" class="dc-search" type="search" placeholder="${esc(t("decisions.search"))}" aria-label="${esc(t("decisions.search"))}">
    <div id="dc-filters" class="dc-filters">${chips}</div>
    <div id="dc-list" class="dc-list"></div>
    ${readOnly ? "" : `<button id="dc-add" class="dc-add" type="button" aria-label="${esc(t("decisions.add"))}">+</button>`}

    <div id="dc-sheet" class="dc-sheetwrap" role="dialog" aria-modal="true" aria-labelledby="dc-heading">
      <div class="dc-sheet">
        <button id="dc-close" class="dc-close" type="button" aria-label="${esc(t("common.close"))}">&times;</button>
        <h2 id="dc-heading" class="dc-h">${esc(t("decisions.sheet_new"))}</h2>
        <form id="dc-form" class="dc-form">
          <label class="dc-lbl" for="dc-title">${esc(t("decisions.what"))}</label>
          <input id="dc-title" class="dc-input" type="text" maxlength="${MAX_TITLE}"
                 placeholder="${esc(t("decisions.what_placeholder"))}">
          <p class="dc-hint">${esc(t("decisions.what_hint"))}</p>

          <label class="dc-lbl" for="dc-topic">${esc(t("decisions.topic"))}</label>
          <select id="dc-topic" class="dc-input">${topicOptions}</select>

          <label class="dc-lbl" for="dc-status">${esc(t("decisions.state"))}</label>
          <select id="dc-status" class="dc-input">${statusOptions}</select>

          <label class="dc-lbl" for="dc-detail">${esc(t("decisions.detail"))}</label>
          <textarea id="dc-detail" class="dc-input dc-area"
                    placeholder="${esc(t("decisions.detail_placeholder"))}"></textarea>

          <label class="dc-lbl" for="dc-counterparty">${esc(t("decisions.with"))}</label>
          <input id="dc-counterparty" class="dc-input" type="text" maxlength="${MAX_NAME}"
                 placeholder="${esc(t("decisions.with_placeholder"))}">

          <label class="dc-lbl" for="dc-by">${esc(t("decisions.by"))}</label>
          <input id="dc-by" class="dc-input" type="text" maxlength="${MAX_NAME}"
                 placeholder="${esc(t("decisions.by_placeholder"))}">

          <label class="dc-lbl" for="dc-context">${esc(t("decisions.context"))}</label>
          <textarea id="dc-context" class="dc-input dc-area"
                    placeholder="${esc(t("decisions.context_placeholder"))}"></textarea>

          <p id="dc-formerror" class="dc-formerror" role="alert" hidden></p>

          <div class="dc-actions">
            <button id="dc-archive" class="dc-archive" type="button" hidden>${esc(t("common.archive"))}</button>
            <button id="dc-save" class="dc-savebtn" type="submit">${esc(t("decisions.save"))}</button>
          </div>
        </form>
      </div>
    </div>`;
  }
}

function normaliseCtx(ctx) {
  if (ctx && ctx.restUrl && typeof ctx.getAccessToken === "function") {
    return {
      mode: "authed",
      restUrl: ctx.restUrl.replace(/\/$/, ""),
      getAccessToken: ctx.getAccessToken,
      anonKey: ctx.anonKey || "",
      member: ctx.member || { name: "member", role: "member" },
      workspaceId: ctx.workspaceId || "",
    };
  }
  return { mode: "standalone", restUrl: "", anonKey: "",
           member: { name: "guest", role: "viewer" }, workspaceId: "" };
}

if (typeof window !== "undefined") {
  window.HubDecisions = { mount, humanError };
  if (window.Hub && typeof window.Hub.registerSection === "function") {
    window.Hub.registerSection("decisions", { mount });
  }
}
