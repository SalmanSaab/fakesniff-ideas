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
  const el = document.createElement("div");
  el.className = "ilab";
  el.innerHTML = TEMPLATE;
  root.replaceChildren(el);
  injectStyles();

  const state = {
    ideas: [], triggers: [], activity: [],
    tab: "ideas",
    fStatus: "all", fRisk: "all",
    fTrigUsed: "unused", tQuery: "",
    searchTimer: null,
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
      const [ideas, triggers, activity] = await Promise.all([
        api(`ideas?select=*&order=id.desc${wsFilter()}`),
        api(`triggers?select=*&order=id.desc&limit=400${wsFilter()}`),
        api(`activity?select=*&order=at.desc&limit=60${wsFilter()}`).catch(() => []),
      ]);
      state.ideas = ideas || [];
      state.triggers = triggers || [];
      state.activity = activity || [];
      q(".ilab-err").replaceChildren();
      render();
    } catch (e) {
      showErr("could not reach the database. " + String(e.message || e).slice(0, 120));
    }
  }
  async function log(what, ideaId) {
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
    q("#ilab-c-trig").textContent = state.triggers.filter((t) => !t.used).length;
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
    const unused = state.triggers.filter((t) => !t.used).length;
    tf.innerHTML =
      `<button class="ilab-chip ${state.fTrigUsed === "unused" ? "on" : ""}" data-t="unused">not used ${unused}</button>
       <button class="ilab-chip ${state.fTrigUsed === "all" ? "on" : ""}" data-t="all">everything ${state.triggers.length}</button>`;
    tf.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { state.fTrigUsed = b.dataset.t; renderTriggers(); }));

    let list = state.fTrigUsed === "unused" ? state.triggers.filter((t) => !t.used) : state.triggers;
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
      <div class="ilab-trig ${t.used ? "used" : ""}">
        <div class="ilab-t">${esc(t.title)}
          <div class="ilab-s">${esc(t.source)} · ${esc(category)}
            ${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open</a>` : ""}</div>
        </div>
        <div class="ilab-btns">
          <button class="ilab-copyai" data-ai="${t.id}">copy for AI</button>
          <button class="ilab-mk" data-mk="${t.id}">write it myself</button>
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
      <button class="ilab-close">&times;</button>
      <div class="ilab-dline">${esc(i.line)}</div>
      ${i.concept ? `<div class="ilab-dconcept">${esc(i.concept)}</div>` : ""}
      <div class="ilab-shirts">
        <div class="ilab-shirtbox"><canvas id="ilab-sv-b"></canvas><span>black</span></div>
        <div class="ilab-shirtbox"><canvas id="ilab-sv-c"></canvas><span>cream</span></div>
      </div>
      ${i.sparked_by ? `<div class="ilab-src">sparked by: ${esc(i.sparked_by)}
        ${sourceUrl ? `<br><a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)}</a>` : ""}</div>` : ""}
      <div class="ilab-lbl">status</div>
      <div class="ilab-setline" id="ilab-setstatus">
        ${STATUSES.map((s) => `<button data-v="${s}" class="${i.status === s ? "on" : ""}">${s}</button>`).join("")}
      </div>
      <div class="ilab-lbl">risk</div>
      <div class="ilab-setline" id="ilab-setrisk">
        ${RISKS.map((r) => `<button data-v="${r}" class="${i.risk === r ? "on" : ""}">${r}</button>`).join("")}
      </div>
      <div class="ilab-src" style="margin-top:16px">
        added by ${esc(i.added_by || "—")}${i.updated_by ? ` · last touched by ${esc(i.updated_by)}` : ""}
      </div>`;
    q("#ilab-detail").classList.add("open");
    const sub = /^\(.*\)$/.test(i.concept || "") ? i.concept : "";
    drawShirt(q("#ilab-sv-b"), i.line, sub, "black");
    drawShirt(q("#ilab-sv-c"), i.line, sub, "cream");
    sheet.querySelector(".ilab-close").onclick = closeDetail;
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
  function closeDetail() { q("#ilab-detail").classList.remove("open"); }
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
      <button class="ilab-close">&times;</button>
      <div class="ilab-dline" style="font-size:20px">new idea</div>
      ${t ? `<div class="ilab-src" style="margin-top:10px">from: ${esc(t.title)}</div>` : ""}
      <form class="ilab-new" id="ilab-nf">
        <input name="line" placeholder="the line that goes on the shirt" required autocomplete="off">
        <textarea name="concept" placeholder="what you'd see, one sentence"></textarea>
        <div class="ilab-row">
          <select name="category">${CATS.map((c) => `<option ${t && t.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>
          <select name="risk">${RISKS.map((r) => `<option>${r}</option>`).join("")}</select>
        </div>
        <button type="submit">save</button>
      </form>`;
    q("#ilab-detail").classList.add("open");
    sheet.querySelector(".ilab-close").onclick = closeDetail;
    sheet.querySelector("#ilab-nf").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const row = stamp({
        line: f.get("line"), concept: f.get("concept") || "",
        category: f.get("category"), risk: f.get("risk"), status: "new",
        added_by: cfg.member.name,
        sparked_by: t ? `${t.source}: ${t.title.slice(0, 70)}` : "",
        source_url: t ? (t.url || "") : "",
      });
      try {
        await api("ideas", { method: "POST", body: JSON.stringify([row]) });
        if (t) await api(`triggers?id=eq.${t.id}${wsFilter()}`, { method: "PATCH", body: JSON.stringify({ used: true }) });
        log(`added "${String(row.line).slice(0, 40)}"`);
        closeDetail(); await load();
      } catch (e) { showErr("could not save. " + String(e.message || e).slice(0, 100)); }
    };
  }

  /* ----- how it works ----- */
  function showHow() {
    const sheet = q("#ilab-sheet");
    sheet.innerHTML = `
      <button class="ilab-close">&times;</button>
      <div class="ilab-how">
        <h3>What this is</h3>
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
    q("#ilab-detail").classList.add("open");
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
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
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
    <input id="ilab-tsearch" class="ilab-search" placeholder="search the raw material..." autocomplete="off">
    <div class="ilab-filters" id="ilab-tfilters"></div>
    <div id="ilab-triggers"></div>
  </section>
  <section id="ilab-tab-activity" hidden>
    <div id="ilab-activity"></div>
  </section>
  <button id="ilab-add" title="new idea">+</button>
  <div id="ilab-detail"><div class="ilab-sheet" id="ilab-sheet"></div></div>
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = ILAB_CSS;
  document.head.appendChild(s);
}

const ILAB_CSS = `
.ilab{--il-ink:#ece7dd;--il-mut:#8b8478;--il-line:#262523;--il-panel:#161615;--il-green:#77c566;--il-warn:#d8a24a;--il-bad:#c9564a;color:var(--il-ink);position:relative}
.ilab *{box-sizing:border-box}
.ilab-bar{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.ilab-mark{font-family:Georgia,serif;font-style:italic;font-size:21px;line-height:1}
.ilab-mark small{font-style:normal;font-family:inherit;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--il-mut);display:block;margin-top:3px}
#ilab-howbtn{background:none;border:1px solid var(--il-line);color:var(--il-mut);font-size:11px;padding:5px 10px;border-radius:20px;cursor:pointer;margin-left:auto}
#ilab-howbtn:hover{border-color:var(--il-green);color:var(--il-green)}
.ilab-tabs{display:flex;gap:2px;border-bottom:1px solid var(--il-line);margin-bottom:16px;overflow-x:auto}
.ilab-tabs button{background:none;border:none;border-bottom:2px solid transparent;color:var(--il-mut);padding:11px 12px;font-size:13px;cursor:pointer;white-space:nowrap;text-transform:uppercase;letter-spacing:.1em;font-weight:700}
.ilab-tabs button.on{color:var(--il-ink);border-bottom-color:var(--il-green)}
.ilab-count{color:var(--il-mut);font-weight:400;margin-left:5px}
.ilab-filters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}
.ilab-chip{background:transparent;border:1px solid var(--il-line);color:var(--il-mut);padding:6px 12px;border-radius:20px;font-size:12.5px;cursor:pointer}
.ilab-chip.on{border-color:var(--il-green);color:var(--il-green)}
.ilab-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.ilab-card{background:var(--il-panel);border:1px solid var(--il-line);border-radius:3px;padding:16px;cursor:pointer;transition:border-color .12s}
.ilab-card:hover{border-color:#3a3835}
.ilab-line{font-size:19px;font-weight:700;line-height:1.25;letter-spacing:-.01em}
.ilab-concept{color:var(--il-mut);font-size:13.5px;margin-top:8px;line-height:1.45}
.ilab-foot{display:flex;align-items:center;gap:8px;margin-top:13px;flex-wrap:wrap}
.ilab-tag{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;padding:3px 8px;border:1px solid var(--il-line);border-radius:2px;color:var(--il-mut)}
.ilab-tag.status{border-color:#3a3835;color:var(--il-ink)}
.ilab-tag.risk-check{border-color:var(--il-warn);color:var(--il-warn)}
.ilab-tag.risk-avoid{border-color:var(--il-bad);color:var(--il-bad)}
.ilab-by{margin-left:auto;font-size:11px;color:var(--il-mut)}
.ilab-search{width:100%;background:#0f0f0e;border:1px solid var(--il-line);color:var(--il-ink);padding:12px 14px;font-size:15px;border-radius:2px;margin-bottom:14px;font-family:inherit}
.ilab-search:focus{outline:none;border-color:var(--il-green)}
.ilab-trig{border-bottom:1px solid var(--il-line);padding:13px 2px;display:flex;gap:12px;align-items:flex-start}
.ilab-t{flex:1;font-size:14.5px;line-height:1.4}
.ilab-s{font-size:11px;color:var(--il-mut);margin-top:5px}
.ilab-s a{color:var(--il-green)}
.ilab-btns{display:flex;flex-direction:column;gap:6px}
.ilab-btns button{background:transparent;border:1px solid var(--il-line);color:var(--il-mut);padding:6px 11px;font-size:11.5px;cursor:pointer;white-space:nowrap;border-radius:2px}
.ilab-copyai{border-color:var(--il-green)!important;color:var(--il-green)!important}
.ilab-copyai:hover,.ilab-copyai.done{background:var(--il-green)!important;color:#0f0f0e!important}
.ilab-mk:hover{border-color:var(--il-ink);color:var(--il-ink)}
.ilab-trig.used{opacity:.4}
.ilab-act{border-bottom:1px solid var(--il-line);padding:11px 2px;font-size:13.5px;color:var(--il-mut)}
.ilab-act b{color:var(--il-ink);font-weight:600}
.ilab-act span{float:right;font-size:11px}
#ilab-add{position:sticky;float:right;bottom:18px;background:var(--il-green);color:#0f0f0e;border:none;width:54px;height:54px;border-radius:50%;font-size:28px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45);line-height:1}
.ilab-empty{color:var(--il-mut);text-align:center;padding:50px 20px;font-size:14.5px}
.ilab-errbox{background:#2a1a17;border:1px solid var(--il-bad);color:#e8a79e;padding:10px 13px;font-size:13px;margin-bottom:14px;border-radius:2px}
#ilab-detail{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.72);display:none;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto}
#ilab-detail.open{display:flex}
.ilab-sheet{background:var(--il-panel);border:1px solid var(--il-line);max-width:760px;width:100%;border-radius:4px;padding:24px;margin:auto;position:relative}
.ilab-dline{font-size:27px;font-weight:800;line-height:1.2}
.ilab-dconcept{color:var(--il-mut);margin:10px 0 0;line-height:1.5}
.ilab-src{margin-top:14px;font-size:12.5px;color:var(--il-mut);line-height:1.5}
.ilab-src a{color:var(--il-green);word-break:break-all}
.ilab-shirts{display:flex;gap:14px;margin:22px 0;flex-wrap:wrap}
.ilab-shirtbox{flex:1;min-width:200px;text-align:center}
.ilab-shirtbox canvas{width:100%;height:300px;display:block;background:#0b0b0a;border:1px solid var(--il-line)}
.ilab-shirtbox span{font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--il-mut);display:block;margin-top:7px}
.ilab-setline{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.ilab-setline button{background:transparent;border:1px solid var(--il-line);color:var(--il-mut);padding:8px 13px;font-size:12.5px;cursor:pointer;border-radius:2px}
.ilab-setline button:hover{border-color:var(--il-ink);color:var(--il-ink)}
.ilab-setline button.on{border-color:var(--il-green);color:var(--il-green)}
.ilab-lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--il-mut);margin:18px 0 0}
.ilab-close{position:absolute;top:14px;right:18px;background:none;border:none;color:var(--il-mut);font-size:26px;cursor:pointer;line-height:1}
.ilab-new{display:grid;gap:11px;margin-top:6px}
.ilab-new input,.ilab-new textarea,.ilab-new select{background:#0f0f0e;border:1px solid var(--il-line);color:var(--il-ink);padding:11px 12px;font-size:15px;border-radius:2px;font-family:inherit;width:100%}
.ilab-new textarea{min-height:70px;resize:vertical}
.ilab-row{display:flex;gap:10px}
.ilab-row>*{flex:1}
.ilab-new button{background:var(--il-green);color:#0f0f0e;border:none;padding:13px;font-size:15px;font-weight:700;cursor:pointer;border-radius:2px}
.ilab-how h3{font-size:19px;margin:0 0 4px}
.ilab-how p{color:var(--il-mut);font-size:14px;line-height:1.55;margin:0 0 16px}
.ilab-how ol{color:var(--il-mut);font-size:14px;line-height:1.7;padding-left:20px;margin:0 0 18px}
.ilab-how ol b{color:var(--il-ink)}
.ilab-rules{background:#0f0f0e;border:1px solid var(--il-line);padding:14px 16px;border-radius:2px;font-size:13.5px;color:var(--il-mut);line-height:1.6}
.ilab-rules b{color:var(--il-ink)}
`;
