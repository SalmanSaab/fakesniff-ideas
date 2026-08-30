/* FAKESNIFF Hub — Designs. Owner: Claude.
 *
 * Try an idea on an actual garment and look at it. Describe the graphic, pick
 * what it goes on, and get a photograph of the thing rather than a description
 * of it.
 *
 * The generation happens in the assistant Edge Function — the API key never
 * reaches this page. This file writes a good prompt, shows the result, and
 * lets you keep it.
 *
 * Deliberately does not store anything by itself. A generated picture is a
 * sketch: most are thrown away, and a library of five hundred half-ideas is
 * worse than none. If one is worth keeping it goes to the Lookbook, which
 * already stores, describes and files things properly.
 */

/* The garment vocabulary and the house brief live in hub-brand.js so this
   screen and the Idea Lab cannot drift apart about what FAKESNIFF looks like. */
import { GARMENTS, COLOURS, SHOTS, buildGarmentPrompt, referenceFromLookbook } from "./hub-brand.js";
import { t, onLanguageChange } from "./hub-i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || document.querySelector("link[data-dg-styles]")) return;
  stylesInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-dg-styles", "");
  link.href = new URL("hub-designs.css", import.meta.url).href;
  document.head.appendChild(link);
}

/* Kept as a named export so the prompt can be tested without a browser. */
export function buildPrompt(opts) {
  return buildGarmentPrompt(opts);
}


