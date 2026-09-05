/* FAKESNIFF Hub — the daily update. Owner: Claude.
 *
 * Marco, 4 September, section 9 of his 90-day plan: a short update at the end of
 * a working day or block, so he can see what happened without calling three
 * people. Emiel asked for the same thing the next day, unprompted, without
 * having seen that section. Two of the three people independently.
 *
 * The whole feature: a person writes a few lines about a working block, and
 * everyone else can read them, newest first, with who and when.
 *
 * The promise is exactly this: **visible in Home when Home is opened or
 * refreshed.** Nobody is notified.
 *
 * One rule under all of it: saving a report never completes a task, changes a
 * Work item, or creates a commitment. A report is an account of work. If posting
 * one could quietly close something, nobody could write an honest one.
 *
 * Codex owns where this sits in Home and calls mountUpdates after it has
 * verified membership. This file owns only what happens inside the two
 * containers it is handed. Importing it does nothing at all.
 *
 * Codex's 5 September integration review found six behavioural defects in the
 * first version of this file. Every one was real and every one is a way a person
 * loses text they typed. They shape most of what follows:
 *
 *   - the draft lives in state and is kept current on every keystroke, and a
 *     feed refresh never rebuilds the form;
 *   - load status belongs to the feed, not the composer, because a viewer has no
 *     composer and was being shown "nobody has posted" when the read had failed;
 *   - a duplicate-key retry is not proof the visible text was stored, so the
 *     stored row is re-read and compared before anything is cleared;
 *   - a save in flight freezes the form, and every completion is stamped with
 *     the operation that started it;
 *   - an obsolete read can never repaint or report over a newer one.
 */

import { t, onLanguageChange, currentLanguage } from "./hub-i18n.js";

const MAX = 1000;
const FEED_LIMIT = 40;
const ZONE = "Europe/Amsterdam";
const FIELDS = ["done", "open", "next"];
const COLUMNS = "id,author_id,done,open,next,reported_on,created_at,updated_at,edited_at";

/* ------------------------------------------------------------------ errors */

const CONSTRAINT_MESSAGES = [
  [/work_updates_not_empty/i, () => t("updates.err_empty")],
  [/work_updates_length/i, () => t("updates.err_long")],
  [/violates row-level security|permission denied|42501/i, () => t("updates.err_readonly")],
];

/* Failures the database decided. Anything else, on a write, is a request whose
   outcome we do not know. */
const DETERMINISTIC = /work_updates_not_empty|work_updates_length|row-level security|permission denied|42501/i;

/* Exported so it can be tested with no DOM and no network, the same way the
   Work and Decisions boundaries are. This is the function that decides whether
   Marco reads a sentence or reads `work_updates_not_empty`. */
export function humanUpdateError(raw) {
  const text = String(raw?.message || raw || "");
  for (const [pattern, sentence] of CONSTRAINT_MESSAGES) {
    if (pattern.test(text)) return sentence();
  }
  if (/failed to fetch|networkerror|load failed|aborted/i.test(text)) {
    return t("updates.err_network");
  }
  /* Deliberately not returning `text`. An unrecognised database error is still
     a database error, and showing its wording teaches people the Hub is broken.
     This is the branch that matters most, because it is the one for failures
     neither of us predicted. */
  return t("updates.err_unknown");
}

/* Codex, 5 Sep: never tell someone their update "did not save" after a network
   failure, because we cannot know that — the row may well be stored and only the
   reply lost. Say it could not be confirmed and their words are still here. */
function writeError(raw) {
  if (DETERMINISTIC.test(String(raw?.message || raw || ""))) return humanUpdateError(raw);
  return t("updates.err_unconfirmed");
}

function isDuplicate(raw) {
  return raw?.code === "23505" || /duplicate key/i.test(String(raw?.message || ""));
}

/* ------------------------------------------------------------------- mount */

