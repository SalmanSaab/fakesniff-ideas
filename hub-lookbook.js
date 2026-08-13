/* FAKESNIFF Hub — Lookbook module.  Owner: Claude.
 *
 * Emiel's "container": a visual reference library. Photograph a hoodie, a
 * fabric, a detail you liked, or paste a link. Add a note if you want. It files
 * itself and stays searchable.
 *
 * Design rule, from the first-use session: adding something must be faster than
 * sending it to WhatsApp, or it will not get used. Capture is one tap; every
 * other field is optional and can be filled in later.
 *
 * Same integration contract as hub-idea-lab.js — see COORDINATION.md.
 *   mount(rootEl, ctx)  where ctx = { restUrl, getAccessToken, anonKey, member, workspaceId }
 */

const CATEGORIES = [
  "unsorted",
  "tee", "hoodie", "sweat", "longsleeve", "jacket", "knit", "trousers",
  "headwear", "accessory",
  "print", "graphic", "typography", "colour", "fabric", "detail", "fit",
  "packaging", "campaign", "store", "other",
];

/* Grouped for the filter bar so twenty categories don't read as a wall. */
const CATEGORY_GROUPS = [
  { label: "Garments", items: ["tee", "hoodie", "sweat", "longsleeve", "jacket", "knit", "trousers", "headwear", "accessory"] },
  { label: "Design",   items: ["print", "graphic", "typography", "colour", "fabric", "detail", "fit"] },
  { label: "Around it", items: ["packaging", "campaign", "store"] },
];

const BUCKET = "lookbook";
const MAX_BYTES = 25 * 1024 * 1024;

/* The brief used by "ask an AI about this", mirroring Idea Lab's copy-for-AI.
   Free route: the person pastes it into whatever assistant they already pay
   for. When an API key exists this same text drives the automatic pass. */
const ANALYSE_BRIEF = `Look at this clothing or material reference and describe it for a small streetwear brand's design library.

Give me:
- what the item is (t-shirt, hoodie, fabric swatch, print detail, packaging, ...)
- the fabric or material, if you can tell
- the fit or cut
- the colours, named plainly
- construction or finishing details worth noticing (seams, ribbing, hardware, print method)
- three to six short tags we could file it under

Be concrete and factual. Describe what is actually there, not what it evokes.
Do not guess a brand. If something is unclear from the photo, say so rather than inventing it.`;

/* ---------- helpers ---------- */
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
const shortHost = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