export function mount(root, ctx) {
  injectStyles();
  const cfg = normaliseCtx(ctx);
  const canEdit = cfg.mode === "authed" && cfg.member.role !== "viewer";

  let busy = false;
  let last = null;      // { dataUrl, prompt }
  let reference = "";   // a real material description from our own Lookbook

  /* Anchor generation to material the brand actually owns. If the Lookbook has
     nothing described yet this stays empty, which is the right answer — an
     invented reference would be worse than none. */
  void (async () => {
    if (cfg.mode !== "authed") return;
    try {
      const token = await cfg.getAccessToken();
      const rows = await fetch(
        `${cfg.restUrl}/lookbook_items?select=ai_analysis&ai_analysed_at=not.is.null&archived_at=is.null&order=created_at.desc&limit=6`,
        { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` } },
      ).then((r) => (r.ok ? r.json() : []));
      reference = referenceFromLookbook(rows || []);
    } catch { /* generation works fine without it */ }
  })();

  root.classList.add("dg", "fs-scope");
  root.innerHTML = shell();

  const $ = (s) => root.querySelector(s);

  /* Claude — 2026-08-30: pulled out so a language change can rebuild the markup
     and re-attach. Leaving listeners bound to elements that no longer exist
     gives you a screen in the right language with dead buttons, which is worse
     than not translating it. */
  function wireDesigns() {
    $("#dg-form").addEventListener("submit", generate);
    $("#dg-again").addEventListener("click", () => generate());
    $("#dg-save").addEventListener("click", saveToLookbook);
    $("#dg-download").addEventListener("click", download);
    $("#dg-pick").addEventListener("click", toggleIdeas);
  }
  wireDesigns();

  /* Claude — 2026-08-30: rebuild on a language change, but keep what they were
     halfway through typing. Losing a graphic description because you switched
     language would be a reason never to switch again. */
  const stopLang = onLanguageChange(() => {
    const draft = $("#dg-idea").value;
    root.innerHTML = shell();
    $("#dg-idea").value = draft;
    wireDesigns();
  });

  /* If someone pressed "Open in Designs" on an idea, it is waiting for us.
   *
   * Claude — 2026-08-13: this used to run only at mount. The Hub keeps a
   * section mounted once you have visited it, so arriving from the Idea Lab a
   * second time did nothing — the idea sat in storage until a reload happened
   * to remount the module. Salman saw exactly that: press the button, land on
   * Designs, refresh, and only then find the idea. It now also runs whenever
   * this section becomes the visible one. */
  function takeSeed() {
    try {
      const seed = JSON.parse(sessionStorage.getItem("fakesniff-design-seed") || "null");
      if (!seed?.line) return;
      $("#dg-idea").value = seed.concept
        ? `the words "${seed.line}" set as the print, in the spirit of: ${seed.concept}`
        : `the words "${seed.line}" set as the print`;
      sessionStorage.removeItem("fakesniff-design-seed");
      note(t("designs.taken_from_ideas"));
      $("#dg-idea").focus();
    } catch { /* nothing waiting */ }
  }
  takeSeed();
  const onHash = () => {
    if ((location.hash || "").replace(/^#/, "") === "designs") takeSeed();
  };
  window.addEventListener("hashchange", onHash);

  return () => {
    window.removeEventListener("hashchange", onHash);
    root.innerHTML = "";
    root.classList.remove("dg", "fs-scope");
  };

  async function generate(event) {
    event?.preventDefault?.();
    if (busy) return;
    const idea = $("#dg-idea").value.trim();
    if (!idea) { note(t("designs.need_graphic")); $("#dg-idea").focus(); return; }
    if (cfg.mode !== "authed") { note(t("designs.sign_in")); return; }

    const prompt = buildGarmentPrompt({
      graphic: idea,
      reference,
      garment: $("#dg-garment").value,
      colour: $("#dg-colour").value,
      shot: $("#dg-shot").value,
    });

    busy = true;
    setState("working");
    note("");
    try {
      const token = await cfg.getAccessToken();
      const res = await fetch(`${cfg.restUrl.replace(/\/rest\/v1$/, "")}/functions/v1/assistant`, {
        method: "POST",
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "image", prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.image) {
        note(data.error || t("designs.failed"));
        setState("idle");
        return;
      }

      last = { dataUrl: data.image, prompt, idea };
      $("#dg-out").innerHTML =
        `<img class="dg-img" src="${esc(data.image)}" alt="${esc(idea)} on a ${esc($("#dg-garment").value)}">`;
      setState("done");
    } catch (e) {
      note(`That did not work: ${String(e?.message || e)}`);
      setState("idle");
    } finally {
      busy = false;
    }
  }

  /* Claude — 2026-08-13: this used to cache "already loaded" and return early.
     When the first load failed after the flag was set, every later click just
     re-showed an empty box and never tried again — which is exactly what
     Salman saw. It now fetches every time it opens. Sixty rows is nothing, and
     a list that is always right beats one that is occasionally cheap. */
  async function toggleIdeas() {
    const box = $("#dg-ideas");
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = t("designs.reading_board");

    if (cfg.mode !== "authed") { box.textContent = t("designs.sign_in_board"); return; }
    try {
      const token = await cfg.getAccessToken();
      const res = await fetch(
        `${cfg.restUrl}/ideas?select=id,line,concept,status&order=id.desc&limit=60`,
        { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        box.textContent = t("designs.board_failed", { n: res.status });
        return;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) { box.textContent = t("designs.board_empty"); return; }

      /* 27 ideas today and it only grows. Scrolling a list to find one you
         already have in mind is the thing that makes people stop using it. */
      const search = document.createElement("input");
      search.type = "search";
      search.className = "dg-ideasearch";
      search.placeholder = t("designs.board_search");
      search.setAttribute("aria-label", t("designs.board_search"));

      const buttons = rows.map((r) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dg-ideapick";
        const line = document.createElement("span");
        line.className = "dg-ideal";
        line.textContent = r.line || t("designs.untitled_idea");
        b.appendChild(line);
        if (r.concept) {
          const c = document.createElement("span");
          c.className = "dg-ideac";
          c.textContent = r.concept;
          b.appendChild(c);
        }
        b.addEventListener("click", () => {
          $("#dg-idea").value = r.concept
            ? `the words "${r.line}" set as the print, in the spirit of: ${r.concept}`
            : `the words "${r.line}" set as the print`;
          box.hidden = true;
          $("#dg-idea").focus();
        });
        return b;
      });
      const list = document.createElement("div");
      list.className = "dg-idealist";
      list.append(...buttons);

      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        buttons.forEach((b, i) => {
          const r = rows[i];
          const hit = !q
            || String(r.line || "").toLowerCase().includes(q)
            || String(r.concept || "").toLowerCase().includes(q);
          b.hidden = !hit;
          if (hit) shown++;
        });
        empty.hidden = shown > 0;
      });

      const empty = document.createElement("p");
      empty.className = "dg-ideanone";
      empty.textContent = t("designs.board_no_match");
      empty.hidden = true;

      box.replaceChildren(search, list, empty);
      search.focus();
    } catch (e) {
      box.textContent = t("designs.board_failed", { n: String(e?.message || e).slice(0, 60) });
    }
  }

  function download() {
    if (!last) return;
    const a = document.createElement("a");
    a.href = last.dataUrl;
    a.download = `fakesniff-${last.idea.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "design"}.png`;
    a.click();
  }

  /* Keeping one means putting it where things are kept, rather than inventing
     a second library that also needs describing, filing and searching. */
  async function saveToLookbook() {
    if (!last || !canEdit) return;
    const btn = $("#dg-save");
    btn.disabled = true; btn.textContent = t("common.loading");
    try {
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      const [meta, b64] = String(last.dataUrl).split(",", 2);
      const mime = (meta.match(/data:([^;]+)/) || [, "image/png"])[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const path = `${cfg.workspaceId}/lookbook/${id}/${Date.now()}-generated.png`;
      const token = await cfg.getAccessToken();
      const auth = { apikey: cfg.anonKey, Authorization: `Bearer ${token}` };

      const up = await fetch(`${cfg.restUrl.replace(/\/rest\/v1$/, "/storage/v1")}/object/lookbook/${encodeURI(path)}`, {
        method: "POST", headers: { ...auth, "x-upsert": "false", "Content-Type": mime },
        body: new Blob([bytes], { type: mime }),
      });
      if (!up.ok) throw new Error((await up.text()).slice(0, 140));

      const row = await fetch(`${cfg.restUrl}/lookbook_items`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify([{
          id, workspace_id: cfg.workspaceId,
          note: last.idea, storage_path: path, category: "graphic",
          added_by: cfg.member.name, source_url: "",
        }]),
      });
      if (!row.ok) throw new Error((await row.text()).slice(0, 140));
      note(t("designs.saved_to_lookbook"));
      btn.textContent = t("designs.saved");
    } catch (e) {
      note(t("designs.save_failed", { reason: String(e?.message || e).slice(0, 140) }));
      btn.textContent = t("designs.save_to_lookbook");
      btn.disabled = false;
    }
  }

  function setState(s) {
    root.dataset.state = s;
    $("#dg-go").disabled = s === "working";
    $("#dg-go").textContent = s === "working" ? t("designs.making") : t("designs.go");
    $("#dg-result").hidden = s !== "done";
    $("#dg-working").hidden = s !== "working";
    if (s !== "done") { $("#dg-save").disabled = !canEdit; $("#dg-save").textContent = t("designs.save_to_lookbook"); }
  }

  function note(msg) {
    const el = $("#dg-note");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function shell() {
    const opts = (list) => list.map(([v, label]) => `<option value="${v}">${esc(t(label))}</option>`).join("");
    return `
    <div class="dg-bar">
      <span class="dg-mark">${esc(t("designs.heading"))}<small>${esc(t("designs.tagline"))}</small></span>
    </div>

    <form id="dg-form" class="dg-form">
      <div class="dg-lblrow">
        <label class="dg-lbl" for="dg-idea">${esc(t("designs.graphic"))}</label>
        <button id="dg-pick" class="dg-pick" type="button">${esc(t("designs.from_ideas"))}</button>
      </div>
      <textarea id="dg-idea" class="dg-input dg-area"
        placeholder="${esc(t("designs.graphic_placeholder"))}"></textarea>
      <p class="dg-hint">${esc(t("designs.graphic_hint"))}</p>
      <div id="dg-ideas" class="dg-ideas" hidden></div>

      <div class="dg-row">
        <div>
          <label class="dg-lbl" for="dg-garment">${esc(t("designs.on_what"))}</label>
          <select id="dg-garment" class="dg-input">${opts(GARMENTS)}</select>
        </div>
        <div>
          <label class="dg-lbl" for="dg-colour">${esc(t("designs.colour"))}</label>
          <select id="dg-colour" class="dg-input">${opts(COLOURS)}</select>
        </div>
        <div>
          <label class="dg-lbl" for="dg-shot">${esc(t("designs.shot"))}</label>
          <select id="dg-shot" class="dg-input">${opts(SHOTS)}</select>
        </div>
      </div>

      <button id="dg-go" class="dg-go" type="submit">${esc(t("designs.go"))}</button>
      <p id="dg-note" class="dg-noteline" role="status" hidden></p>
    </form>

    <div id="dg-working" class="dg-working" hidden>
      <span class="dg-pulse" aria-hidden="true"></span>
      <p>${esc(t("designs.working"))}</p>
    </div>

    <section id="dg-result" class="dg-result" hidden>
      <div id="dg-out" class="dg-out"></div>
      <div class="dg-actions">
        <button id="dg-again" class="dg-quiet" type="button">${esc(t("designs.try_again"))}</button>
        <button id="dg-download" class="dg-quiet" type="button">${esc(t("common.download"))}</button>
        <button id="dg-save" class="dg-keep" type="button">${esc(t("designs.save_to_lookbook"))}</button>
      </div>
      <p class="dg-caveat">${esc(t("designs.caveat"))}</p>
    </section>`;
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
  window.HubDesigns = { mount, buildPrompt };
  if (window.Hub && typeof window.Hub.registerSection === "function") {
    window.Hub.registerSection("designs", { mount });
  }
}
