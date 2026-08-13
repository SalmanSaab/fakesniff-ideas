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

const TOPICS = [
  ["fabric", "Fabric"], ["price", "Price"], ["moq", "Minimum order"],
  ["delivery", "Delivery"], ["sample", "Sample"], ["quality", "Quality"],
  ["supplier", "Supplier"], ["packaging", "Packaging"],
  ["design", "Design"], ["brand", "Brand"], ["other", "Other"],
];
const TOPIC_LABEL = new Map(TOPICS);

/* 001 defines these four. 'decided' additionally requires the detail field,
   which is why the form asks for it before letting you choose that status. */
const STATUSES = [
  ["proposed", "Still deciding"],
  ["decided", "Agreed"],
  ["superseded", "Replaced"],
  ["cancelled", "Dropped"],
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
  [/decisions_title_length/i,
   `Give the decision a short title, up to ${MAX_TITLE} characters. That is the one thing this needs.`],
  [/decisions_decided_state/i,
   "To mark this Agreed, write what was actually agreed in the detail box first."],
  [/decisions_status_allowed/i,
   "Pick one of the four states: Still deciding, Agreed, Replaced or Dropped."],
  [/decisions_topic_allowed/i,
   "Choose one of the listed topics."],
  [/decisions_counterparty_length/i,
   `Keep the supplier or factory name under ${MAX_NAME} characters.`],
  [/decisions_decided_by_name_length/i,
   `Keep the name under ${MAX_NAME} characters.`],
  [/decisions_lookbook_fk/i,
   "That Lookbook photo is no longer available, so it could not be linked."],
  [/decisions_workstream_fk/i,
   "That workstream no longer exists. Leave it unset and save again."],
  [/decisions_owner_fk/i,
   "That owner is not a member of this workspace."],
  [/violates row-level security|permission denied|42501/i,
   "You have view-only access, so this could not be saved. Ask Marco or Salman for edit access."],
  [/duplicate key/i,
   "That looks like it has already been saved."],
];

/* Exported so it can be tested without a DOM or a network, the same way Codex's
   work policy is. This is the function that decides whether Marco sees a
   sentence or a constraint name, so it should be the easiest thing here to
   write a test against. */