export function mountUpdates({ compose, feed, ctx }) {
  /* Codex places the containers and calls this after verifying membership.
     Their presence is not the condition for reading anything private — that is
     why membership is checked before the call rather than here. */
  if (!compose || !feed || !ctx) return inertHandle();

  ensureStyles();

  const canPost = Boolean(ctx?.member?.role) && ctx.member.role !== "viewer";
  const scope =
    `workspace_id=eq.${encodeURIComponent(ctx.workspaceId)}&archived_at=is.null`;

  let alive = true;
  /* Reads carry the generation they began in; writes carry the operation. A
     result from an older one is discarded rather than allowed to paint, report
     an error, or clear text that now belongs to a different draft. */
  let generation = 0;
  let operation = 0;
  const inFlight = new Set();

  let draft = blank();
  let submissionId = newId();
  let editing = null;
  let busy = false;

  let rows = [];
  let names = new Map();
  let loadState = "idle";           // idle | loading | loaded | error
  let loadError = "";
  let notice = null;                // composer feedback: { kind, text }

  let ui = null;                    // live references into the built form

  const stopListening = onLanguageChange(() => {
    if (!alive) return;
    buildCompose();                 // labels change; draft comes from state
    renderFeed();
  });

  buildCompose();
  renderFeed();

  /* --------------------------------------------------------------- network */

  async function rest(path, options = {}) {
    const controller = new AbortController();
    inFlight.add(controller);
    try {
      const token = await ctx.getAccessToken();
      const res = await fetch(`${ctx.restUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          apikey: ctx.anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      const body = await res.text();
      if (!res.ok) {
        let detail = body;
        let code = "";
        try {
          const parsed = JSON.parse(body);
          detail = parsed.message || parsed.details || body;
          code = parsed.code || "";
        } catch { /* keep the raw text for the matcher, never for the screen */ }
        const error = new Error(detail);
        /* Codex, 5 Sep: preserve the code. "duplicate key" in a message is a
           guess; 23505 is the database saying so. */
        error.code = code;
        error.status = res.status;
        throw error;
      }
      return body ? JSON.parse(body) : null;
    } finally {
      inFlight.delete(controller);
    }
  }

  async function fetchFeed() {
    const list = await rest(
      `/work_updates?select=${COLUMNS}&${scope}` +
      `&order=reported_on.desc,created_at.desc&limit=${FEED_LIMIT}`,
    );

    /* author_id points at auth.users, so there is no PostgREST embed to members
       to lean on. Names are a separate small read, and a failure here must never
       hide a report — an update with an unknown author is still the account of
       work somebody wrote. */
    let found = new Map();
    try {
      const people = await rest(
        `/members?select=user_id,display_name&${scope.replace("&archived_at=is.null", "")}` +
        `&archived_at=is.null`,
      );
      found = new Map((people || []).map((m) => [m.user_id, m.display_name]));
    } catch { /* names are decoration; reports are not */ }

    return { rows: Array.isArray(list) ? list : [], names: found };
  }

  async function refresh() {
    if (!alive) return;
    const mine = ++generation;

    if (loadState === "idle") {
      loadState = "loading";
      renderFeed();
    }

    try {
      const data = await fetchFeed();
      if (!alive || mine !== generation) return;   // a newer read already won
      rows = data.rows;
      names = data.names;
      loadState = "loaded";
      loadError = "";
      renderFeed();
    } catch (err) {
      /* The guard covers the failure path too. Codex's regression: an older
         refresh rejecting after a newer one succeeded was putting an error over
         a screen that was already correct. */
      if (!alive || mine !== generation) return;
      loadState = "error";
      loadError = humanUpdateError(err);
      renderFeed();
    }
  }

  /* ------------------------------------------------------------------ save */

  async function post() {
    if (busy) return;
    if (!hasContent(draft)) {
      notice = { kind: "error", text: t("updates.err_empty") };
      return syncCompose();
    }

    const op = ++operation;
    const attempted = { ...draft };
    setBusy(true);
    notice = null;
    syncCompose();

    try {
      await rest("/work_updates", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ id: submissionId, workspace_id: ctx.workspaceId, ...attempted }),
      });
    } catch (err) {
      if (!alive || op !== operation) return;
      if (isDuplicate(err)) return resolveDuplicate(op, attempted);
      setBusy(false);
      notice = { kind: "error", text: writeError(err) };
      return syncCompose();
    }

    if (!alive || op !== operation) return;
    await settled(op, t("updates.posted"), t("updates.posted_stale"));
  }

  /* The row already exists under this submission id, which means an earlier
     attempt did reach the database. That is NOT proof that what is on screen
     now was stored: the person may have changed their text between attempts.
     Codex's regression. So read back what was actually saved and compare before
     clearing anybody's words. */
  async function resolveDuplicate(op, attempted) {
    let saved = null;
    try {
      const found = await rest(
        `/work_updates?select=${COLUMNS}&id=eq.${encodeURIComponent(submissionId)}` +
        `&${scope}&author_id=eq.${encodeURIComponent(ctx.member.id)}&limit=1`,
      );
      saved = Array.isArray(found) ? found[0] : null;
    } catch { /* fall through to the unverified branch */ }

    if (!alive || op !== operation) return;

    if (saved && FIELDS.every((f) => (saved[f] || "") === (attempted[f] || ""))) {
      return settled(op, t("updates.posted"), t("updates.posted_stale"));
    }

    if (saved) {
      /* Their newer words are kept and the report they belong to is opened for
         correction, so the fix is one button rather than a retype. */
      setBusy(false);
      editing = { id: saved.id, seen: saved.updated_at };
      draft = { ...attempted };
      notice = { kind: "error", text: t("updates.err_already_saved") };
      buildCompose();
      return refresh();
    }

    setBusy(false);
    notice = { kind: "error", text: t("updates.err_unconfirmed") };
    syncCompose();
  }

  async function settled(op, okText, staleText) {
    if (!alive || op !== operation) return;
    draft = blank();
    submissionId = newId();
    editing = null;
    setBusy(false);
    buildCompose();

    try {
      const mine = ++generation;
      const data = await fetchFeed();
      if (!alive || op !== operation) return;
      if (mine === generation) {
        rows = data.rows;
        names = data.names;
        loadState = "loaded";
        loadError = "";
      }
      notice = { kind: "ok", text: okText };
    } catch {
      if (!alive || op !== operation) return;
      /* The save is confirmed and the list is not. Say both, in that order.
         Anything vaguer reads as failure and invites a second copy of something
         already stored. */
      notice = { kind: "ok", text: staleText };
    }
    syncCompose();
    renderFeed();
  }

  async function saveEdit() {
    if (busy || !editing) return;
    if (!hasContent(draft)) {
      notice = { kind: "error", text: t("updates.err_empty") };
      return syncCompose();
    }

    const op = ++operation;
    const target = editing;
    setBusy(true);
    notice = null;
    syncCompose();

    let result;
    try {
      /* updated_at is the concurrency gate: if another device changed this
         report since it was loaded, nothing matches and PostgREST returns an
         empty array rather than overwriting their correction. workspace_id and
         archived_at are here because the agreed interface requires every read
         and write to be scoped, not because id alone would match twice. */
      result = await rest(
        `/work_updates?id=eq.${encodeURIComponent(target.id)}` +
        `&updated_at=eq.${encodeURIComponent(target.seen)}&${scope}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ done: draft.done, open: draft.open, next: draft.next }),
        },
      );
    } catch (err) {
      if (!alive || op !== operation) return;
      setBusy(false);
      notice = { kind: "error", text: writeError(err) };
      return syncCompose();
    }

    /* Codex's regression: this completion belongs to the draft that started it.
       If the person cancelled and began a new report while it was in flight,
       finishing here must not reach in and clear their new words. */
    if (!alive || op !== operation) return;

    if (!Array.isArray(result) || result.length === 0) {
      setBusy(false);
      notice = { kind: "error", text: t("updates.err_changed_elsewhere") };
      return syncCompose();
    }

    await settled(op, t("updates.saved"), t("updates.saved_stale"));
  }

  function startEdit(row) {
    if (busy || !canPost || row.author_id !== ctx.member?.id) return;
    editing = { id: row.id, seen: row.updated_at };
    draft = { done: row.done || "", open: row.open || "", next: row.next || "" };
    notice = null;
    buildCompose();
    ui?.fields?.done?.focus();
  }

  function cancelEdit() {
    if (busy) return;               // a save in flight owns the form
    editing = null;
    draft = blank();
    notice = null;
    buildCompose();
  }

  /* ---------------------------------------------------------------- render */

  function buildCompose() {
    compose.textContent = "";
    compose.className = "hu-compose";
    ui = null;
    if (!canPost) return;

    const form = el("form", "hu-form");
    form.setAttribute("novalidate", "");
    const fields = {};

    for (const name of FIELDS) {
      const wrap = el("label", "hu-field");
      wrap.append(el("span", "hu-label", t(`updates.${name}`)));
      const area = document.createElement("textarea");
      area.className = "hu-input";
      area.name = name;
      area.rows = 2;
      area.maxLength = MAX;
      area.value = draft[name];
      area.placeholder = t(`updates.${name}_hint`);
      /* The draft is authoritative and is kept current on every keystroke.
         Reading the DOM only at submit time was how a refresh could paint stale
         state back over what somebody was typing. */
      area.addEventListener("input", () => { draft[name] = area.value; });
      wrap.append(area);
      form.append(wrap);
      fields[name] = area;
    }

    const bar = el("div", "hu-actions");
    const submit = el("button", "hu-post", editing ? t("common.save") : t("updates.post"));
    submit.type = "submit";
    bar.append(submit);

    let cancel = null;
    if (editing) {
      cancel = el("button", "hu-cancel", t("common.cancel"));
      cancel.type = "button";
      cancel.addEventListener("click", cancelEdit);
      bar.append(cancel);
    }
    form.append(bar);

    const line = el("p", "hu-notice");
    form.append(line);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      if (editing) saveEdit(); else post();
    });

    compose.append(form);
    ui = { form, fields, submit, cancel, notice: line };
    syncCompose();
  }

  /* Updates the built form in place. Never rebuilds it, so a refresh cannot
     take the caret out of someone's hands mid-sentence. */
  function syncCompose() {
    if (!ui) return;

    for (const name of FIELDS) {
      const area = ui.fields[name];
      if (area.value !== draft[name]) area.value = draft[name];
      area.disabled = busy;
    }
    ui.submit.disabled = busy;
    if (ui.cancel) ui.cancel.disabled = busy;

    ui.notice.textContent = notice ? notice.text : "";
    ui.notice.className = notice ? `hu-notice hu-notice-${notice.kind}` : "hu-notice";
    if (notice) ui.notice.setAttribute("role", notice.kind === "error" ? "alert" : "status");
    else ui.notice.removeAttribute("role");
  }

  function renderFeed() {
    feed.textContent = "";
    feed.className = "hu-feed";

    /* Load status lives here rather than in the composer. A viewer has no
       composer at all, and was being told "nobody has posted yet" when the read
       had simply failed. Codex's regression, and the worst of the six: it is the
       one that quietly tells Marco his team did nothing. */
    if (loadState === "error") {
      const alert = el("p", "hu-notice hu-notice-error", loadError || t("updates.err_network"));
      alert.setAttribute("role", "alert");
      feed.append(alert);
      const again = el("button", "hu-retry", t("common.try_again"));
      again.type = "button";
      again.addEventListener("click", () => refresh());
      feed.append(again);
      return;
    }

    if (loadState === "loading" && !rows.length) {
      const status = el("p", "hu-empty", t("common.loading"));
      status.setAttribute("role", "status");
      feed.append(status);
      return;
    }

    if (!rows.length) {
      feed.append(el("p", "hu-empty", t("updates.empty")));
      return;
    }

    let lastDay = null;
    for (const row of rows) {
      if (row.reported_on !== lastDay) {
        lastDay = row.reported_on;
        feed.append(el("h3", "hu-day", formatDay(row.reported_on)));
      }
      feed.append(renderRow(row));
    }
  }

  function renderRow(row) {
    const card = el("article", "hu-item");

    const head = el("div", "hu-head");
    head.append(el("span", "hu-who", names.get(row.author_id) || t("updates.someone")));
    head.append(el("span", "hu-when", formatTime(row.created_at)));
    if (row.edited_at) head.append(el("span", "hu-edited", t("updates.edited")));

    if (canPost && row.author_id === ctx.member?.id) {
      const edit = el("button", "hu-edit", t("updates.correct"));
      edit.type = "button";
      edit.disabled = busy;
      edit.addEventListener("click", () => startEdit(row));
      head.append(edit);
    }
    card.append(head);

    for (const name of FIELDS) {
      const value = (row[name] || "").trim();
      if (!value) continue;
      const line = el("div", "hu-line");
      line.append(el("span", "hu-line-label", t(`updates.${name}`)));
      /* textContent, never innerHTML. Everything below this point is text a
         person typed. */
      line.append(el("span", "hu-line-text", value));
      card.append(line);
    }
    return card;
  }

  /* ----------------------------------------------------------------- bits */

  function setBusy(value) {
    busy = value;
    syncCompose();
  }

  function formatDay(iso) {
    try {
      return new Intl.DateTimeFormat(currentLanguage(), {
        weekday: "long", day: "numeric", month: "long", timeZone: ZONE,
      }).format(new Date(`${iso}T12:00:00Z`));
    } catch {
      return iso;
    }
  }

  function formatTime(iso) {
    try {
      return new Intl.DateTimeFormat(currentLanguage(), {
        hour: "2-digit", minute: "2-digit", timeZone: ZONE,
      }).format(new Date(iso));
    } catch {
      return "";
    }
  }

  /* --------------------------------------------------------------- handle */

  return {
    refresh,

    openComposer() {
      if (!alive || !canPost) return;   // a viewer has nothing to open
      ui?.fields?.done?.focus();
    },

    destroy() {
      alive = false;
      generation += 1;
      operation += 1;
      /* Abort before clearing, so a response in flight cannot repaint a
         container that now belongs to a different signed-in person. */
      inFlight.forEach((controller) => { try { controller.abort(); } catch { /* already gone */ } });
      inFlight.clear();
      stopListening();
      draft = blank();
      editing = null;
      rows = [];
      names = new Map();
      notice = null;
      loadState = "idle";
      loadError = "";
      ui = null;
      compose.textContent = "";
      feed.textContent = "";
      compose.className = "";
      feed.className = "";
    },
  };
}

