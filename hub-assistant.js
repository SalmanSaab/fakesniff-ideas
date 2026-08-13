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

const FN_PATH = "/functions/v1/assistant";
const AUTH_STORAGE_KEY = "fakesniff-hub-auth";

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
      <span class="as-open-text">Ask</span>
    </button>
    <section id="as-panel" class="as-panel" role="dialog" aria-modal="false"
             aria-labelledby="as-title" hidden>
      <header class="as-head">
        <div>
          <p class="as-eyebrow">FAKESNIFF</p>
          <h2 id="as-title" class="as-title">Ask anything</h2>
        </div>
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

  return { open, close, destroy: () => root.remove() };

  function open() {
    panel.hidden = false;
    root.classList.add("as-is-open");
    if (!log.childElementCount) greet();
    input.focus();
  }

  function close() {
    panel.hidden = true;
    root.classList.remove("as-is-open");
  }

  function greet() {
    const where = {
      home: "You are on Home. I can tell you what needs attention, or take you anywhere.",
      work: "You are on Work. Ask me what to do next, or what is waiting on someone.",
      "idea-lab": "You are in the Idea Lab. Ask me what is worth turning into something.",
      lookbook: "You are in the Lookbook. I can describe what you have saved, or make a picture.",
      decisions: "You are on Decisions. Ask me what we agreed, or record something new.",
    }[currentSection()] || "Ask me anything about the workspace.";
    say("assistant", where);
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
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message, section: currentSection(), history: history.slice(-8) }),
      });
      const data = await res.json().catch(() => ({}));
      thinking.remove();

      if (!res.ok) { say("assistant", data.error || "That did not work. Try again."); return; }

      const reply = data.reply || "…";
      say("assistant", reply);
      history.push({ role: "assistant", text: reply });
      if (data.action) offerAction(data.action);
    } catch (err) {
      thinking.remove();
      say("assistant", String(err.message) === "signed out"
        ? "Your session has expired. Sign in again and I will pick this back up."
        : "That did not reach the server. Check your connection and try again.");
    } finally {
      busy = false;
      input.focus();
    }
  }

  /* An action is always a button. Nothing happens until it is pressed. */
  function offerAction(action) {
    const labels = {
      navigate: `Take me to ${prettySection(action.section)}`,
      compose: `Open the ${prettySection(action.section)} form`,
      image: "Make that picture",
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

  const prettySection = (id) => ({
    home: "Home", work: "Work", "idea-lab": "the Idea Lab",
    lookbook: "the Lookbook", decisions: "Decisions",
  }[id] || id);

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
          headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
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
    if (cfg?.supabaseUrl && shellVisible && accessToken()) {
      clearInterval(tick);
      createAssistant(cfg);
    } else if (Date.now() - start > 60000) {
      clearInterval(tick);
    }
  }, 700);
}