/* ---------- module ---------- */
export function mount(root, ctx) {
  const cfg = normaliseCtx(ctx);
  const canEdit = cfg.member.role !== "viewer";
  const el = document.createElement("div");
  el.className = "lb" + (canEdit ? "" : " lb-readonly");
  el.innerHTML = TEMPLATE;
  root.replaceChildren(el);
  injectStyles();

  const state = {
    items: [], fCategory: "all", query: "", searchTimer: null,
    urls: new Map(),        // item id -> signed image URL
    lastFocused: null,
  };
  const q = (sel) => el.querySelector(sel);

  /* ----- api ----- */
  async function authHeaders(extra = {}) {
    const h = { ...extra };
    if (cfg.mode === "authed") {
      const token = await cfg.getAccessToken();
      h.apikey = cfg.anonKey || "";
      h.Authorization = "Bearer " + token;
    } else {
      h.apikey = cfg.anonKey;
      h.Authorization = "Bearer " + cfg.anonKey;
    }
    return h;
  }
  async function api(path, opts = {}) {
    const headers = await authHeaders({ "Content-Type": "application/json", ...(opts.headers || {}) });
    const r = await fetch(cfg.restUrl + "/" + path, { ...opts, headers });
    const body = await r.text();
    if (!r.ok) throw new Error(body || r.status);
    return body ? JSON.parse(body) : null;
  }
  const wsFilter = () => (cfg.workspaceId ? `&workspace_id=eq.${cfg.workspaceId}` : "");
  const stamp = (row) => (cfg.workspaceId ? { ...row, workspace_id: cfg.workspaceId } : row);

  /* Images live in a private bucket, so they cannot be loaded by plain URL.
   *
   * Claude — 2026-08-13: this is deliberately belt and braces, because getting
   * a photo on screen is the entire point of the Lookbook and it has failed
   * twice for two different reasons already. First the CSP blocked the storage
   * host; then signing produced nothing usable.
   *
   * Route 1 asks Storage for a short-lived signed URL. The REST API has
   * returned that field as both `signedURL` and `signedUrl` across versions,
   * so accept either rather than depending on which one this project speaks.
   *
   * Route 2, if that produced nothing, fetches the bytes with the same auth
   * header everything else uses and hands the browser a blob. Slower and it
   * holds the image in memory, but it works whenever the person is allowed to
   * read the object at all — no separate signing step to go wrong.
   */
  async function signedUrl(path) {
    const headers = await authHeaders({ "Content-Type": "application/json" });
    try {
      const r = await fetch(`${cfg.storageUrl}/object/sign/${BUCKET}/${encodeURI(path)}`, {
        method: "POST", headers, body: JSON.stringify({ expiresIn: 3600 }),
      });
      if (r.ok) {
        const body = await r.json();
        const signed = body.signedURL || body.signedUrl || "";
        if (signed) {
          const origin = cfg.storageUrl.replace(/\/storage\/v1$/, "");
          /* the field has been returned both with and without the /storage/v1
             prefix, so normalise instead of assuming */
          return signed.startsWith("http")
            ? signed
            : origin + (signed.startsWith("/storage/v1") ? "" : "/storage/v1") + signed;
        }
        console.warn("lookbook: sign returned no url", JSON.stringify(body).slice(0, 200));
      } else {
        console.warn("lookbook: sign failed", r.status, (await r.text().catch(() => "")).slice(0, 200));
      }
    } catch (e) {
      console.warn("lookbook: sign threw", String(e).slice(0, 160));
    }
    return await blobUrl(path);
  }

  async function blobUrl(path) {
    try {
      const headers = await authHeaders();
      const r = await fetch(`${cfg.storageUrl}/object/${BUCKET}/${encodeURI(path)}`, { headers });
      if (!r.ok) {
        console.warn("lookbook: direct fetch failed", r.status, (await r.text().catch(() => "")).slice(0, 200));
        return "";
      }
      return URL.createObjectURL(await r.blob());
    } catch (e) {
      console.warn("lookbook: direct fetch threw", String(e).slice(0, 160));
      return "";
    }
  }

  async function load() {
    try {
      const items = await api(
        `lookbook_items?select=*&archived_at=is.null&order=created_at.desc&limit=300${wsFilter()}`);
      state.items = items || [];
      q(".lb-err").replaceChildren();
      render();
      hydrateImages();
    } catch (e) {
      showErr("could not load the lookbook. " + String(e.message || e).slice(0, 120));
    }
  }

  /* Sign image URLs after the grid paints, so the page appears immediately. */
  async function hydrateImages() {
    for (const it of state.items) {
      if (!it.storage_path || state.urls.has(it.id)) continue;
      const url = await signedUrl(it.storage_path);
      if (!url) continue;
      state.urls.set(it.id, url);
      const img = q(`img[data-for="${it.id}"]`);
      if (img) { img.src = url; img.classList.remove("lb-loading"); }
    }
  }

  function showErr(m) {
    const host = q(".lb-err");
    const d = document.createElement("div");
    d.className = "lb-errbox";
    d.textContent = String(m || "something went wrong");
    host.replaceChildren(d);
  }

  /* ----- render ----- */
  function render() {
    const counts = {};
    for (const i of state.items) counts[i.category] = (counts[i.category] || 0) + 1;

    const f = q("#lb-filters");
    let html = `<button class="lb-chip ${state.fCategory === "all" ? "on" : ""}" data-c="all">everything ${state.items.length}</button>`;
    for (const g of CATEGORY_GROUPS) {
      const present = g.items.filter((c) => counts[c]);
      if (!present.length) continue;
      html += present.map((c) =>
        `<button class="lb-chip ${state.fCategory === c ? "on" : ""}" data-c="${c}">${c} ${counts[c]}</button>`).join("");
    }
    if (counts.unsorted) {
      html += `<button class="lb-chip ${state.fCategory === "unsorted" ? "on" : ""}" data-c="unsorted">unsorted ${counts.unsorted}</button>`;
    }
    f.innerHTML = html;
    f.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { state.fCategory = b.dataset.c; render(); hydrateImages(); }));

    const host = q("#lb-grid");
    const list = visible();
    if (!list.length) {
      host.innerHTML = `<div class="lb-empty">${
        state.query ? `nothing matches "${esc(state.query)}"`
                    : "nothing saved yet. tap + to add the first thing."}</div>`;
      return;
    }
    host.innerHTML = list.map((i) => {
      const cat = safeEnum(i.category, CATEGORIES, "unsorted");
      const url = safeHttpUrl(i.source_url);
      const cached = state.urls.get(i.id);
      const media = i.storage_path
        ? `<img class="lb-thumb ${cached ? "" : "lb-loading"}" data-for="${i.id}" ${cached ? `src="${esc(cached)}"` : ""} alt="${esc(i.title || "reference")}" loading="lazy">`
        : `<div class="lb-thumb lb-nolink"><span>${url ? esc(shortHost(url)) : "note"}</span></div>`;
      return `
        <button class="lb-card" data-id="${i.id}">
          ${media}
          <div class="lb-meta">
            ${i.title ? `<span class="lb-title">${esc(i.title)}</span>` : ""}
            <span class="lb-cat">${esc(cat)}</span>
            ${i.ai_analysed_at ? `<span class="lb-ai" title="described automatically">✦</span>` : ""}
          </div>
        </button>`;
    }).join("");
    host.querySelectorAll(".lb-card").forEach((c) => (c.onclick = () => openItem(c.dataset.id)));
  }

  function visible() {
    const s = state.query.toLowerCase();
    return state.items.filter((i) => {
      if (state.fCategory !== "all" && i.category !== state.fCategory) return false;
      if (!s) return true;
      return (i.title || "").toLowerCase().includes(s)
        || (i.note || "").toLowerCase().includes(s)
        || (i.category || "").toLowerCase().includes(s)
        || (i.tags || []).some((t) => String(t).toLowerCase().includes(s))
        || JSON.stringify(i.ai_analysis || {}).toLowerCase().includes(s);
    });
  }

  /* ----- capture: the fast path ----- */
  function addSheet() {
    const sheet = q("#lb-sheet");
    sheet.innerHTML = `
      <button class="lb-close" aria-label="Close">&times;</button>
      <h2 class="lb-h" id="lb-sheet-title">Add to the lookbook</h2>

      <div class="lb-drop" id="lb-drop">
        <input type="file" id="lb-file" accept="image/*" capture="environment" hidden>
        <button type="button" class="lb-bigbtn" id="lb-pick">Take or choose a photo</button>
        <p class="lb-hint">or paste a link, or just drop an image here</p>
        <img id="lb-preview" hidden alt="">
      </div>

      <form class="lb-form" id="lb-form">
        <label class="lb-flabel" for="lb-url">Link (optional)</label>
        <input id="lb-url" name="source_url" type="url" inputmode="url" autocomplete="off"
               placeholder="https://...">

        <label class="lb-flabel" for="lb-note">What did you like about it? (optional)</label>
        <textarea id="lb-note" name="note" placeholder="the ribbing on the cuffs"></textarea>

        <label class="lb-flabel" for="lb-cat">Category</label>
        <select id="lb-cat" name="category">
          ${CATEGORIES.map((c) => `<option value="${c}"${c === "unsorted" ? " selected" : ""}>${c}</option>`).join("")}
        </select>

        <button type="submit" id="lb-save">Save</button>
        <p class="lb-hint lb-center">You can leave everything blank except the photo.</p>
      </form>`;
    openSheet("lb-sheet-title");
    sheet.querySelector(".lb-close").onclick = closeSheet;

    let file = null;
    const fileInput = sheet.querySelector("#lb-file");
    const preview = sheet.querySelector("#lb-preview");
    const drop = sheet.querySelector("#lb-drop");

    const takeFile = (f) => {
      if (!f || !f.type.startsWith("image/")) return;
      if (f.size > MAX_BYTES) { showErr("that image is over 25MB — try a smaller one."); return; }
      file = f;
      preview.src = URL.createObjectURL(f);
      preview.hidden = false;
      drop.classList.add("has-image");
    };
    sheet.querySelector("#lb-pick").onclick = () => fileInput.click();
    fileInput.onchange = (e) => takeFile(e.target.files[0]);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      takeFile(e.dataTransfer.files[0]);
    });
    // paste an image straight from the clipboard — how Marco actually works
    sheet.addEventListener("paste", (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) takeFile(item.getAsFile());
    });

    let saving = false;
    sheet.querySelector("#lb-form").onsubmit = async (ev) => {
      ev.preventDefault();
      if (saving) return;
      const f = new FormData(ev.target);
      const note = String(f.get("note") || "").trim();
      const url = String(f.get("source_url") || "").trim();
      if (!file && !url && !note) { showErr("add a photo, a link, or a note."); return; }

      const btn = sheet.querySelector("#lb-save");
      saving = true; btn.disabled = true; btn.textContent = "Saving…";
      sheet.setAttribute("aria-busy", "true");
      try {
        // Create the row first so the image path can be scoped to its id,
        // which is what the storage policy checks.
        const [row] = await api("lookbook_items", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([stamp({
            note, source_url: url,
            category: f.get("category") || "unsorted",
            added_by: cfg.member.name,
          })]),
        });
        if (file) {
          const path = `${cfg.workspaceId}/lookbook/${row.id}/${Date.now()}-${safeName(file.name)}`;
          await uploadImage(path, file);
          await api(`lookbook_items?id=eq.${row.id}${wsFilter()}`, {
            method: "PATCH", body: JSON.stringify({ storage_path: path }),
          });
        }
        closeSheet(); await load();
      } catch (e) {
        showErr("could not save. " + String(e.message || e).slice(0, 120));
        saving = false; btn.disabled = false; btn.textContent = "Save";
        sheet.removeAttribute("aria-busy");
      }
    };
  }

  const safeName = (n) => String(n || "photo.jpg").replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60);

  async function uploadImage(path, file) {
    const headers = await authHeaders();
    const r = await fetch(`${cfg.storageUrl}/object/${BUCKET}/${encodeURI(path)}`, {
      method: "POST",
      headers: { ...headers, "x-upsert": "false", "Content-Type": file.type },
      body: file,
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  }

  /* ----- detail ----- */
  async function openItem(id) {
    const i = state.items.find((x) => String(x.id) === String(id)); if (!i) return;
    const sheet = q("#lb-sheet");
    const url = safeHttpUrl(i.source_url);
    const img = state.urls.get(i.id) || (i.storage_path ? await signedUrl(i.storage_path) : "");
    if (img) state.urls.set(i.id, img);
    const a = i.ai_analysis || {};

    sheet.innerHTML = `
      <button class="lb-close" aria-label="Close">&times;</button>
      <h2 class="lb-h" id="lb-item-title">${esc(i.title || i.category || "reference")}</h2>
      ${img ? `<img class="lb-full" src="${esc(img)}" alt="${esc(i.title || "reference")}">` : ""}
      ${i.note ? `<p class="lb-note">${esc(i.note)}</p>` : ""}
      ${url ? `<p class="lb-src"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(shortHost(url))}</a></p>` : ""}

      ${a.description ? `
        <div class="lb-lbl">What it looks like</div>
        <p class="lb-note">${esc(a.description)}</p>` : ""}
      ${(i.tags || []).length ? `
        <div class="lb-lbl">Tags</div>
        <div class="lb-tags">${i.tags.map((t) => `<span class="lb-tag">${esc(t)}</span>`).join("")}</div>` : ""}

      ${canEdit ? `
        <div class="lb-lbl">Category</div>
        <div class="lb-setline" id="lb-setcat">
          ${CATEGORIES.map((c) => `<button data-v="${c}" class="${i.category === c ? "on" : ""}">${c}</button>`).join("")}
        </div>
        <div class="lb-actions">
          <button class="lb-askai" id="lb-ask">copy for AI</button>
          <button class="lb-archive" id="lb-arch">remove from lookbook</button>
        </div>` : ""}

      <p class="lb-src lb-mt">added by ${esc(i.added_by || "—")} · ${timeAgo(i.created_at)}</p>`;
    openSheet("lb-item-title");
    sheet.querySelector(".lb-close").onclick = closeSheet;

    if (!canEdit) return;
    sheet.querySelectorAll("#lb-setcat button").forEach((b) => (b.onclick = async () => {
      try {
        await api(`lookbook_items?id=eq.${i.id}${wsFilter()}`, {
          method: "PATCH", body: JSON.stringify({ category: b.dataset.v }),
        });
        closeSheet(); await load();
      } catch (e) { showErr("could not save. " + String(e.message || e).slice(0, 100)); }
    }));
    sheet.querySelector("#lb-ask").onclick = (e) => copyForAI(i, e.currentTarget);
    sheet.querySelector("#lb-arch").onclick = async () => {
      // Archive, never delete — same rule as rejected ideas. Nothing is lost.
      try {
        await api(`lookbook_items?id=eq.${i.id}${wsFilter()}`, {
          method: "PATCH", body: JSON.stringify({ archived_at: new Date().toISOString() }),
        });
        closeSheet(); await load();
      } catch (e) { showErr("could not remove. " + String(e.message || e).slice(0, 100)); }
    };
  }

  /* ----- copy for AI (the free route, until an API key exists) ----- */
  async function copyForAI(item, btn) {
    const url = safeHttpUrl(item.source_url);
    const text = `${ANALYSE_BRIEF}\n\n${
      item.note ? `WHAT WE LIKED ABOUT IT\n${item.note}\n\n` : ""}${
      url ? `SOURCE\n${url}\n\n` : ""}(attach the image alongside this message)`;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; el.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    const was = btn.textContent;
    btn.textContent = "copied — paste it with the photo";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = was; btn.classList.remove("done"); }, 2600);
  }

  /* ----- sheet plumbing ----- */
  const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';
  function openSheet(labelledById) {
    const d = q("#lb-detail"), sheet = q("#lb-sheet");
    state.lastFocused = document.activeElement;
    d.classList.add("open");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    if (labelledById) sheet.setAttribute("aria-labelledby", labelledById);
    document.body.classList.add("hub-sheet-open");   // stop the page scrolling behind
    (sheet.querySelector(FOCUSABLE) || sheet).focus?.();
  }
  function closeSheet() {
    const d = q("#lb-detail");
    if (!d.classList.contains("open")) return;
    d.classList.remove("open");
    document.body.classList.remove("hub-sheet-open");
    q("#lb-sheet").removeAttribute("aria-busy");
    if (state.lastFocused && document.contains(state.lastFocused)) state.lastFocused.focus();
    state.lastFocused = null;
  }
  function trapFocus(e) {
    const d = q("#lb-detail");
    if (e.key !== "Tab" || !d.classList.contains("open")) return;
    const items = [...q("#lb-sheet").querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ----- chrome ----- */
  if (!canEdit) { const a = q("#lb-add"); if (a) a.hidden = true; }
  q("#lb-add").onclick = addSheet;
  q("#lb-detail").onclick = (e) => { if (e.target.id === "lb-detail") closeSheet(); };
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); else trapFocus(e); });
  q("#lb-search").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const v = e.target.value;
    state.searchTimer = setTimeout(() => { state.query = v.trim(); render(); hydrateImages(); }, 160);
  });

  load();
  const timer = setInterval(load, 45000);
  return { destroy() { clearInterval(timer); root.replaceChildren(); } };
}