/* --------------------------------------------------------------- helpers */

let stylesInjected = false;

function ensureStyles() {
  if (stylesInjected || document.querySelector("link[data-hu-styles]")) return;
  stylesInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-hu-styles", "");
  /* Inherit the module's own deploy stamp, so an updated module can never be
     served yesterday's stylesheet out of cache. deploy.sh adds ?v=<timestamp>
     to the script, and without this the CSS quietly ignored it. */
  const here = new URL(import.meta.url);
  const href = new URL("hub-updates.css", here);
  href.search = here.search;
  link.href = href.href;
  document.head.appendChild(link);
}

function inertHandle() {
  /* Missing containers mean no mount and no request. Codex can move, rename or
     omit them and the worst case is the feature is invisible, never a page that
     fails to boot. */
  return { refresh: async () => {}, openComposer() {}, destroy() {} };
}

function blank() {
  return { done: "", open: "", next: "" };
}

function hasContent(d) {
  return /\S/.test(d.done) || /\S/.test(d.open) || /\S/.test(d.next);
}

function newId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();

  /* Older WebViews, and Emiel is on a phone. The column is `uuid`, so the
     fallback has to be a real v4 and not merely a unique-looking string —
     anything else is rejected by Postgres at the moment somebody tries to post
     their first update, which is the worst possible time to find out. */
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
