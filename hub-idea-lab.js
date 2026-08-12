/* FAKESNIFF Hub — Idea Lab module.  Owner: Claude.
 *
 * The idea machine, living inside the authenticated hub. Self-contained: it
 * injects its own scoped styles and builds its own DOM inside whatever root
 * element it is handed, so it never collides with the hub shell (Codex).
 *
 * Integration contract (see COORDINATION.md). The hub calls:
 *     mount(rootEl, ctx)
 * where ctx = {
 *     restUrl:        "https://<proj>.supabase.co/rest/v1"
 *     getAccessToken: async () => "<signed-in user JWT>"   // authed reads/writes
 *     member:         { id, name, role }
 *     workspaceId:    "<uuid>"                              // rows scoped to workspace
 * }
 * If ctx is omitted it runs standalone against the current (pre-migration)
 * ideas/triggers tables with the public anon key, so it is testable today and
 * snaps into the hub the moment the hook lands.
 */

const STANDALONE = {
  restUrl: "https://kayxejofqyxoqlberrgw.supabase.co/rest/v1",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtheXhlam9m" +
    "cXl4b3FsYmVycmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzMDg0NDQsImV4cCI6MjEwMTg4NDQ0NH0." +
    "LFTOsUpdi7Bu9kibW1qYWYcRSLGnF-mWtDlNMYiJe2E",
};

const STATUSES = ["new", "interesting", "needs work", "develop", "rejected", "in production"];
const CATS = ["music", "film", "tv", "icons", "social", "tech", "sport",
              "travel", "art", "news", "youth", "other"];
const RISKS = ["clean", "check", "avoid"];

const BRIEF = `You are writing a line for a Fakesniff t-shirt.

THE BRAND
Nothing is real. Every high we chase to feel like we're winning - money, status, the perfect
image, the online life - is fake. Fakesniff names the fake and says it with a straight face.

VOICE
- dry, deadpan, a bit tired. never excited, never hype, no exclamation marks
- short. readable in one glance. eight words at most
- lowercase leaning
- in on the joke, not above it. we are also faking it
- funny without trying to be funny

A GOOD LINE
- says the quiet part out loud
- works instantly, but rewards a second read
- someone could wear it in public without having to explain it
- specific. "everything is fake" is the category, not an idea

AVOID
- anything that sounds like a motivational quote
- anything that needs the brand explained first
- puns for the sake of puns

THE HARD RULE
Take the feeling or the idea. Never the title, the character, the artwork, the logo or the quote.
Take the shape of the thing, not the thing.

GIVE ME
5 options. For each one:
- the line (what goes on the shirt)
- the concept (one sentence on what you'd see)
- risk: clean if fully original / check if it leans on something real / avoid if it uses a real
  name, title, character, logo or quote`;