/* ---------- ctx ---------- */
function normaliseCtx(ctx) {
  if (ctx && ctx.restUrl && typeof ctx.getAccessToken === "function") {
    const rest = ctx.restUrl.replace(/\/$/, "");
    return {
      mode: "authed",
      restUrl: rest,
      storageUrl: rest.replace(/\/rest\/v1$/, "/storage/v1"),
      getAccessToken: ctx.getAccessToken,
      anonKey: ctx.anonKey || "",
      member: ctx.member || { name: "member", role: "member" },
      workspaceId: ctx.workspaceId || "",
    };
  }
  return { mode: "standalone", restUrl: "", storageUrl: "", anonKey: "",
           member: { name: "guest", role: "viewer" }, workspaceId: "" };
}

if (typeof window !== "undefined") {
  window.HubLookbook = { mount };
  if (window.Hub && typeof window.Hub.registerSection === "function") {
    window.Hub.registerSection("lookbook", { mount });
  }
}

/* ---------- template + styles ---------- */
const TEMPLATE = `
  <div class="lb-bar">
    <div class="lb-mark">lookbook<small>things we liked</small></div>
  </div>
  <input id="lb-search" class="lb-search" type="search" placeholder="search the lookbook..." autocomplete="off">
  <div class="lb-filters" id="lb-filters"></div>
  <div class="lb-err"></div>
  <div class="lb-grid" id="lb-grid"></div>
  <button id="lb-add" type="button" title="Add to lookbook" aria-label="Add to lookbook">+</button>
  <div id="lb-detail"><div class="lb-sheet" id="lb-sheet" tabindex="-1"></div></div>
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || document.querySelector('link[data-lb-styles]')) return;
  stylesInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-lb-styles", "");
  link.href = new URL("hub-lookbook.css", import.meta.url).href;
  document.head.appendChild(link);
}
