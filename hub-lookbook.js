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
    objectUrls: new Set(),  // authenticated blob fallbacks we must revoke
    hydrationController: new AbortController(),
    selectedIds: new Set(),
    exporting: false,
    exportController: null,
    exportResultUrl: "",
    destroyed: false,
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
  async function requestSignedUrl(path, signal) {
    const headers = await authHeaders({ "Content-Type": "application/json" });
    try {
      const r = await fetch(`${cfg.storageUrl}/object/sign/${BUCKET}/${encodeURI(path)}`, {
        method: "POST", headers, body: JSON.stringify({ expiresIn: 3600 }), signal,
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
      if (e?.name === "AbortError") throw e;
      console.warn("lookbook: sign threw", String(e).slice(0, 160));
    }
    return "";
  }

  async function directImageBlob(path, signal) {
    try {
      const headers = await authHeaders();
      const r = await fetch(`${cfg.storageUrl}/object/${BUCKET}/${encodeURI(path)}`, { headers, signal });
      if (!r.ok) {
        console.warn("lookbook: direct fetch failed", r.status, (await r.text().catch(() => "")).slice(0, 200));
        return null;
      }
      return await r.blob();
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      console.warn("lookbook: direct fetch threw", String(e).slice(0, 160));
      return null;
    }
  }

  async function signedUrl(path, signal = state.hydrationController.signal) {
    const signed = await requestSignedUrl(path, signal);
    if (signed) return signed;
    return await blobUrl(path, signal);
  }

  async function blobUrl(path, signal = state.hydrationController.signal) {
    const blob = await directImageBlob(path, signal);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    if (state.destroyed) {
      URL.revokeObjectURL(url);
      return "";
    }
    state.objectUrls.add(url);
    return url;
  }

  /* Codex — 2026-08-13: PDF export needs original authenticated bytes, not a
     screenshot of the card thumbnail. Keep both of Claude's proven routes:
     accept both signed URL response shapes, then fall back to the caller's
     authenticated object download if the signed fetch fails. */
  async function fetchImageBlob(path, signal) {
    const signed = await requestSignedUrl(path, signal);
    if (signed) {
      try {
        const response = await fetch(signed, { signal });
        if (response.ok) return await response.blob();
        console.warn("lookbook: signed export fetch failed", response.status);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.warn("lookbook: signed export fetch threw", String(error).slice(0, 160));
      }
    }
    const blob = await directImageBlob(path, signal);
    if (!blob) throw new Error("The photograph could not be downloaded.");
    return blob;
  }

  async function load() {
    try {
      const items = await api(
        `lookbook_items?select=*&archived_at=is.null&order=created_at.desc&limit=300${wsFilter()}`);
      if (state.destroyed) return;
      state.items = items || [];
      const liveIds = new Set(state.items.map((item) => String(item.id)));
      for (const id of state.selectedIds) if (!liveIds.has(id)) state.selectedIds.delete(id);
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
      if (state.destroyed) return;
      if (!it.storage_path || state.urls.has(it.id)) continue;
      let url = "";
      try {
        url = await signedUrl(it.storage_path, state.hydrationController.signal);
      } catch (error) {
        if (error?.name === "AbortError") return;
        continue;
      }
      if (state.destroyed) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
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
  const itemName = (item) => String(item?.title || item?.category || "reference").trim() || "reference";

  function renderSelectionControls() {
    const visibleIds = new Set(visible().map((item) => String(item.id)));
    const total = state.selectedIds.size;
    const hiddenCount = [...state.selectedIds].filter((id) => !visibleIds.has(id)).length;
    const bar = q(".lb-bar");
    const count = q("#lb-selected-count");
    const clear = q("#lb-clear-selection");
    const button = q("#lb-export");
    bar.classList.toggle("has-selection", total > 0);
    count.textContent = total
      ? `${total} selected${hiddenCount ? ` · ${hiddenCount} not shown` : ""}`
      : "";
    clear.hidden = total === 0;
    button.disabled = total === 0 || state.exporting;
    button.textContent = state.exporting ? "Building PDF…" : "Export PDF";
    button.setAttribute("aria-label", total
      ? `Export ${total} selected reference${total === 1 ? "" : "s"} as PDF`
      : "Export selected references as PDF");
  }

  function setSelected(id, selected) {
    const key = String(id);
    const findCheckbox = () => [...el.querySelectorAll(".lb-select")]
      .find((node) => String(node.dataset.selectId) === key);
    if (selected && !state.selectedIds.has(key) && state.selectedIds.size >= 40) {
      showErr("one PDF can hold up to 40 references. Clear one selection to add another.");
      const checkbox = findCheckbox();
      if (checkbox) checkbox.checked = false;
      return;
    }
    if (selected) state.selectedIds.add(key);
    else state.selectedIds.delete(key);
    const checkbox = findCheckbox();
    if (checkbox) {
      checkbox.checked = selected;
      checkbox.closest(".lb-cardwrap")?.classList.toggle("is-selected", selected);
    }
    renderSelectionControls();
  }

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
      renderSelectionControls();
      return;
    }
    host.innerHTML = list.map((i) => {
      const cat = safeEnum(i.category, CATEGORIES, "unsorted");
      const url = safeHttpUrl(i.source_url);
      const cached = state.urls.get(i.id);
      const media = i.storage_path
        ? `<img class="lb-thumb ${cached ? "" : "lb-loading"}" data-for="${i.id}" ${cached ? `src="${esc(cached)}"` : ""} alt="${esc(i.title || "reference")}" loading="lazy">`
        : `<div class="lb-thumb lb-nolink"><span>${url ? esc(shortHost(url)) : "note"}</span></div>`;
      const selected = state.selectedIds.has(String(i.id));
      return `
        <article class="lb-cardwrap ${selected ? "is-selected" : ""}">
          <button class="lb-card" data-id="${i.id}" aria-label="Open ${esc(itemName(i))}">
            ${media}
            <div class="lb-meta">
              ${i.title ? `<span class="lb-title">${esc(i.title)}</span>` : ""}
              <span class="lb-cat">${esc(cat)}</span>
              ${i.ai_analysed_at ? `<span class="lb-ai" title="described automatically">✦</span>` : ""}
            </div>
          </button>
          <label class="lb-select-control" title="Select for PDF">
            <input class="lb-select" type="checkbox" data-select-id="${i.id}"
              aria-label="Select ${esc(itemName(i))} for PDF" ${selected ? "checked" : ""}>
            <span class="lb-select-mark" aria-hidden="true">✓</span>
          </label>
        </article>`;
    }).join("");
    host.querySelectorAll(".lb-card").forEach((c) => (c.onclick = () => openItem(c.dataset.id)));
    host.querySelectorAll(".lb-select").forEach((checkbox) => {
      checkbox.onchange = () => setSelected(checkbox.dataset.selectId, checkbox.checked);
    });
    renderSelectionControls();
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

  /* ----- factory PDF export ----- */
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function clearExportResult() {
    if (state.exportResultUrl) URL.revokeObjectURL(state.exportResultUrl);
    state.exportResultUrl = "";
  }

  function selectedSnapshot() {
    return state.items.filter((item) => state.selectedIds.has(String(item.id)));
  }

  function showExportProgress(total) {
    const sheet = q("#lb-sheet");
    sheet.innerHTML = `
      <h2 class="lb-h" id="lb-export-title">Building the lookbook</h2>
      <p class="lb-note" id="lb-export-status" role="status" aria-live="polite">Preparing the first photograph…</p>
      <progress class="lb-export-progress" id="lb-export-progress" max="${total}" value="0"></progress>
      <p class="lb-hint">Photos are resized one at a time, so you can keep using this tab.</p>
      <button class="lb-export-cancel" id="lb-export-cancel" type="button">Cancel export</button>`;
    openSheet("lb-export-title");
    sheet.querySelector("#lb-export-cancel").onclick = () => {
      const controller = state.exportController;
      state.exportController = null;
      state.exporting = false;
      controller?.abort();
      renderSelectionControls();
      closeSheet({ force: true });
    };
  }

  function updateExportProgress(progress) {
    const bar = q("#lb-export-progress");
    const status = q("#lb-export-status");
    if (!bar || !status) return;
    bar.max = Math.max(1, progress.total || 1);
    bar.value = Math.max(0, Math.min(bar.max, progress.current || 0));
    if (progress.phase === "preparing") {
      status.textContent = `Preparing photo ${progress.current} of ${progress.total}`;
    } else if (progress.phase === "building") {
      status.textContent = `Laying out reference ${progress.current} of ${progress.total}`;
    } else {
      status.textContent = "Finishing the PDF…";
    }
  }

  function showExportFailure(error, allowMissingPhotos) {
    const sheet = q("#lb-sheet");
    const isPhotoError = error?.name === "LookbookImageError";
    const isTooLarge = error?.name === "LookbookTooLargeError";
    const names = isPhotoError ? (error.items || []).map((item) => item.title).filter(Boolean) : [];
    sheet.innerHTML = `
      <button class="lb-close" aria-label="Close">&times;</button>
      <h2 class="lb-h" id="lb-export-error-title" tabindex="-1">The PDF was not created</h2>
      <p class="lb-note">${isPhotoError
        ? `We could not prepare ${esc(names[0] || "one photograph")}. Nothing was downloaded.`
        : error?.name === "LookbookTooLargeError"
          ? "This selection is too large to build safely on this device. Select fewer references and try again."
          : error?.name === "LookbookTextError"
            ? `This PDF cannot yet print some characters in ${esc(error.itemTitle || "one reference")}. Use Latin letters and try again.`
          : "Something interrupted the export. Your selection is still here."}</p>
      <div class="lb-export-actions">
        <button class="lb-export-primary" id="lb-export-retry" type="button">${isTooLarge ? "Close and select fewer" : "Try again"}</button>
        ${isPhotoError && !allowMissingPhotos
          ? `<button class="lb-export-secondary" id="lb-export-without" type="button">Make PDF without that photo</button>`
          : ""}
      </div>`;
    sheet.setAttribute("aria-labelledby", "lb-export-error-title");
    sheet.querySelector(".lb-close").onclick = () => closeSheet({ force: true });
    sheet.querySelector("#lb-export-retry").onclick = () => {
      if (isTooLarge) closeSheet({ force: true });
      else void startExport({ allowMissingPhotos });
    };
    sheet.querySelector("#lb-export-without")?.addEventListener("click", () => {
      void startExport({ allowMissingPhotos: true });
    });
    sheet.querySelector("#lb-export-error-title").focus();
  }

  function showExportReady(result) {
    clearExportResult();
    state.exportResultUrl = URL.createObjectURL(result.blob);
    const file = typeof File === "function"
      ? new File([result.blob], result.fileName, { type: "application/pdf" })
      : null;
    const canShare = file && typeof navigator.share === "function"
      && typeof navigator.canShare === "function"
      && navigator.canShare({ files: [file] });
    const sheet = q("#lb-sheet");
    sheet.innerHTML = `
      <button class="lb-close" aria-label="Close">&times;</button>
      <h2 class="lb-h" id="lb-export-ready-title" tabindex="-1">Lookbook ready</h2>
      <p class="lb-note">${result.pageCount} pages · ${formatBytes(result.blob.size)}</p>
      ${result.missingPhotos
        ? `<p class="lb-export-warning">${result.missingPhotos} unavailable photo${result.missingPhotos === 1 ? "" : "s"} became a clearly labelled reference page.</p>`
        : ""}
      <div class="lb-export-actions">
        ${canShare ? `<button class="lb-export-primary" id="lb-export-share" type="button">Share PDF</button>` : ""}
        <a class="lb-export-secondary" id="lb-export-download" href="${esc(state.exportResultUrl)}"
           download="${esc(result.fileName)}" target="_blank" rel="noopener">Open / save PDF</a>
      </div>
      <p class="lb-hint">Visual references only — confirm artwork, measurements and colours separately with the factory.</p>`;
    sheet.setAttribute("aria-labelledby", "lb-export-ready-title");
    sheet.querySelector(".lb-close").onclick = () => closeSheet({ force: true });
    sheet.querySelector("#lb-export-share")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await navigator.share({ files: [file], title: "FAKESNIFF factory reference lookbook" });
      } catch (error) {
        if (error?.name !== "AbortError") {
          q("#lb-export-ready-title").insertAdjacentHTML("afterend",
            `<p class="lb-export-warning">Sharing did not open. Use Open / save PDF instead.</p>`);
        }
      } finally {
        button.disabled = false;
      }
    });
    sheet.querySelector("#lb-export-ready-title").focus();
  }

  async function startExport({ allowMissingPhotos = false } = {}) {
    if (state.exporting) return;
    const items = selectedSnapshot();
    if (!items.length) return;
    if (items.length > 40) {
      showErr("choose no more than 40 references for one PDF.");
      return;
    }

    clearExportResult();
    state.exporting = true;
    const controller = new AbortController();
    state.exportController = controller;
    renderSelectionControls();
    showExportProgress(items.length);

    try {
      const { exportLookbookPdf } = await import("./hub-lookbook-export.js");
      const result = await exportLookbookPdf({
        items,
        signal: controller.signal,
        allowMissingPhotos,
        onProgress: updateExportProgress,
        getImageBlob: (item, signal) => fetchImageBlob(item.storage_path, signal),
      });
      if (state.destroyed || state.exportController !== controller) return;
      state.exporting = false;
      state.exportController = null;
      renderSelectionControls();
      showExportReady(result);
    } catch (error) {
      if (state.destroyed || state.exportController !== controller) return;
      const cancelled = error?.name === "AbortError";
      state.exporting = false;
      state.exportController = null;
      renderSelectionControls();
      if (cancelled) {
        closeSheet({ force: true });
        return;
      }
      showExportFailure(error, allowMissingPhotos);
    }
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
        /* Claude — 2026-08-13: the row used to be created first and the photo
           attached afterwards, which meant storage_path was null at insert.
           The lookbook_has_content constraint requires a photo, a link or a
           note, so adding a photo with neither of the other two was rejected
           outright — Salman had to type something in the optional box to save
           a picture. Generating the id here lets the image upload first and
           the row arrive complete, in one insert. */
        const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

        let uploadedPath = "";
        let sourceUrl = url;

        /* A pasted link should become a real picture, not just a link. The
           browser cannot fetch most other sites' images, so the function does
           it and hands the bytes back. If that fails we still save the link. */
        let fetched = null;
        if (!file && url) fetched = await fetchLinkImage(url);

        const incoming = file || fetched?.file;
        if (incoming) {
          uploadedPath = `${cfg.workspaceId}/lookbook/${id}/${Date.now()}-${safeName(incoming.name)}`;
          await uploadImage(uploadedPath, incoming);
        }

        await api("lookbook_items", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify([stamp({
            id, note, source_url: sourceUrl,
            storage_path: uploadedPath || null,
            category: f.get("category") || "unsorted",
            added_by: cfg.member.name,
          })]),
        });
        const row = { id };
        closeSheet(); await load();
        /* Describe it now rather than waiting for the hourly job. Deliberately
           after the sheet closes and the list reloads: the photo is saved and
           visible whether or not this works, and a failure here must never
           look like the upload failed. */
        if (uploadedPath) void describeNow(row.id, uploadedPath, note);
      } catch (e) {
        showErr("could not save. " + String(e.message || e).slice(0, 120));
        saving = false; btn.disabled = false; btn.textContent = "Save";
        sheet.removeAttribute("aria-busy");
      }
    };
  }

  /* Ask the function to download an image the person pasted a link to. Kept
     server-side because the browser is blocked from reading most other sites'
     images, and because a link is worth far more as a picture you can see. */
  async function fetchLinkImage(url) {
    try {
      const token = await cfg.getAccessToken();
      const res = await fetch(`${cfg.restUrl.replace(/\/rest\/v1$/, "")}/functions/v1/assistant`, {
        method: "POST",
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "fetch-image", url }),
      });
      if (!res.ok) { console.warn("lookbook: link fetch failed", res.status); return null; }
      const out = await res.json();
      if (!out?.dataUrl) { console.warn("lookbook: link fetch returned no image", out?.error || ""); return null; }

      /* Claude — 2026-08-13: decoded by hand rather than fetch(dataUrl). The
         page's connect-src allows self and Supabase, not data:, so fetching a
         data URL was blocked by our own CSP and failed silently — the picture
         came back from the server and then vanished here. */
      const [meta, b64] = String(out.dataUrl).split(",", 2);
      if (!b64) return null;
      const mime = (meta.match(/data:([^;]+)/) || [, "image/jpeg"])[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const name = out.name || `linked.${(mime.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
      return { file: new File([blob], name, { type: mime }) };
    } catch (e) {
      console.warn("lookbook: link fetch threw", String(e).slice(0, 160));
      return null;
    }
  }

  /* Ask the assistant function to describe a photo, then write the result back
     and refresh that one card. The hourly job still exists as a safety net, so
     if this fails the description simply arrives later instead of never. */
  async function describeNow(itemId, storagePath, note) {
    const card = document.querySelector(`[data-id="${itemId}"]`);
    card?.classList.add("lb-analysing");
    try {
      const token = await cfg.getAccessToken();
      const res = await fetch(`${cfg.restUrl.replace(/\/rest\/v1$/, "")}/functions/v1/assistant`, {
        method: "POST",
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "analyse", storagePath, note }),
      });
      if (!res.ok) { console.warn("lookbook: describe failed", res.status); return; }
      const out = await res.json();
      if (!out?.description) return;

      const patch = {
        ai_analysis: { description: out.description, tags: out.tags || [], source: "gemini" },
        ai_analysed_at: new Date().toISOString(),
      };
      if (out.tags?.length) patch.tags = out.tags;
      /* Only file it when the person left it unsorted. A category someone chose
         is never overwritten by the machine. */
      const existing = state.items.find((i) => String(i.id) === String(itemId));
      if (out.category && (!existing?.category || existing.category === "unsorted")) {
        patch.category = out.category;
      }
      await api(`lookbook_items?id=eq.${itemId}${wsFilter()}`, {
        method: "PATCH", body: JSON.stringify(patch),
      });
      await load();
    } catch (e) {
      console.warn("lookbook: describe threw", String(e).slice(0, 160));
    } finally {
      document.querySelector(`[data-id="${itemId}"]`)?.classList.remove("lb-analysing");
    }
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
    if (!d.classList.contains("open")) state.lastFocused = document.activeElement;
    d.classList.add("open");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    if (labelledById) sheet.setAttribute("aria-labelledby", labelledById);
    document.body.classList.add("hub-sheet-open");   // stop the page scrolling behind
    (sheet.querySelector(FOCUSABLE) || sheet).focus?.();
  }
  function closeSheet({ force = false } = {}) {
    const d = q("#lb-detail");
    if (!d.classList.contains("open")) return;
    if (state.exporting && !force) return;
    d.classList.remove("open");
    document.body.classList.remove("hub-sheet-open");
    q("#lb-sheet").removeAttribute("aria-busy");
    clearExportResult();
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
  q("#lb-export").onclick = () => void startExport();
  q("#lb-clear-selection").onclick = () => {
    state.selectedIds.clear();
    render();
    hydrateImages();
  };
  q("#lb-detail").onclick = (e) => { if (e.target.id === "lb-detail") closeSheet(); };
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); else trapFocus(e); });
  q("#lb-search").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const v = e.target.value;
    state.searchTimer = setTimeout(() => { state.query = v.trim(); render(); hydrateImages(); }, 160);
  });

  load();
  const timer = setInterval(load, 45000);
  return { destroy() {
    state.destroyed = true;
    clearInterval(timer);
    clearTimeout(state.searchTimer);
    state.hydrationController.abort();
    state.exportController?.abort();
    clearExportResult();
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls.clear();
    document.body.classList.remove("hub-sheet-open");
    root.replaceChildren();
  } };
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
    <div class="lb-export-controls">
      <span id="lb-selected-count" class="lb-selected-count" aria-live="polite"></span>
      <button id="lb-clear-selection" class="lb-clear-selection" type="button" hidden>Clear</button>
      <button id="lb-export" class="lb-export-button" type="button" disabled>Export PDF</button>
    </div>
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