/* ---------- small helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeEnum = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
function safeHttpUrl(value) {
  if (!value) return "";
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.href : "";
  } catch { return ""; }
}

/* ---------- module ---------- */
export function mount(root, ctx) {
  const cfg = normaliseCtx(ctx);
  const canEdit = cfg.member.role !== "viewer";   // viewers get a read-only board
  const el = document.createElement("div");
  el.className = "ilab" + (canEdit ? "" : " ilab-readonly");
  el.innerHTML = TEMPLATE;
  root.replaceChildren(el);
  injectStyles();
  if (!canEdit) { const add = el.querySelector("#ilab-add"); if (add) add.hidden = true; }

  const state = {
    ideas: [], triggers: [], activity: [],
    tab: "ideas",
    fStatus: "all", fRisk: "all",
    fTrigUsed: "unused", tQuery: "",
    searchTimer: null,
    usedTriggerIds: null,
  };

  const q = (sel) => el.querySelector(sel);
  const shirtCache = {};

  /* ----- data layer (adapts to authed hub or standalone) ----- */
  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (cfg.mode === "authed") {
      const token = await cfg.getAccessToken();
      headers.apikey = cfg.anonKey || "";
      headers.Authorization = "Bearer " + token;
    } else {
      headers.apikey = cfg.anonKey;
      headers.Authorization = "Bearer " + cfg.anonKey;
    }
    const r = await fetch(cfg.restUrl + "/" + path, { ...opts, headers });
    const body = await r.text();
    if (!r.ok) throw new Error(body || r.status);
    return body ? JSON.parse(body) : null;
  }
  const wsFilter = () => (cfg.workspaceId ? `&workspace_id=eq.${cfg.workspaceId}` : "");
  const stamp = (row) => (cfg.workspaceId ? { ...row, workspace_id: cfg.workspaceId } : row);

  async function load() {
    try {
      const authed = cfg.mode === "authed";
      // After migration 001 the legacy `activity` table is no longer written by
      // clients: the database generates audit rows into `activity_events`.
      const feedPath = authed
        ? `activity_events?select=*&order=occurred_at.desc&limit=60${wsFilter()}`
        : `activity?select=*&order=at.desc&limit=60${wsFilter()}`;
      const [ideas, triggers, feed, members] = await Promise.all([
        api(`ideas?select=*&order=id.desc${wsFilter()}`),
        api(`triggers?select=*&order=id.desc&limit=400${wsFilter()}`),
        api(feedPath).catch(() => []),
        authed ? api(`members?select=user_id,display_name${wsFilter()}`).catch(() => []) : [],
      ]);
      state.ideas = ideas || [];
      state.triggers = triggers || [];
      state.activity = normaliseFeed(feed || [], members || [], authed);
      // Authenticated members cannot write `triggers.used` (raw triggers are
      // scanner-owned), so "used" is derived from ideas that reference them.
      state.usedTriggerIds = authed
        ? new Set(state.ideas.map((i) => i.trigger_id).filter((v) => v != null))
        : null;
      q(".ilab-err").replaceChildren();
      render();
    } catch (e) {
      showErr("could not reach the database. " + String(e.message || e).slice(0, 120));
    }
  }
  const isUsed = (t) =>
    state.usedTriggerIds ? state.usedTriggerIds.has(t.id) : !!t.used;

  function normaliseFeed(rows, members, authed) {
    if (!authed) return rows;
    const names = new Map(members.map((m) => [m.user_id, m.display_name]));
    return rows.map((r) => {
      const d = r.event_data || {};
      // legacy rows copied by migration 001 already carry who/what
      if (d.who || d.what) return { who: d.who || "someone", what: d.what || "", at: r.occurred_at };
      const verb = { insert: "added", update: "updated", delete: "removed" }[r.action] || r.action;
      const thing = String(r.entity_type || "record").replace(/s$/, "");
      return { who: names.get(r.actor_id) || "someone", what: `${verb} a ${thing}`, at: r.occurred_at };
    });
  }

  async function log(what, ideaId) {
    // In the hub the database writes the audit trail itself, and authenticated
    // users have no insert grant on the legacy table. Only log standalone.
    if (cfg.mode === "authed") return;
    try { await api("activity", { method: "POST",
      body: JSON.stringify([stamp({ who: cfg.member.name, what, idea_id: ideaId ?? null })]) }); }
    catch { /* activity is best-effort */ }
  }
  function showErr(m) {
    const host = q(".ilab-err");
    const d = document.createElement("div");
    d.className = "ilab-errbox";
    d.textContent = String(m || "something went wrong");
    host.replaceChildren(d);
  }

  /* ----- shirt preview ----- */
  function shirtImage(mode) {
    if (shirtCache[mode]) return shirtCache[mode];
    const im = new Image();
    im.src = mode === "cream" ? "shirt-cream.jpg" : "shirt-black.jpg";
    shirtCache[mode] = im;
    return im;
  }
  shirtImage("black"); shirtImage("cream");

  function wrap(cx, text, max) {
    const out = []; let line = "";
    for (const w of String(text).split(/\s+/)) {
      const t = line ? line + " " + w : w;
      if (cx.measureText(t).width > max && line) { out.push(line); line = w; }
      else line = t;
    }
    if (line) out.push(line);
    return out;
  }
  function drawShirt(cv, line, sub, mode) {
    const C = mode === "cream"
      ? { ink: "#17140f", sub: "#6c6559", bg: "#efe9e2" }
      : { ink: "#ece7dd", sub: "#9a948a", bg: "#f2ebe4" };
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 260, h = cv.clientHeight || 300;
    cv.width = w * dpr; cv.height = h * dpr;
    const x = cv.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
    const img = shirtImage(mode);
    const paint = () => {
      const s = Math.max(w / img.width, h / img.height);
      const dw = img.width * s, dh = img.height * s;
      x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      const max = w * 0.42;
      let size = Math.round(w * 0.068), lines;
      for (; size > 7; size--) {
        x.font = `800 ${size}px "Arial Narrow","Helvetica Neue",Arial,sans-serif`;
        lines = wrap(x, line, max);
        if (lines.length * size * 1.06 <= h * 0.19) break;
      }
      x.fillStyle = C.ink; x.textAlign = "center"; x.textBaseline = "top";
      let y = h * 0.30;
      for (const l of lines) { x.fillText(l, w / 2, y); y += size * 1.06; }
      if (sub) {
        const ss = Math.max(8, Math.round(size * 0.55));
        x.font = `italic ${ss}px Georgia,serif`; x.fillStyle = C.sub;
        for (const l of wrap(x, sub, max)) { x.fillText(l, w / 2, y + ss * 0.35); y += ss * 1.25; }
      }
      x.font = `italic ${Math.max(7, Math.round(size * 0.44))}px Georgia,serif`;
      x.fillStyle = C.sub; x.fillText("fakesniff.", w / 2, h * 0.62);
    };
    if (img.complete && img.naturalWidth) paint(); else img.onload = paint;
  }

  /* ----- render ----- */
  function render() {
    q("#ilab-c-ideas").textContent = state.ideas.length;
    q("#ilab-c-trig").textContent = state.triggers.filter((t) => !isUsed(t)).length;
    renderFilters(); renderIdeas(); renderTriggers(); renderActivity();
  }
  function renderFilters() {
    const counts = {}; STATUSES.forEach((s) => (counts[s] = state.ideas.filter((i) => i.status === s).length));
    const flagged = state.ideas.filter((i) => i.risk !== "clean").length;
    const f = q("#ilab-filters");
    f.innerHTML =
      `<button class="ilab-chip ${state.fStatus === "all" ? "on" : ""}" data-s="all">all ${state.ideas.length}</button>` +
      STATUSES.filter((s) => counts[s]).map((s) =>
        `<button class="ilab-chip ${state.fStatus === s ? "on" : ""}" data-s="${s}">${s} ${counts[s]}</button>`).join("") +
      (flagged ? `<button class="ilab-chip ${state.fRisk === "flagged" ? "on" : ""}" data-r="flagged">flagged ${flagged}</button>` : "");
    f.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { state.fStatus = b.dataset.s; state.fRisk = "all"; render(); }));
    const rb = f.querySelector("[data-r]");
    if (rb) rb.onclick = () => { state.fRisk = state.fRisk === "flagged" ? "all" : "flagged"; state.fStatus = "all"; render(); };
  }
  function visible() {
    return state.ideas.filter((i) =>
      (state.fStatus === "all" || i.status === state.fStatus) &&
      (state.fRisk !== "flagged" || i.risk !== "clean"));
  }
  function renderIdeas() {
    const host = q("#ilab-ideas");
    const list = visible();
    if (!list.length) { host.innerHTML = `<div class="ilab-empty">nothing here</div>`; return; }
    host.innerHTML = list.map((i) => {
      const status = safeEnum(i.status, STATUSES, "new");
      const category = safeEnum(i.category, CATS, "other");
      const risk = safeEnum(i.risk, RISKS, "check");
      return `
      <div class="ilab-card" data-id="${i.id}">
        <div class="ilab-line">${esc(i.line)}</div>
        ${i.concept ? `<div class="ilab-concept">${esc(i.concept)}</div>` : ""}
        <div class="ilab-foot">
          <span class="ilab-tag status">${esc(status)}</span>
          <span class="ilab-tag">${esc(category)}</span>
          ${risk !== "clean" ? `<span class="ilab-tag risk-${risk}">${esc(risk)}</span>` : ""}
          ${i.added_by ? `<span class="ilab-by">${esc(i.added_by)}</span>` : ""}
        </div>
      </div>`;
    }).join("");
    host.querySelectorAll(".ilab-card").forEach((c) => (c.onclick = () => openIdea(+c.dataset.id)));
  }
  function renderTriggers() {
    const host = q("#ilab-triggers");
    const tf = q("#ilab-tfilters");
    const unused = state.triggers.filter((t) => !isUsed(t)).length;
    tf.innerHTML =
      `<button class="ilab-chip ${state.fTrigUsed === "unused" ? "on" : ""}" data-t="unused">not used ${unused}</button>
       <button class="ilab-chip ${state.fTrigUsed === "all" ? "on" : ""}" data-t="all">everything ${state.triggers.length}</button>`;
    tf.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { state.fTrigUsed = b.dataset.t; renderTriggers(); }));

    let list = state.fTrigUsed === "unused" ? state.triggers.filter((t) => !isUsed(t)) : state.triggers;
    if (state.tQuery) {
      const s = state.tQuery.toLowerCase();
      list = list.filter((t) =>
        t.title.toLowerCase().includes(s) ||
        (t.source || "").toLowerCase().includes(s) ||
        (t.category || "").toLowerCase().includes(s));
    }
    host.innerHTML = list.slice(0, 150).map((t) => {
      const category = safeEnum(t.category, CATS, "other");
      const url = safeHttpUrl(t.url);
      return `
      <div class="ilab-trig ${isUsed(t) ? "used" : ""}">
        <div class="ilab-t">${esc(t.title)}
          <div class="ilab-s">${esc(t.source)} · ${esc(category)}
            ${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open</a>` : ""}</div>
        </div>
        <div class="ilab-btns">
          <button class="ilab-copyai" data-ai="${t.id}">copy for AI</button>
          ${canEdit ? `<button class="ilab-mk" data-mk="${t.id}">write it myself</button>` : ""}
        </div>
      </div>`;
    }).join("") || `<div class="ilab-empty">${state.tQuery ? "nothing matches \"" + esc(state.tQuery) + "\"" : "nothing collected yet"}</div>`;
    host.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = () => newIdea(+b.dataset.mk)));
    host.querySelectorAll("[data-ai]").forEach((b) => (b.onclick = () => copyForAI(+b.dataset.ai, b)));
  }
  function renderActivity() {
    const host = q("#ilab-activity");
    host.innerHTML = state.activity.length ? state.activity.map((a) => `
      <div class="ilab-act"><b>${esc(a.who)}</b> ${esc(a.what)}
        <span>${new Date(a.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
    `).join("") : `<div class="ilab-empty">nothing yet</div>`;
  }

  /* ----- idea detail ----- */
  function openIdea(id) {
    const i = state.ideas.find((x) => x.id === id); if (!i) return;
    const sheet = q("#ilab-sheet");
    const sourceUrl = safeHttpUrl(i.source_url);
    sheet.innerHTML = `
      <button class="ilab-close" aria-label="Close">&times;</button>
      <h2 class="ilab-dline" id="ilab-detail-title">${esc(i.line)}</h2>
      ${i.concept ? `<div class="ilab-dconcept">${esc(i.concept)}</div>` : ""}
      <div class="ilab-shirts">
        <div class="ilab-shirtbox"><canvas id="ilab-sv-b"></canvas><span>black</span></div>
        <div class="ilab-shirtbox"><canvas id="ilab-sv-c"></canvas><span>cream</span></div>
      </div>
      ${i.sparked_by ? `<div class="ilab-src">sparked by: ${esc(i.sparked_by)}
        ${sourceUrl ? `<br><a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)}</a>` : ""}</div>` : ""}
      ${canEdit ? `
      <div class="ilab-lbl">status</div>
      <div class="ilab-setline" id="ilab-setstatus">
        ${STATUSES.map((s) => `<button data-v="${s}" class="${i.status === s ? "on" : ""}">${s}</button>`).join("")}
      </div>
      <div class="ilab-lbl">risk</div>
      <div class="ilab-setline" id="ilab-setrisk">
        ${RISKS.map((r) => `<button data-v="${r}" class="${i.risk === r ? "on" : ""}">${r}</button>`).join("")}
      </div>` : `
      <div class="ilab-lbl">status</div><div class="ilab-src">${esc(i.status)}${i.risk !== "clean" ? ` · risk: ${esc(i.risk)}` : ""}</div>`}
      <div class="ilab-src ilab-mt16">
        added by ${esc(i.added_by || "—")}${i.updated_by ? ` · last touched by ${esc(i.updated_by)}` : ""}
      </div>`;
    openSheet("ilab-detail-title");
    const sub = /^\(.*\)$/.test(i.concept || "") ? i.concept : "";
    drawShirt(q("#ilab-sv-b"), i.line, sub, "black");
    drawShirt(q("#ilab-sv-c"), i.line, sub, "cream");
    sheet.querySelector(".ilab-close").onclick = closeDetail;
    if (canEdit) {
      sheet.querySelectorAll("#ilab-setstatus button").forEach((b) => (b.onclick = async () => {
        await update(i.id, { status: b.dataset.v, updated_by: cfg.member.name });
        log(`marked "${i.line.slice(0, 40)}" as ${b.dataset.v}`, i.id);
        closeDetail(); await load();
      }));
      sheet.querySelectorAll("#ilab-setrisk button").forEach((b) => (b.onclick = async () => {
        await update(i.id, { risk: b.dataset.v, updated_by: cfg.member.name });
        log(`flagged "${i.line.slice(0, 40)}" as ${b.dataset.v}`, i.id);
        closeDetail(); await load();
      }));
    }
  }
  /* ----- modal: focus trap, restore, and dialog semantics -----
     Keyboard and screen-reader users must not be able to tab out of an open
     sheet into the page behind it, and focus must come back where it started. */
  let lastFocused = null;
  const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

  function openSheet(labelledById) {
    const detail = q("#ilab-detail");
    const sheet = q("#ilab-sheet");
    lastFocused = document.activeElement;
    detail.classList.add("open");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    if (labelledById) sheet.setAttribute("aria-labelledby", labelledById);
    else sheet.removeAttribute("aria-labelledby");
    const first = sheet.querySelector(FOCUSABLE);
    (first || sheet).focus?.();
  }

  function trapFocus(e) {
    const detail = q("#ilab-detail");
    if (e.key !== "Tab" || !detail.classList.contains("open")) return;
    const items = [...q("#ilab-sheet").querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function closeDetail() {
    const detail = q("#ilab-detail");
    if (!detail.classList.contains("open")) return;
    detail.classList.remove("open");
    q("#ilab-sheet").removeAttribute("aria-busy");
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
  }
  async function update(id, patch) {
    try { await api(`ideas?id=eq.${id}${wsFilter()}`, { method: "PATCH", body: JSON.stringify(patch) }); }
    catch (e) { showErr("could not save. " + String(e.message || e).slice(0, 100)); }
  }

  /* ----- copy for AI ----- */
  async function copyForAI(triggerId, btn) {
    const t = state.triggers.find((x) => x.id === triggerId); if (!t) return;
    const text = `${BRIEF}\n\nWHAT SPARKED THIS\n"${t.title}"\nsource: ${t.source}${t.url ? "\n" + t.url : ""}`;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; el.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    const was = btn.textContent;
    btn.textContent = "copied, now paste it into an AI";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = was; btn.classList.remove("done"); }, 2600);
  }

  /* ----- new idea ----- */
  function newIdea(triggerId) {
    const t = triggerId ? state.triggers.find((x) => x.id === triggerId) : null;
    const sheet = q("#ilab-sheet");
    sheet.innerHTML = `
      <button class="ilab-close" aria-label="Close">&times;</button>
      <h2 class="ilab-dline ilab-dline-sm" id="ilab-sheet-title">New idea</h2>
      ${t ? `<div class="ilab-src ilab-mt10">from: ${esc(t.title)}</div>` : ""}
      <form class="ilab-new" id="ilab-nf">
        <label class="ilab-flabel" for="ilab-f-line">The line that goes on the shirt</label>
        <input id="ilab-f-line" name="line" required autocomplete="off" maxlength="240">
        <label class="ilab-flabel" for="ilab-f-concept">What you would see, one sentence</label>
        <textarea id="ilab-f-concept" name="concept"></textarea>
        <div class="ilab-row">
          <div>
            <label class="ilab-flabel" for="ilab-f-cat">Category</label>
            <select id="ilab-f-cat" name="category">${CATS.map((c) => `<option ${t && t.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>
          </div>
          <div>
            <label class="ilab-flabel" for="ilab-f-risk">Risk</label>
            <select id="ilab-f-risk" name="risk">${RISKS.map((r) => `<option>${r}</option>`).join("")}</select>
          </div>
        </div>
        <button type="submit" id="ilab-save">Save idea</button>
      </form>`;
    openSheet("ilab-sheet-title");
    sheet.querySelector(".ilab-close").onclick = closeDetail;

    let saving = false;                       // guards against double submit
    sheet.querySelector("#ilab-nf").onsubmit = async (ev) => {
      ev.preventDefault();
      if (saving) return;
      const btn = sheet.querySelector("#ilab-save");
      const f = new FormData(ev.target);
      const line = String(f.get("line") || "").trim();
      if (!line) return;

      const row = stamp({
        line, concept: f.get("concept") || "",
        category: f.get("category"), risk: f.get("risk"), status: "new",
        added_by: cfg.member.name,
        sparked_by: t ? `${t.source}: ${t.title.slice(0, 70)}` : "",
        source_url: t ? (t.url || "") : "",
      });
      // One write, not two. In the hub the link to the trigger lives on the idea
      // itself (`trigger_id`), because authenticated users cannot patch
      // `triggers.used`. That also removes the old partial-failure window where
      // the idea saved but the trigger update did not.
      if (t && cfg.mode === "authed") row.trigger_id = t.id;

      saving = true;
      btn.disabled = true; btn.textContent = "Saving…";
      sheet.setAttribute("aria-busy", "true");
      try {
        await api("ideas", { method: "POST", body: JSON.stringify([row]) });
        if (t && cfg.mode !== "authed") {
          await api(`triggers?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ used: true }) });
        }
        log(`added "${line.slice(0, 40)}"`);
        closeDetail(); await load();
      } catch (e) {
        showErr("could not save. " + String(e.message || e).slice(0, 100));
        saving = false;
        btn.disabled = false; btn.textContent = "Save idea";
        sheet.removeAttribute("aria-busy");
      }
    };
  }

  /* ----- how it works ----- */
  function showHow() {
    const sheet = q("#ilab-sheet");
    sheet.innerHTML = `
      <button class="ilab-close" aria-label="Close">&times;</button>
      <div class="ilab-how">
        <h3 id="ilab-how-title">What this is</h3>
        <p>A machine collects what is happening in film, music, tv, culture and the internet every
           morning. That is the raw material. We turn the good bits into lines for shirts. It
           collects everything and judges nothing, we do the filtering.</p>
        <h3>What to do</h3>
        <ol>
          <li><b>Raw material</b> — scroll. Something will spark an idea.</li>
          <li><b>Copy for AI</b> — one click puts the trigger plus our house rules on your clipboard.
              Paste into any assistant, it writes lines in our voice, paste the good ones back here.</li>
          <li><b>Ideas</b> — open one to see it on a shirt, then mark it interesting, develop or rejected.</li>
        </ol>
        <p><b>Nothing gets deleted.</b> Rejected stays rejected, so the same idea does not come back.</p>
        <h3>The one hard rule</h3>
        <div class="ilab-rules">Take the <b>feeling</b> or the <b>idea</b>. Never the title, the
          character, the artwork, the logo or the quote. If a line leans on something real, mark it
          <b>check</b> so the lawyer sees it before we produce anything.</div>
      </div>`;
    openSheet("ilab-how-title");
    sheet.querySelector(".ilab-close").onclick = closeDetail;
  }

  /* ----- chrome ----- */
  el.querySelectorAll(".ilab-nav button").forEach((b) => (b.onclick = () => {
    el.querySelectorAll(".ilab-nav button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    ["ideas", "triggers", "activity"].forEach((t) =>
      (q("#ilab-tab-" + t).hidden = t !== b.dataset.tab));
  }));
  q("#ilab-add").onclick = () => newIdea(null);
  q("#ilab-howbtn").onclick = showHow;
  q("#ilab-detail").onclick = (e) => { if (e.target.id === "ilab-detail") closeDetail(); };
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
    else trapFocus(e);
  });
  q("#ilab-tsearch").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const v = e.target.value;
    state.searchTimer = setTimeout(() => { state.tQuery = v.trim(); renderTriggers(); }, 160);
  });

  load();
  const timer = setInterval(load, 30000);
  return { destroy() { clearInterval(timer); root.replaceChildren(); } };
}

/* ---------- ctx normalisation ---------- */
function normaliseCtx(ctx) {
  if (ctx && ctx.restUrl && typeof ctx.getAccessToken === "function") {
    return {
      mode: "authed",
      restUrl: ctx.restUrl.replace(/\/$/, ""),
      getAccessToken: ctx.getAccessToken,
      anonKey: ctx.anonKey || "",
      member: ctx.member || { name: "member" },
      workspaceId: ctx.workspaceId || "",
    };
  }
  // standalone fallback — current schema, anon key, browser-picked name
  let name = "";
  try { name = localStorage.getItem("fs_who") || ""; } catch {}
  return {
    mode: "standalone",
    restUrl: STANDALONE.restUrl,
    anonKey: STANDALONE.anonKey,
    member: { name: name || "guest" },
    workspaceId: "",
  };
}

/* ---------- register with the hub shell if present ---------- */
if (typeof window !== "undefined") {
  window.HubIdeaLab = { mount };
  if (window.Hub && typeof window.Hub.registerSection === "function") {
    window.Hub.registerSection("idea-lab", { mount });
  }
}

/* ---------- template + styles (scoped under .ilab) ---------- */
const TEMPLATE = `
  <div class="ilab-bar">
    <div class="ilab-mark">idea lab<small>the machine</small></div>
    <button id="ilab-howbtn">how this works</button>
  </div>
  <div class="ilab-tabs ilab-nav">
    <button data-tab="ideas" class="on">Ideas <span class="ilab-count" id="ilab-c-ideas"></span></button>
    <button data-tab="triggers">Raw material <span class="ilab-count" id="ilab-c-trig"></span></button>
    <button data-tab="activity">Activity</button>
  </div>
  <div class="ilab-err"></div>
  <section id="ilab-tab-ideas">
    <div class="ilab-filters" id="ilab-filters"></div>
    <div class="ilab-grid" id="ilab-ideas"></div>
  </section>
  <section id="ilab-tab-triggers" hidden>
    <label class="ilab-sr" for="ilab-tsearch">Search the raw material</label>
    <input id="ilab-tsearch" class="ilab-search" type="search" placeholder="search the raw material..." autocomplete="off">
    <div class="ilab-filters" id="ilab-tfilters"></div>
    <div id="ilab-triggers"></div>
  </section>
  <section id="ilab-tab-activity" hidden>
    <div id="ilab-activity"></div>
  </section>
  <button id="ilab-add" type="button" title="New idea" aria-label="New idea">+</button>
  <div id="ilab-detail"><div class="ilab-sheet" id="ilab-sheet" tabindex="-1"></div></div>
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  // External same-origin stylesheet, so it satisfies the hub CSP (style-src 'self').
  // Resolve the href relative to this module so it works from any host page.
  if (document.querySelector('link[data-ilab-styles]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-ilab-styles", "");
  link.href = new URL("hub-idea-lab.css", import.meta.url).href;
  document.head.appendChild(link);
}