export function humanError(raw) {
  const text = String(raw?.message || raw || "");
  for (const [pattern, sentence] of CONSTRAINT_MESSAGES) {
    if (pattern.test(text)) return sentence;
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return "That did not reach the server. Check your connection and try again — nothing was lost.";
  }
  /* Deliberately not returning `text`. An unrecognised database error is still
     a database error, and showing it teaches people the Hub is broken. */
  return "That could not be saved. Nothing was lost — try again, and tell Salman if it keeps happening.";
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
  const listEl = $("#dc-list");
  const errEl = $("#dc-error");
  const sheet = $("#dc-sheet");

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

  document.addEventListener("keydown", onKey);
  const timer = setInterval(load, 60000);
  void load();

  return () => {
    clearInterval(timer);
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("hub-sheet-open");
    root.innerHTML = "";
    root.classList.remove("dc", "dc-readonly", "fs-scope");
  };

  /* ---------------------------------------------------------------- data */

  async function rest(path, options = {}) {
    if (c.mode !== "authed") throw new Error("Sign in to use Decisions.");
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
    if (c.mode !== "authed") { showError("Sign in to see decisions."); return; }
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
    if (!title) { fieldError("Write a short title first — that is all this needs to save."); return; }
    if (title.length > MAX_TITLE) { fieldError(`That title is ${title.length} characters. Keep it under ${MAX_TITLE}.`); return; }

    const status = safeEnum($("#dc-status").value, STATUSES.map(([v]) => v), "proposed");
    const detail = $("#dc-detail").value.trim();
    if (status === "decided" && !detail) {
      fieldError("To mark this Agreed, write what was actually agreed in the detail box.");
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
          ? "Nothing matches that."
          : (readOnly
              ? "No decisions recorded yet."
              : "No decisions yet. When something is agreed — a fabric, a price, a delivery date — record it here so it is not lost.")
      }</p>`;
      return;
    }
    listEl.innerHTML = rows.map(card).join("");
  }

  function card(it) {
    const when = whenText(it.decided_at || it.updated_at);
    const meta = [
      TOPIC_LABEL.get(it.topic) || "Other",
      it.counterparty ? `with ${esc(it.counterparty)}` : "",
      when,
    ].filter(Boolean);
    return `<button class="dc-card" data-id="${esc(it.id)}" type="button">
      <span class="dc-status dc-${esc(it.status)}">${esc(STATUS_LABEL.get(it.status) || it.status)}</span>
      <span class="dc-title">${esc(it.title)}</span>
      ${it.decision ? `<span class="dc-what">${esc(it.decision)}</span>` : ""}
      <span class="dc-meta">${meta.map(esc).join(" · ")}</span>
    </button>`;
  }

  /* --------------------------------------------------------------- sheet */

  function openSheet(item) {
    if (readOnly && !item) return;
    editing = item;
    $("#dc-heading").textContent = item ? "Decision" : "Record a decision";
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
    const chips = [["all", "All"], ...TOPICS]
      .map(([v, label]) => `<button class="dc-chip" data-topic="${v}" type="button">${label}</button>`)
      .join("");
    const topicOptions = TOPICS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    const statusOptions = STATUSES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

    return `
    <div class="dc-bar">
      <span class="dc-mark">Decisions<small>what we agreed, and with whom</small></span>
    </div>
    <p id="dc-error" class="dc-errbox" hidden></p>
    <input id="dc-search" class="dc-search" type="search" placeholder="Search decisions, suppliers, people" aria-label="Search decisions">
    <div id="dc-filters" class="dc-filters">${chips}</div>
    <div id="dc-list" class="dc-list"></div>
    ${readOnly ? "" : `<button id="dc-add" class="dc-add" type="button" aria-label="Record a decision">+</button>`}

    <div id="dc-sheet" class="dc-sheetwrap" role="dialog" aria-modal="true" aria-labelledby="dc-heading">
      <div class="dc-sheet">
        <button id="dc-close" class="dc-close" type="button" aria-label="Close">&times;</button>
        <h2 id="dc-heading" class="dc-h">Record a decision</h2>
        <form id="dc-form" class="dc-form">
          <label class="dc-lbl" for="dc-title">What was decided</label>
          <input id="dc-title" class="dc-input" type="text" maxlength="${MAX_TITLE}"
                 placeholder="280gsm French terry for the winter hoodie">
          <p class="dc-hint">This is the only thing you need. Everything else can wait.</p>

          <label class="dc-lbl" for="dc-topic">Topic</label>
          <select id="dc-topic" class="dc-input">${topicOptions}</select>

          <label class="dc-lbl" for="dc-status">State</label>
          <select id="dc-status" class="dc-input">${statusOptions}</select>

          <label class="dc-lbl" for="dc-detail">The detail</label>
          <textarea id="dc-detail" class="dc-input dc-area"
                    placeholder="Numbers, terms, what exactly was agreed"></textarea>

          <label class="dc-lbl" for="dc-counterparty">Agreed with</label>
          <input id="dc-counterparty" class="dc-input" type="text" maxlength="${MAX_NAME}"
                 placeholder="Factory or supplier name">

          <label class="dc-lbl" for="dc-by">Who agreed it</label>
          <input id="dc-by" class="dc-input" type="text" maxlength="${MAX_NAME}"
                 placeholder="Marco, Emiel, the factory manager">

          <label class="dc-lbl" for="dc-context">Why, or what it replaces</label>
          <textarea id="dc-context" class="dc-input dc-area"
                    placeholder="Optional background"></textarea>

          <p id="dc-formerror" class="dc-formerror" role="alert" hidden></p>

          <div class="dc-actions">
            <button id="dc-archive" class="dc-archive" type="button" hidden>Archive</button>
            <button id="dc-save" class="dc-savebtn" type="submit">Save decision</button>
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
