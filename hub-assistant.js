/* FAKESNIFF Hub — the assistant panel. Owner: Claude.
 *
 * The browser half of the assistant. The thinking happens in the Edge Function
 * (supabase/functions/assistant); this file only carries messages there and
 * carries out whatever it proposes.
 *
 * Two deliberate choices worth knowing:
 *
 * 1. It knows which page you are on and says so to the function, because the
 *    question "what should I do?" has a different answer on Work than it does
 *    standing in a factory with the Lookbook open.
 *
 * 2. It never acts on its own. The function proposes ONE action; this file
 *    shows it as a button the person presses. Marco reading "shall I take you
 *    to Decisions?" and choosing is very different from being moved.
 */

import { setLanguage, t } from "./hub-i18n.js";

const FN_PATH = "/functions/v1/assistant";
const AUTH_STORAGE_KEY = "fakesniff-hub-auth";
const LANG_KEY = "fakesniff-hub-language";

/* Claude — 2026-08-30: Marco owns this company and reads English poorly. The
   interface is English and translating all of it is a separate build, but the
   assistant knows every screen — so in his language it becomes the way he
   reads the rest of the Hub. Stored per browser, not per account, because it
   is a preference about reading rather than something the workspace owns. */
const LANGUAGES = [
  ["en", "English"],
  ["nl", "Nederlands"],
  ["tr", "Türkçe"],
  ["ar", "العربية"],
];
/* Claude — 2026-09-01: built from the nav dictionary rather than written out,
   so the greeting can never name a page differently from the button the person
   is looking at. The Dutch version used to say "Je bent op Home" beside a nav
   item reading "Start". */
const GREETING_KEYS = {
  home: "assistant.here_home",
  work: "assistant.here_work",
  "idea-lab": "assistant.here_ideas",
  lookbook: "assistant.here_lookbook",
  designs: "assistant.here_designs",
  decisions: "assistant.here_decisions",
};
const language = () => {
  try { return localStorage.getItem(LANG_KEY) || "en"; } catch { return "en"; }
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || document.querySelector("link[data-as-styles]")) return;
  stylesInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-as-styles", "");
  link.href = new URL("hub-assistant.css", import.meta.url).href;
  document.head.appendChild(link);
}

/* Reads the session the shell already established. Deliberately does not ask
   hub.js for anything — that file is Codex's and adding a hook for this would
   be a second reason for us both to edit it. */
function accessToken() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.currentSession?.access_token || "";
  } catch {
    return "";
  }
}

function currentSection() {
  const active = document.querySelector(".page-section.is-active");
  if (active?.id) return active.id;
  return (location.hash || "#home").replace(/^#/, "") || "home";
}

export function createAssistant(config) {
  const base = String(config?.supabaseUrl || "").replace(/\/$/, "");
  if (!base) return null;

  injectStyles();

  const history = [];
  let busy = false;

  const root = document.createElement("div");
  root.className = "as fs-scope";
  root.innerHTML = `
    <button id="as-open" class="as-open" type="button" aria-label="Ask the assistant">
      <span aria-hidden="true">✳</span>
      <span class="as-open-text">${esc(t("assistant.open"))}</span>
    </button>
    <section id="as-panel" class="as-panel" role="dialog" aria-modal="false"
             aria-labelledby="as-title" hidden>
      <header class="as-head">
        <div>
          <p class="as-eyebrow">FAKESNIFF</p>
          <h2 id="as-title" class="as-title">Ask anything</h2>
        </div>
        <label class="as-sr" for="as-lang">Language</label>
        <select id="as-lang" class="as-lang">
          ${LANGUAGES.map(([v, l]) => `<option value="${v}"${v === language() ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <button id="as-close" class="as-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div id="as-log" class="as-log" role="log" aria-live="polite"></div>
      <form id="as-form" class="as-form">
        <label class="as-sr" for="as-input">Your message</label>
        <textarea id="as-input" class="as-input" rows="1"
                  placeholder="What should I do next?"></textarea>
        <button id="as-send" class="as-send" type="submit" aria-label="Send">Send</button>
      </form>
    </section>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const panel = $("#as-panel");
  const log = $("#as-log");
  const input = $("#as-input");

  $("#as-open").addEventListener("click", open);
  $("#as-close").addEventListener("click", close);
  $("#as-lang").addEventListener("change", (e) => {
    /* Claude — 2026-08-30, after Codex caught it: this recorded the choice and
       nothing else, so picking Nederlands left the whole interface in English.
       setLanguage is what actually rewrites the page; storing the preference is
       something it already does. */
    setLanguage(e.target.value);
    document.querySelector(".as-open-text").textContent = t("assistant.open");
    lastGreetedSection = "";
    log.replaceChildren();
    greet();
  });
  $("#as-form").addEventListener("submit", onSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";                       // grow with the message
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  /* Claude — 2026-08-13: these live ABOVE the return on purpose. Anything
     declared with let/const after a return is never initialised — the line
     does not run — while function declarations are hoisted and work fine.
     That mismatch is what made greet() and the action buttons throw. */
  let lastGreetedSection = "";
  /* Claude — 2026-09-01, after Codex flagged the drift: this held its own
     English list, so a Dutch interface offered "Take me to Decisions" for a
     nav item reading "Besluiten". The person then looks for a page that is not
     on their screen. Read the same dictionary the nav renders from — one
     source, and it cannot fall behind a rename. */
  const prettySection = (id) => t(`nav.${String(id).replace(/-/g, "_")}`);

  return { open, close, destroy: () => root.remove() };

  function open() {
    panel.hidden = false;
    root.classList.add("as-is-open");
    greet();   // every time: the page you are on may have changed since last open
    input.focus();
  }

  function close() {
    panel.hidden = true;
    root.classList.remove("as-is-open");
  }

  function greet() {
    const here = currentSection();
    if (here === lastGreetedSection && log.childElementCount) return;
    lastGreetedSection = here;
    const key = GREETING_KEYS[here];
    say("assistant", key ? t(key, { page: t(`nav.${here.replace(/-/g, "_")}`) })
                         : t("assistant.here_any"));
  }

  function say(role, text, extra = "") {
    const row = document.createElement("div");
    row.className = `as-msg as-${role}`;
    row.innerHTML = `<p>${esc(text).replace(/\n/g, "<br>")}</p>${extra}`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  async function onSubmit(event) {
    event?.preventDefault?.();
    const message = input.value.trim();
    if (!message || busy) return;

    input.value = "";
    input.style.height = "auto";
    say("you", message);
    history.push({ role: "user", text: message });

    busy = true;
    const thinking = say("assistant", "…");
    thinking.classList.add("as-thinking");

    try {
      const token = accessToken();
      if (!token) throw new Error("signed out");

      const res = await fetch(`${base}${FN_PATH}`, {
        method: "POST",
        headers: { apikey: config.supabasePublishableKey || "", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message, section: currentSection(), language: language(), history: history.slice(-8) }),
      });
      const data = await res.json().catch(() => ({}));
      thinking.remove();

      if (res.status === 404) {
        say("assistant", "The assistant is not installed on this copy of the Hub. "
          + "You are on the test version — open salmansaab.github.io/fakesniff-hub and I will be there.");
        return;
      }
      if (!res.ok) { say("assistant", data.error || "That did not work. Try again."); return; }

      const reply = data.reply || "…";
      say("assistant", reply);
      history.push({ role: "assistant", text: reply });
      if (data.action) offerAction(data.action);
    } catch (err) {
      thinking.remove();
      /* Claude — 2026-08-13: this used to claim "could not reach the server"
         for every failure, including ones that had nothing to do with the
         network. Guessing at a cause we were not shown wasted a lot of time,
         so say what actually happened. */
      const why = String(err?.message || err);
      say("assistant", why === "signed out"
        ? "Your session has expired. Sign in again and I will pick this back up."
        : `That did not work: ${why}`);
      console.error("assistant:", err);
    } finally {
      busy = false;
      input.focus();
    }
  }

  /* An action is always a button. Nothing happens until it is pressed. */
  function offerAction(action) {
    const labels = {
      navigate: t("assistant.take_me_to", { page: prettySection(action.section) }),
      compose: t("assistant.open_form", { page: prettySection(action.section) }),
      image: t("assistant.make_picture"),
    };
    const label = labels[action.action];
    if (!label) return;

    const row = document.createElement("div");
    row.className = "as-msg as-action";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "as-do";
    btn.textContent = label;
    btn.addEventListener("click", () => { btn.disabled = true; void runAction(action, btn); });
    row.appendChild(btn);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }


  async function runAction(action, btn) {
    if (action.action === "navigate" || action.action === "compose") {
      location.hash = `#${action.section}`;
      close();
      if (action.action === "compose") {
        /* let the section mount before reaching for its add button */
        setTimeout(() => {
          document.querySelector("#dc-add, #lb-add, #new-work-button")?.click();
        }, 400);
      }
      return;
    }

    if (action.action === "image") {
      btn.textContent = "Making it…";
      try {
        const res = await fetch(`${base}${FN_PATH}`, {
          method: "POST",
          headers: { apikey: config.supabasePublishableKey || "", Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "image", prompt: action.prompt }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.image) { say("assistant", data.error || "That picture could not be made."); return; }
        say("assistant", "Here it is.",
          `<img class="as-img" src="${esc(data.image)}" alt="Generated: ${esc(action.prompt || "")}">`);
      } catch {
        say("assistant", "That picture could not be made. Try describing it differently.");
      } finally {
        btn.remove();
      }
    }
  }
}

if (typeof window !== "undefined") {
  window.HubAssistant = { createAssistant };
  /* Wait for the shell to have a session before showing anything. Polling is
     crude but it avoids adding a hook to hub.js, which Codex owns. */
  const start = Date.now();
  const tick = setInterval(() => {
    const cfg = globalThis.FAKESNIFF_HUB_CONFIG;
    const shellVisible = !document.getElementById("app-shell")?.hidden;
    /* Mark the throwaway copy so it can never be mistaken for the real one. */
    if (cfg?.supabaseUrl && !cfg.supabaseUrl.includes("kayxejofqyxoqlberrgw")) {
      document.body.classList.add("is-staging");
    }
    if (cfg?.supabaseUrl && shellVisible && accessToken()) {
      clearInterval(tick);
      createAssistant(cfg);
    } else if (Date.now() - start > 60000) {
      clearInterval(tick);
    }
  }, 700);
}
