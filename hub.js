/* Codex — 2026-08-11: authenticated Hub controller. No company records are embedded in this file. */

import { createHubAuth, validateHubConfig } from "./hub-auth.js";
import { createConnectedWorkRepository, HubRepositoryError } from "./hub-work-repository.js";

const STATUSES = ["backlog", "this_week", "doing", "review", "waiting", "done"];
const ACTIVE_STATUSES = new Set(["this_week", "doing", "review", "waiting"]);
const STATUS_LABELS = {
  backlog: "Backlog",
  this_week: "This week",
  doing: "Doing",
  review: "Review / Decision",
  waiting: "Waiting / Blocked",
  done: "Done"
};
const STATUS_GUIDANCE = {
  backlog: "Backlog is simple: only the title is required. Add the working details when this is ready to move.",
  this_week: "For This week, choose an owner, due date, next step, and what Done means. The team keeps no more than three items here.",
  doing: "To start Doing, complete the working details. Each person keeps one item in progress at a time.",
  review: "For Review, complete the working details and choose someone other than the owner to approve it.",
  waiting: "For Waiting, keep the working details and say exactly which person, answer, file, or event is needed.",
  done: "To finish an item, record its owner and the result that means it is Done."
};
const FLAG_LABELS = {
  legal: "Legal",
  budget: "Budget",
  supplier: "Supplier",
  account_access: "Account access",
  missing_assets: "Missing assets"
};
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const REGISTERABLE_SECTION_IDS = new Set(["idea-lab"]);
const registeredSections = new Map();

const state = {
  config: null,
  auth: null,
  repository: null,
  authSubscription: null,
  generation: 0,
  refreshSequence: 0,
  mutationSequence: 0,
  user: null,
  membership: null,
  workspace: null,
  members: [],
  workstreams: [],
  tasks: [],
  saving: false,
  refreshing: false,
  stale: false,
  activeSectionId: "home",
  mobileWorkStatus: "this_week",
  originalApproverId: "",
  formBaseline: null,
  noticeTimer: null,
  dialogOpener: null,
  dialogOpenerTaskId: ""
};

const get = (id) => document.getElementById(id);
const accessScreen = get("access-screen");
const appShell = get("app-shell");
const accessLoading = get("access-loading");
const accessCopy = get("access-copy");
const accessStatus = get("access-status");
const signInForm = get("signin-form");
const setupActions = get("setup-actions");
const retryAccessButton = get("retry-access-button");
const accessSignOutButton = get("access-signout-button");
const localPreviewLink = get("local-preview-link");
const signOutButton = get("signout-button");
const refreshButton = get("refresh-button");
const board = document.querySelector(".board");
const boardStatus = get("work-board-status");
const dialog = get("work-dialog");
const form = get("work-form");
const formError = get("work-form-error");
const newWorkButton = get("new-work-button");
const archiveButton = get("archive-work-button");
const saveButton = get("save-work-button");
const statusInput = get("work-status");
const ownerInput = get("work-owner");
const approverInput = get("work-approver");
const searchInput = get("work-search");
const ownerFilter = get("work-owner-filter");
const workStageFilter = get("work-stage-filter");
const mobileSignOutButton = get("mobile-signout-button");
const primaryNav = document.querySelector(".primary-nav");
const navLinks = [...document.querySelectorAll('.nav-link[href^="#"]')];

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function isLoopback() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/* Codex — 2026-08-11: authenticated module bridge. Idea Lab stays in its own
   file and receives only the minimum session/workspace context it needs. */
function sectionIdFromHash() {
  const candidate = window.location.hash.replace(/^#/, "");
  return get(candidate)?.classList.contains("page-section") ? candidate : "home";
}

function sectionContextKey() {
  const member = state.membership;
  if (!member || !state.user) return "";
  return [state.generation, member.user_id, member.display_name, member.role, state.config?.workspaceId].join("|");
}

function sectionContextIsCurrent(generation, userId) {
  return Boolean(
    state.auth
    && state.membership
    && state.user?.id === userId
    && state.membership.user_id === userId
    && state.generation === generation
  );
}

function buildSectionContext() {
  const generation = state.generation;
  const userId = state.membership.user_id;
  const auth = state.auth;
  const config = state.config;
  const member = Object.freeze({
    id: userId,
    name: state.membership.display_name,
    role: state.membership.role
  });

  return Object.freeze({
    restUrl: `${config.supabaseUrl}/rest/v1`,
    async getAccessToken() {
      if (!sectionContextIsCurrent(generation, userId)) throw new Error("The Hub session changed.");
      const token = await auth.getAccessToken(userId);
      if (!sectionContextIsCurrent(generation, userId)) throw new Error("The Hub session changed.");
      return token;
    },
    anonKey: config.supabasePublishableKey,
    member,
    workspaceId: config.workspaceId
  });
}

function cleanupFromMountResult(result) {
  if (typeof result === "function") return result;
  if (result && typeof result.destroy === "function") return () => result.destroy();
  return null;
}

function clearRegisteredSection(registration) {
  registration.sequence += 1;
  registration.mountingKey = "";
  registration.contextKey = "";
  if (typeof registration.cleanup === "function") {
    try {
      registration.cleanup();
    } catch {
      // The Hub still clears the integration root even if optional cleanup fails.
    }
  }
  registration.cleanup = null;
  registration.root.replaceChildren();
}

function clearRegisteredSections() {
  registeredSections.forEach(clearRegisteredSection);
}

function renderSectionLoadError(root) {
  const message = createElement("div", "module-placeholder");
  message.setAttribute("role", "alert");
  message.append(
    createElement("span", "preview-label", "Could not load"),
    createElement("h2", "", "Idea Lab is temporarily unavailable."),
    createElement("p", "", "Refresh the Hub and try again. Your existing ideas were not changed.")
  );
  root.replaceChildren(message);
}

async function mountRegisteredSection(sectionId) {
  const registration = registeredSections.get(sectionId);
  if (!registration || !state.auth || !state.user || !state.membership || !state.workspace || appShell.hidden) return;

  const contextKey = sectionContextKey();
  if (!contextKey || registration.contextKey === contextKey || registration.mountingKey === contextKey) return;

  clearRegisteredSection(registration);
  const mountSequence = registration.sequence;
  const generation = state.generation;
  const userId = state.user.id;
  registration.mountingKey = contextKey;

  try {
    const mounted = await registration.module.mount(registration.root, buildSectionContext());
    const cleanup = cleanupFromMountResult(mounted);
    if (registration.sequence !== mountSequence || !sectionContextIsCurrent(generation, userId)) {
      if (cleanup) {
        try {
          cleanup();
        } catch {
          // A stale module cannot prevent its root from being cleared.
        }
      }
      if (registration.sequence === mountSequence) registration.root.replaceChildren();
      return;
    }
    registration.cleanup = cleanup;
    registration.contextKey = contextKey;
  } catch {
    if (registration.sequence === mountSequence && sectionContextIsCurrent(generation, userId)) {
      renderSectionLoadError(registration.root);
    }
  } finally {
    if (registration.sequence === mountSequence) registration.mountingKey = "";
  }
}

function activateSection(sectionId) {
  const normalized = get(sectionId)?.classList.contains("page-section") ? sectionId : "home";
  state.activeSectionId = normalized;
  navLinks.forEach((link) => {
    const current = link.getAttribute("href") === `#${normalized}`;
    link.classList.toggle("is-current", current);
    if (current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  void mountRegisteredSection(normalized);
}

function registerSection(sectionId, module) {
  const id = String(sectionId || "").trim();
  if (!REGISTERABLE_SECTION_IDS.has(id)) throw new Error(`Unknown Hub section: ${id}`);
  if (!module || typeof module.mount !== "function") throw new TypeError("A Hub section needs a mount(rootEl, ctx) function.");
  if (registeredSections.has(id)) throw new Error(`Hub section already registered: ${id}`);
  const root = get(id);
  if (!root) throw new Error(`Hub section root is missing: ${id}`);

  registeredSections.set(id, {
    module,
    root,
    sequence: 0,
    mountingKey: "",
    contextKey: "",
    cleanup: null
  });
  const navMeta = document.querySelector(`.nav-link[href="#${id}"] .nav-meta`);
  if (navMeta) navMeta.remove();
  if (state.activeSectionId === id) void mountRegisteredSection(id);
}

Object.defineProperty(globalThis, "Hub", {
  value: Object.freeze({ registerSection }),
  configurable: false,
  enumerable: true,
  writable: false
});

function setAccessView({ copy, loading = false, signin = false, setup = false, retry = false, switchAccount = false, status = "" }) {
  appShell.hidden = true;
  accessScreen.hidden = false;
  accessCopy.textContent = copy;
  accessLoading.hidden = !loading;
  signInForm.hidden = !signin;
  setupActions.hidden = !setup;
  retryAccessButton.hidden = !retry;
  accessSignOutButton.hidden = !switchAccount;
  accessStatus.textContent = status;
  document.querySelector(".skip-link")?.setAttribute("href", "#access-screen");
  window.requestAnimationFrame(() => {
    if (accessScreen.hidden) return;
    if (signin && !signInForm.hidden) get("team-email").focus();
    else accessScreen.focus();
  });
}

function showSetupMode(configErrors = []) {
  const detail = configErrors.length ? "The connected configuration is incomplete." : "The connected workspace has not been enabled yet.";
  setAccessView({ copy: detail, setup: true, status: configErrors.join(" ") });
  localPreviewLink.hidden = !isLoopback();
}

function showSignedOut(status = "") {
  clearWorkspaceState();
  setAccessView({
    copy: "Use an invited email address. We will send a one-time sign-in link.",
    signin: true,
    status
  });
  get("team-email").disabled = false;
  get("signin-button").disabled = false;
}

function showChecking(copy = "Verifying your invited workspace membership…") {
  setAccessView({ copy, loading: true });
}

function showAccessDenied() {
  clearWorkspaceState();
  setAccessView({
    copy: "This signed-in account does not have active access to the FAKESNIFF workspace.",
    retry: true,
    switchAccount: true,
    status: "Ask a workspace owner to confirm the invitation and membership record."
  });
}

function clearWorkspaceState() {
  state.refreshSequence += 1;
  state.mutationSequence += 1;
  setSaving(false);
  state.refreshing = false;
  clearRegisteredSections();
  state.formBaseline = null;
  clearNotice();
  state.user = null;
  state.membership = null;
  state.workspace = null;
  state.members = [];
  state.workstreams = [];
  state.tasks = [];
  state.stale = false;
  state.dialogOpener = null;
  state.dialogOpenerTaskId = "";
  if (dialog?.open) dialog.close();
  form?.reset();
  clearFormError();
  searchInput.value = "";
  get("workspace-label").textContent = "FAKESNIFF workspace";
  get("rail-member-label").textContent = "Member";
  get("member-avatar").textContent = "?";
  get("home-member-kicker").textContent = "Workspace overview";
  get("member-role-pill").textContent = "Member";
  ownerFilter.replaceChildren();
  appendOption(ownerFilter, "all", "All owners");
  appendOption(ownerFilter, "unassigned", "Owner needed");
  ownerInput.replaceChildren();
  appendOption(ownerInput, "", "Owner needed");
  approverInput.replaceChildren();
  appendOption(approverInput, "", "No approver");
  get("work-workstream").replaceChildren();
  appendOption(get("work-workstream"), "", "No area");
  state.originalApproverId = "";
  get("work-more-details").open = false;
  if (board) {
    STATUSES.forEach((status) => {
      get(`${status}-items`)?.replaceChildren();
      const count = get(`${status}-count`);
      if (count) {
        count.textContent = "0";
        count.setAttribute("aria-label", `0 ${STATUS_LABELS[status]} items shown`);
      }
    });
  }
  boardStatus.textContent = "";
  get("home-week-list")?.replaceChildren();
  get("home-attention-list")?.replaceChildren();
  hideAppError();
  get("work-nav-count").textContent = "0";
  get("work-nav-count").setAttribute("aria-label", "0 active work items");
  get("home-active-work-count").textContent = "00";
  get("home-active-work-note").textContent = "No active owners";
  get("home-week-count").textContent = "00";
  get("home-review-count").textContent = "00";
  get("home-waiting-count").textContent = "00";
  setMobileWorkStatus("this_week");
}

function canEdit() {
  return ROLE_RANK[state.membership?.role] >= ROLE_RANK.member && !state.stale;
}

function isAdmin() {
  return ROLE_RANK[state.membership?.role] >= ROLE_RANK.admin;
}

function memberMap() {
  return new Map(state.members.map((member) => [member.user_id, member]));
}

function workstreamMap() {
  return new Map(state.workstreams.map((workstream) => [workstream.id, workstream]));
}

function memberName(userId, fallback = "Owner needed") {
  if (!userId) return fallback;
  return memberMap().get(userId)?.display_name || "Former member";
}

function workstreamName(workstreamId) {
  if (!workstreamId) return "General";
  return workstreamMap().get(workstreamId)?.name || "Archived area";
}

function ownerClass(userId) {
  if (!userId) return "owner-unassigned";
  let value = 0;
  for (const character of userId) value = (value + character.charCodeAt(0)) % 3;
  return ["owner-s", "owner-e", "owner-m"][value];
}

function validWebUrl(value, httpsOnly = false) {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return httpsOnly ? parsed.protocol === "https:" : ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function formatDate(value) {
  if (!value) return "No date";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(parsed);
}

function isOverdue(task) {
  if (!task.due_on || task.status === "done") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${task.due_on}T00:00:00`) < today;
}

function makeExternalLink(url, label) {
  const link = createElement("a", "", label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function makeTaskCard(task) {
  const shell = createElement("div", "task-card-shell");
  const classes = ["task-card"];
  if (["this_week", "doing", "review"].includes(task.status)) classes.push("task-card-active");
  if (task.status === "waiting") classes.push("task-card-muted");
  if (task.status === "done") classes.push("task-card-done");

  const button = createElement("button", classes.join(" "));
  button.type = "button";
  button.dataset.taskId = task.id;
  button.setAttribute("aria-label", `${canEdit() ? "Edit" : "View"} ${task.title}. ${STATUS_LABELS[task.status]}.`);

  const top = createElement("span", "task-card-top");
  top.append(createElement("span", "task-type", workstreamName(task.workstream_id)));
  top.append(createElement("span", `priority-label priority-${task.priority}`, task.priority));
  button.append(top, createElement("span", "task-card-title", task.title));

  if (task.next_action) {
    const next = createElement("span", "task-card-next");
    next.append(createElement("strong", "", "Next: "), document.createTextNode(task.next_action));
    button.append(next);
  }
  if (task.status === "waiting" && task.blocker_note) {
    const blocker = createElement("span", "task-card-blocker");
    blocker.append(createElement("strong", "", "Blocked: "), document.createTextNode(task.blocker_note));
    button.append(blocker);
  }

  const flags = Array.isArray(task.flags) ? task.flags.filter((flag) => FLAG_LABELS[flag]) : [];
  if (flags.length || !task.owner_id) {
    const flagRow = createElement("span", "task-card-flags");
    flags.forEach((flag) => flagRow.append(createElement("span", "task-flag", FLAG_LABELS[flag])));
    if (!task.owner_id) flagRow.append(createElement("span", "task-flag task-flag-owner", "Owner needed"));
    button.append(flagRow);
  }

  const footer = createElement("span", "task-card-footer");
  footer.append(createElement("span", `owner-chip ${ownerClass(task.owner_id)}`, memberName(task.owner_id)));
  footer.append(createElement("span", isOverdue(task) ? "task-card-date-overdue" : "", formatDate(task.due_on)));
  button.append(footer);
  shell.append(button);

  const links = [];
  if (task.source_url && validWebUrl(task.source_url)) links.push([task.source_url, "Source ↗"]);
  if (task.latest_file_url && validWebUrl(task.latest_file_url, true)) links.push([task.latest_file_url, "Latest file ↗"]);
  if (links.length) {
    const linkRow = createElement("div", "task-card-links");
    links.forEach(([url, label]) => linkRow.append(makeExternalLink(url, label)));
    shell.append(linkRow);
  }
  return shell;
}

function taskMatches(task, search, ownerId) {
  if (ownerId === "unassigned" && task.owner_id) return false;
  if (ownerId !== "all" && ownerId !== "unassigned" && task.owner_id !== ownerId) return false;
  if (!search) return true;
  const flags = Array.isArray(task.flags) ? task.flags.map((flag) => FLAG_LABELS[flag] || "").join(" ") : "";
  return [
    task.title, workstreamName(task.workstream_id), memberName(task.owner_id),
    memberName(task.approver_id, "No approver"), task.next_action, task.completion_condition,
    task.blocker_note, flags, task.owner_id ? "" : "owner needed"
  ].join(" ").toLowerCase().includes(search);
}

function setMobileWorkStatus(status, { announce = false } = {}) {
  const nextStatus = STATUSES.includes(status) ? status : "this_week";
  state.mobileWorkStatus = nextStatus;
  workStageFilter.value = nextStatus;
  document.querySelectorAll(".board-column[data-work-status]").forEach((column) => {
    column.classList.toggle("is-mobile-current", column.dataset.workStatus === nextStatus);
  });
  if (announce) {
    const count = get(`${nextStatus}-count`).textContent;
    boardStatus.textContent = `Showing ${STATUS_LABELS[nextStatus]}: ${count} ${count === "1" ? "item" : "items"}.`;
  }
}

function renderBoard() {
  const search = searchInput.value.trim().toLowerCase();
  const ownerId = ownerFilter.value;
  const visible = state.tasks.filter((task) => taskMatches(task, search, ownerId));

  STATUSES.forEach((status) => {
    const container = get(`${status}-items`);
    const matches = visible.filter((task) => task.status === status);
    container.replaceChildren();
    matches.forEach((task) => container.append(makeTaskCard(task)));
    if (!matches.length) container.append(createElement("p", "board-empty", search || ownerId !== "all" ? "No matching work" : "No work here"));
    get(`${status}-count`).textContent = String(matches.length);
    get(`${status}-count`).setAttribute("aria-label", `${matches.length} ${STATUS_LABELS[status]} items shown`);
    const stageOption = [...workStageFilter.options].find((option) => option.value === status);
    if (stageOption) stageOption.textContent = `${STATUS_LABELS[status]} (${matches.length})`;
  });

  setMobileWorkStatus(state.mobileWorkStatus);
  boardStatus.textContent = `${visible.length} work ${visible.length === 1 ? "item" : "items"} shown.`;
  renderSummary();
}

function homeListItem(task, detail) {
  const row = createElement("a", "home-work-item");
  row.href = "#work";
  row.dataset.openTaskId = task.id;
  const copy = createElement("span", "");
  copy.append(createElement("strong", "", task.title), createElement("small", "", detail));
  row.append(copy, createElement("span", `owner-chip ${ownerClass(task.owner_id)}`, memberName(task.owner_id)));
  return row;
}

function renderHomeList(container, tasks, detailFor, emptyCopy) {
  container.replaceChildren();
  if (!tasks.length) {
    container.append(createElement("p", "module-empty-copy", emptyCopy));
    return;
  }
  tasks.forEach((task) => container.append(homeListItem(task, detailFor(task))));
}

function renderSummary() {
  const active = state.tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const week = state.tasks.filter((task) => task.status === "this_week");
  const review = state.tasks.filter((task) => task.status === "review");
  const waiting = state.tasks.filter((task) => task.status === "waiting");
  const owners = new Set(active.map((task) => task.owner_id).filter(Boolean));

  get("work-nav-count").textContent = String(active.length);
  get("work-nav-count").setAttribute("aria-label", `${active.length} active work items`);
  get("home-active-work-count").textContent = String(active.length).padStart(2, "0");
  get("home-active-work-note").textContent = owners.size ? `Across ${owners.size} ${owners.size === 1 ? "owner" : "owners"}` : "No active owners";
  get("home-week-count").textContent = String(week.length).padStart(2, "0");
  get("home-review-count").textContent = String(review.length).padStart(2, "0");
  get("home-waiting-count").textContent = String(waiting.length).padStart(2, "0");

  renderHomeList(get("home-week-list"), week, (task) => task.next_action || "Next step not recorded", "No work has been chosen for this week.");
  renderHomeList(
    get("home-attention-list"),
    [...review, ...waiting].slice(0, 5),
    (task) => task.status === "waiting" ? task.blocker_note : `Review by ${memberName(task.approver_id, "Approver needed")}`,
    "No reviews or blockers need attention."
  );
}

function appendOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function populateReferenceControls() {
  const currentFilter = ownerFilter.value;
  ownerFilter.replaceChildren();
  appendOption(ownerFilter, "all", "All owners");
  appendOption(ownerFilter, "unassigned", "Owner needed");

  const activeMembers = state.members.filter((member) => !member.archived_at);
  const editableMembers = activeMembers.filter((member) => ROLE_RANK[member.role] >= ROLE_RANK.member);
  activeMembers.forEach((member) => appendOption(ownerFilter, member.user_id, member.display_name));
  if ([...ownerFilter.options].some((option) => option.value === currentFilter)) ownerFilter.value = currentFilter;

  const ownerSelect = ownerInput;
  ownerSelect.replaceChildren();
  appendOption(ownerSelect, "", "Owner needed");
  editableMembers.forEach((member) => appendOption(ownerSelect, member.user_id, member.display_name));

  approverInput.replaceChildren();
  appendOption(approverInput, "", "No approver");
  editableMembers.forEach((member) => appendOption(approverInput, member.user_id, member.display_name));

  const workstreamSelect = get("work-workstream");
  workstreamSelect.replaceChildren();
  appendOption(workstreamSelect, "", "No area");
  state.workstreams
    .filter((workstream) => !workstream.archived_at && workstream.status === "active")
    .forEach((workstream) => appendOption(workstreamSelect, workstream.id, workstream.name));
}

function renderWorkspace({ focus = false } = {}) {
  populateReferenceControls();
  const role = state.membership.role;
  const displayName = state.membership.display_name;
  const activeWorkstreams = state.workstreams.filter((workstream) => !workstream.archived_at && workstream.status === "active");

  get("workspace-label").textContent = state.workspace?.name || "FAKESNIFF workspace";
  get("rail-member-label").textContent = `${displayName} · ${role}`;
  get("member-avatar").textContent = displayName.trim().slice(0, 1).toUpperCase() || "?";
  get("home-member-kicker").textContent = `Welcome, ${displayName}`;
  get("member-role-pill").textContent = role;
  get("work-mode-copy").textContent = role === "viewer"
    ? "You have read-only access. A workspace member must make changes."
    : "Signed-in changes are written to the private workspace.";
  const dataNote = get("work-data-note");
  dataNote.replaceChildren(createElement("strong", "", "Private data."), document.createTextNode(" Loaded for verified members only."));

  newWorkButton.hidden = !canEdit();
  newWorkButton.disabled = !canEdit() || activeWorkstreams.length === 0;
  if (canEdit() && activeWorkstreams.length === 0) {
    showAppError("Area setup is incomplete, so new work is disabled.");
  }
  renderBoard();
  appShell.hidden = false;
  accessScreen.hidden = true;
  document.querySelector(".skip-link")?.setAttribute("href", "#main-content");
  activateSection(sectionIdFromHash());
  setSyncState("Up to date", false);
  if (focus) window.requestAnimationFrame(() => get("main-content").focus());
}

function setSyncState(label, busy) {
  get("sync-label").textContent = label;
  refreshButton.disabled = Boolean(busy);
  get("connection-label").textContent = state.stale ? "Stale" : "Connected";
  get("connection-pulse").classList.toggle("pulse-warn", state.stale);
}

function showAppError(message) {
  get("app-error-copy").textContent = message;
  get("app-error").hidden = false;
}

function hideAppError() {
  get("app-error").hidden = true;
  get("app-error-copy").textContent = "";
}

/* Codex — 2026-08-11: visible outcomes and one shared dirty-form guard make
   common actions forgiving without changing the Work persistence contract. */
function clearNotice() {
  if (state.noticeTimer) window.clearTimeout(state.noticeTimer);
  state.noticeTimer = null;
  get("hub-notice-copy").textContent = "";
  get("hub-notice").hidden = true;
}

function showNotice(message) {
  clearNotice();
  get("hub-notice-copy").textContent = message;
  get("hub-notice").hidden = false;
  state.noticeTimer = window.setTimeout(clearNotice, 8000);
}

function formSnapshot() {
  return JSON.stringify([...form.querySelectorAll("input, select, textarea")].map((control) => ({
    id: control.id,
    value: control.type === "checkbox" ? control.checked : control.value
  })));
}

function captureFormBaseline() {
  state.formBaseline = formSnapshot();
}

function isFormDirty() {
  return Boolean(
    dialog.open
    && state.formBaseline !== null
    && ROLE_RANK[state.membership?.role] >= ROLE_RANK.member
    && formSnapshot() !== state.formBaseline
  );
}

function requestDialogClose() {
  if (state.saving) return;
  if (isFormDirty() && !window.confirm("Discard your unsaved changes?")) return;
  state.formBaseline = null;
  dialog.close();
}

async function requestWorkspaceRefresh() {
  if (state.refreshing) return;
  if (isFormDirty() && !window.confirm("Refresh the Hub and discard your unsaved changes?")) return;
  state.formBaseline = null;
  if (dialog.open) dialog.close();
  await refreshTasks();
}

function clearFieldError(control) {
  const errorId = control?.dataset?.fieldErrorId;
  if (!errorId) return;
  get(errorId)?.remove();
  const describedBy = (control.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (describedBy.length) control.setAttribute("aria-describedby", describedBy.join(" "));
  else control.removeAttribute("aria-describedby");
  control.removeAttribute("aria-invalid");
  delete control.dataset.fieldErrorId;
}

function clearFieldErrors() {
  form.querySelectorAll("[data-field-error-id]").forEach(clearFieldError);
  form.querySelectorAll(".field-error").forEach((message) => message.remove());
}

function clearEditedFieldError(event) {
  clearFieldError(event.target);
  formError.hidden = true;
  formError.textContent = "";
}

function clearFormError() {
  formError.hidden = true;
  formError.textContent = "";
  clearFieldErrors();
}

function showFormError(message, fieldId = "") {
  clearFieldErrors();
  formError.textContent = message;
  formError.hidden = false;
  const control = fieldId ? get(fieldId) : null;
  if (!control) {
    formError.focus();
    return;
  }
  if (get("work-more-details").contains(control)) get("work-more-details").open = true;
  const inlineError = createElement("small", "field-error", message);
  inlineError.id = `${fieldId}-field-error`;
  control.insertAdjacentElement("afterend", inlineError);
  const describedBy = new Set((control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  describedBy.add(inlineError.id);
  control.setAttribute("aria-describedby", [...describedBy].join(" "));
  control.setAttribute("aria-invalid", "true");
  control.dataset.fieldErrorId = inlineError.id;
  control.focus();
}

function addMissingReferenceOption(select, value, label) {
  if (!value || [...select.options].some((option) => option.value === value)) return;
  appendOption(select, value, label);
}

function setFormReadOnly(readOnly) {
  form.querySelectorAll("input, select, textarea").forEach((control) => {
    if (["work-id", "work-updated-at"].includes(control.id)) return;
    const textLike = control instanceof HTMLTextAreaElement
      || (control instanceof HTMLInputElement && control.type !== "checkbox");
    if (textLike) {
      control.disabled = false;
      control.readOnly = readOnly;
    } else {
      control.disabled = readOnly;
    }
    if (readOnly) control.setAttribute("aria-readonly", "true");
    else control.removeAttribute("aria-readonly");
  });
  saveButton.hidden = readOnly;
  get("cancel-work-button").textContent = readOnly ? "Close" : "Cancel";
}

function syncRequirements() {
  const status = statusInput.value;
  const active = ACTIVE_STATUSES.has(status);
  const done = status === "done";
  const review = status === "review";
  const waiting = status === "waiting";
  if (!review && !state.originalApproverId) approverInput.value = "";
  if (!waiting) get("work-blocker").value = "";
  get("work-approver-field").hidden = !review && !state.originalApproverId;
  get("work-blocker-field").hidden = !waiting;
  form.classList.toggle("is-active", active);
  form.classList.toggle("is-done", done);
  form.classList.toggle("is-waiting", waiting);
  form.classList.toggle("is-review", review);
  ownerInput.required = active || done;
  get("work-date").required = active;
  get("work-next-action").required = active;
  get("work-completion").required = active || done;
  get("work-blocker").required = waiting;
  approverInput.required = review;
  get("work-status-guidance").textContent = STATUS_GUIDANCE[status] || STATUS_GUIDANCE.backlog;
  clearFormError();
}

function taskById(id) {
  return state.tasks.find((task) => task.id === id);
}

function configureApprovalControls(task) {
  if (!task || !canEdit()) return;
  const actorIsApprover = task.approver_id && task.approver_id === state.membership.user_id;
  const admin = isAdmin();

  if (task.approver_id && !admin) approverInput.disabled = true;
  if (task.status === "review" && !actorIsApprover && !admin) statusInput.disabled = true;
  if (task.status === "done" && task.approver_id && !actorIsApprover && !admin) statusInput.disabled = true;
  if (task.approver_id && !actorIsApprover && !admin) {
    const doneOption = [...statusInput.options].find((option) => option.value === "done");
    if (doneOption) doneOption.disabled = true;
  }
  archiveButton.hidden = !(admin || actorIsApprover || (!task.approver_id && task.status !== "review"));
}

function openNewTask() {
  if (!canEdit() || newWorkButton.disabled || state.refreshing) return;
  state.dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.dialogOpenerTaskId = "";
  populateReferenceControls();
  form.reset();
  state.originalApproverId = "";
  get("work-more-details").open = false;
  setFormReadOnly(false);
  get("work-id").value = "";
  get("work-updated-at").value = "";
  statusInput.value = "backlog";
  get("work-priority").value = "normal";
  get("work-dialog-title").textContent = "New work item";
  archiveButton.hidden = true;
  syncRequirements();
  captureFormBaseline();
  dialog.showModal();
  get("work-title-input").focus();
}

function openTask(id) {
  if (state.refreshing) {
    boardStatus.textContent = "Wait for Refresh to finish before opening work.";
    return;
  }
  const task = taskById(id);
  if (!task) return;
  setMobileWorkStatus(task.status);
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.dialogOpener = activeElement?.matches("[data-open-task-id]") ? null : activeElement;
  state.dialogOpenerTaskId = id;
  populateReferenceControls();
  addMissingReferenceOption(get("work-workstream"), task.workstream_id, "Archived area");
  addMissingReferenceOption(ownerInput, task.owner_id, "Former member");
  addMissingReferenceOption(approverInput, task.approver_id, "Former member");
  setFormReadOnly(!canEdit());

  get("work-id").value = task.id;
  get("work-updated-at").value = task.updated_at;
  get("work-title-input").value = task.title;
  get("work-workstream").value = task.workstream_id || "";
  statusInput.value = task.status;
  ownerInput.value = task.owner_id || "";
  approverInput.value = task.approver_id || "";
  state.originalApproverId = task.approver_id || "";
  get("work-priority").value = task.priority;
  get("work-date").value = task.due_on || "";
  get("work-next-action").value = task.next_action || "";
  get("work-completion").value = task.completion_condition || "";
  get("work-blocker").value = task.blocker_note || "";
  form.querySelectorAll('input[name="flags"]').forEach((checkbox) => {
    checkbox.checked = Array.isArray(task.flags) && task.flags.includes(checkbox.value);
  });
  get("work-source-url").value = task.source_url || "";
  get("work-latest-file-url").value = task.latest_file_url || "";
  get("work-more-details").open = false;
  get("work-dialog-title").textContent = canEdit() ? "Edit work item" : "View work item";
  archiveButton.hidden = !canEdit();
  syncRequirements();
  configureApprovalControls(task);
  captureFormBaseline();
  dialog.showModal();
  get("close-work-dialog").focus();
}

function valuesFromForm() {
  return {
    title: get("work-title-input").value.trim(),
    workstreamId: get("work-workstream").value,
    status: statusInput.value,
    ownerId: ownerInput.value,
    approverId: approverInput.value,
    priority: get("work-priority").value,
    dueOn: get("work-date").value,
    nextAction: get("work-next-action").value.trim(),
    completion: get("work-completion").value.trim(),
    blocker: get("work-blocker").value.trim(),
    flags: Array.from(form.querySelectorAll('input[name="flags"]:checked'), (checkbox) => checkbox.value),
    sourceUrl: get("work-source-url").value.trim(),
    latestFileUrl: get("work-latest-file-url").value.trim(),
    position: 0
  };
}

function capacityError(values, editingId) {
  const otherTasks = state.tasks.filter((task) => task.id !== editingId);
  if (values.status === "this_week" && otherTasks.filter((task) => task.status === "this_week").length >= 3) {
    return { message: "This week is full (3 of 3). Move or finish an item before adding another.", fieldId: "work-status" };
  }
  if (values.status === "doing" && otherTasks.some((task) => task.status === "doing" && task.owner_id === values.ownerId)) {
    return { message: `${memberName(values.ownerId)} already has one item in Doing. Finish or move that item before starting another.`, fieldId: "work-owner" };
  }
  return null;
}

function validationError(values, editingId) {
  if (!values.title) return { message: "Add a short title so the team can recognise this work.", fieldId: "work-title-input" };
  if (ACTIVE_STATUSES.has(values.status)) {
    if (!values.ownerId) return { message: `Choose who owns this before moving it to ${STATUS_LABELS[values.status]}.`, fieldId: "work-owner" };
    if (!values.dueOn) return { message: `Add a due date before moving this to ${STATUS_LABELS[values.status]}.`, fieldId: "work-date" };
    if (!values.nextAction) return { message: "Write the next concrete step so the owner knows what to do.", fieldId: "work-next-action" };
    if (!values.completion) return { message: "Describe the result that will mean this work is Done.", fieldId: "work-completion" };
  }
  if (values.status === "done") {
    if (!values.ownerId) return { message: "Choose who completed this work before marking it Done.", fieldId: "work-owner" };
    if (!values.completion) return { message: "Record the result that means this work is Done.", fieldId: "work-completion" };
  }
  if (values.status === "waiting" && !values.blocker) return { message: "Say which person, answer, file, or event this work is waiting for.", fieldId: "work-blocker" };
  if (values.status === "review" && !values.approverId) return { message: "Choose another team member to review this work.", fieldId: "work-approver" };
  if (values.approverId && values.ownerId === values.approverId) return { message: "Choose someone other than the owner to approve this work.", fieldId: "work-approver" };
  const existing = taskById(editingId);
  if (values.status === "done" && values.approverId && !isAdmin()) {
    if (!existing) return { message: "Save this for Review first. The chosen approver can mark it Done afterward.", fieldId: "work-status" };
    if (!existing.approver_id) return { message: "Save the approver first. Then that person can mark the item Done.", fieldId: "work-status" };
  }
  if (!validWebUrl(values.sourceUrl)) return { message: "Remove spaces from the source link and make sure it starts with http:// or https://.", fieldId: "work-source-url" };
  if (!validWebUrl(values.latestFileUrl, true)) return { message: "Remove spaces from the file link and make sure it starts with https://.", fieldId: "work-latest-file-url" };
  return capacityError(values, editingId);
}

function humanRepositoryError(error) {
  const issue = (message, fieldId = "") => ({ message, fieldId });
  if (!(error instanceof HubRepositoryError)) return issue("The Hub could not save this change. Check your connection and try again.");
  const server = error.serverMessage.toLowerCase();

  if (server.includes("owner must be an active member")) return issue("That owner can no longer edit work. Refresh and choose an active team member.", "work-owner");
  if (server.includes("approver must be an active member")) return issue("That approver is no longer available. Refresh and choose another active team member.", "work-approver");
  if (server.includes("workspace admin can create completed approval-bound")) return issue("Save this for Review first. The approver can mark it Done afterward.", "work-status");
  if (server.includes("workspace admin can change an assigned approver")) return issue("The approver is locked after assignment. Ask a workspace owner to change it.", "work-approver");
  if (server.includes("approval must be assigned before completion")) return issue("Save the approver first. Then that person can mark the item Done.", "work-status");
  if (server.includes("archive this task")) return issue("Only this item's approver or a workspace owner can archive it.");
  if (server.includes("move this review")) return issue("This review is waiting for its approver. Only that person or a workspace owner can move it.", "work-status");
  if (server.includes("reopen this task")) return issue("Only this item's approver or a workspace owner can reopen it.", "work-status");
  if (server.includes("complete this task")) return issue("Only the assigned approver or a workspace owner can mark this Done.", "work-status");
  if (server.includes("the this week lane is limited to three tasks")) return issue("This week already has three items. Move or finish one before adding another.", "work-status");
  if (server.includes("tasks_one_doing_per_owner_active_uidx") || server.includes("one active doing")) {
    return issue("That owner already has one item in Doing. Finish or move it before starting another.", "work-owner");
  }

  if (server.includes("tasks_title_length")) return issue("Add a title of 240 characters or fewer.", "work-title-input");
  if (server.includes("tasks_status_allowed")) return issue("Choose one of the available stages.", "work-status");
  if (server.includes("tasks_priority_allowed")) return issue("Choose one of the available priorities.", "work-priority");
  if (server.includes("tasks_flags_allowed")) return issue("Choose only the available attention flags.");
  if (server.includes("tasks_source_url_http")) return issue("Remove spaces from the source link and make sure it starts with http:// or https://.", "work-source-url");
  if (server.includes("tasks_latest_file_url_https")) return issue("Remove spaces from the file link and make sure it starts with https://.", "work-latest-file-url");
  if (server.includes("tasks_waiting_has_reason")) return issue("Say which person, answer, file, or event this work is waiting for.", "work-blocker");
  if (server.includes("tasks_review_has_separate_approver")) return issue("Choose someone other than the owner to approve this work.", "work-approver");
  if (server.includes("tasks_active_work_fields_present")) {
    const current = valuesFromForm();
    if (!current.ownerId) return issue("Choose who owns this active work.", "work-owner");
    if (!current.dueOn) return issue("Add a due date for this active work.", "work-date");
    if (!current.nextAction) return issue("Write the next concrete step for this active work.", "work-next-action");
    if (!current.completion) return issue("Describe the result that will mean this work is Done.", "work-completion");
    return issue("Review the required details for this active work, save it, and try again.");
  }
  if (server.includes("tasks_done_fields_present")) {
    const current = valuesFromForm();
    if (!current.ownerId) return issue("Choose who completed this work.", "work-owner");
    if (!current.completion) return issue("Record the result that made this work complete.", "work-completion");
    return issue("Review the completion details, save the item, and try again.");
  }

  if (error.code === "23505") return issue("This item conflicts with another saved change. Refresh the Hub and try again.");
  if (error.code === "23503") {
    if (server.includes("tasks_workstream_fk")) return issue("That area is no longer available. Refresh and choose another area.", "work-workstream");
    if (server.includes("tasks_owner_fk")) return issue("That owner is no longer available. Refresh and choose another team member.", "work-owner");
    if (server.includes("tasks_approver_fk")) return issue("That approver is no longer available. Refresh and choose another team member.", "work-approver");
    return issue("A linked idea, design, or workspace changed. Refresh the Hub and try again.");
  }
  if (error.code === "23514") return issue("This older item does not meet a current Hub rule. Review its status details, save it, and try again.");
  if (["42501", "PGRST301"].includes(error.code)) return issue("Your workspace access changed. Refresh the Hub or sign in again.");
  return issue("The Hub could not save this change. Check your connection, then refresh and try again.");
}

function setSaving(saving) {
  state.saving = saving;
  saveButton.disabled = saving;
  archiveButton.disabled = saving;
  get("close-work-dialog").disabled = saving;
  get("cancel-work-button").disabled = saving;
  saveButton.textContent = saving ? "Saving…" : "Save work";
}

function startMutation() {
  return {
    generation: state.generation,
    userId: state.user?.id || "",
    sequence: ++state.mutationSequence
  };
}

function mutationIsCurrent(mutation) {
  return Boolean(
    mutation.userId
    && mutation.generation === state.generation
    && mutation.sequence === state.mutationSequence
    && mutation.userId === state.user?.id
  );
}

async function refreshTasks({ quiet = false } = {}) {
  if (!state.repository || !state.membership) return false;
  const authGeneration = state.generation;
  const refreshSequence = ++state.refreshSequence;
  const userId = state.user?.id;
  if (!userId) return false;
  state.refreshing = true;
  newWorkButton.disabled = true;
  refreshButton.disabled = true;
  if (!quiet) setSyncState("Refreshing…", true);
  try {
    const workspaceData = await state.repository.loadWorkspace(userId);
    if (
      authGeneration !== state.generation
      || refreshSequence !== state.refreshSequence
      || state.user?.id !== userId
    ) return false;
    if (!workspaceData) {
      showAccessDenied();
      return false;
    }
    state.membership = workspaceData.membership;
    state.workspace = workspaceData.workspace;
    state.members = workspaceData.members;
    state.workstreams = workspaceData.workstreams;
    state.tasks = workspaceData.tasks;
    state.stale = false;
    state.refreshing = false;
    hideAppError();
    if (dialog.open) {
      state.formBaseline = null;
      dialog.close();
    }
    renderWorkspace();
    return true;
  } catch {
    if (
      authGeneration !== state.generation
      || refreshSequence !== state.refreshSequence
      || state.user?.id !== userId
    ) return false;
    state.refreshing = false;
    state.stale = true;
    newWorkButton.disabled = true;
    if (dialog.open) setFormReadOnly(true);
    setSyncState("Refresh failed", false);
    showAppError("The last loaded board is still visible, but editing is paused until refresh succeeds.");
    return false;
  }
}

async function saveTask(event) {
  event.preventDefault();
  if (!canEdit() || state.saving) return;
  syncRequirements();
  if (!form.checkValidity()) {
    const invalidControl = form.querySelector("input:invalid, select:invalid, textarea:invalid");
    if (invalidControl && get("work-more-details").contains(invalidControl)) get("work-more-details").open = true;
    showFormError("Complete this field before saving.", invalidControl?.id || "");
    form.reportValidity();
    return;
  }
  const id = get("work-id").value;
  const values = valuesFromForm();
  const invalid = validationError(values, id);
  if (invalid) {
    showFormError(invalid.message, invalid.fieldId);
    return;
  }

  setSaving(true);
  const mutation = startMutation();
  clearFormError();
  try {
    const saved = id
      ? await state.repository.updateTask(id, get("work-updated-at").value, values)
      : await state.repository.createTask(values);
    if (!mutationIsCurrent(mutation)) return;
    if (!saved) {
      showFormError("This item changed elsewhere or your access changed, so your draft was not saved. Your typing is still here. Close this window, refresh the Hub, and reopen the item before trying again.");
      boardStatus.textContent = "Draft not saved because the item changed elsewhere.";
      return;
    }
    setMobileWorkStatus(values.status);
    state.formBaseline = null;
    const refreshed = await refreshTasks({ quiet: true });
    if (!mutationIsCurrent(mutation)) return;
    boardStatus.textContent = `${values.title} saved.`;
    if (refreshed) {
      showNotice(`${values.title} saved in ${STATUS_LABELS[values.status]}.`);
    } else {
      showFormError(`${values.title} was saved, but the board could not refresh. Close this window, then use Refresh to see the latest version.`);
    }
  } catch (error) {
    if (!mutationIsCurrent(mutation)) return;
    const friendly = humanRepositoryError(error);
    showFormError(friendly.message, friendly.fieldId);
  } finally {
    if (mutationIsCurrent(mutation)) setSaving(false);
  }
}

async function archiveTask() {
  const id = get("work-id").value;
  const task = taskById(id);
  if (!task || !canEdit() || state.saving || archiveButton.hidden) return;
  const archiveMessage = isFormDirty()
    ? `Archive “${task.title}”? It will leave the active board and unsaved edits will be discarded.`
    : `Archive “${task.title}”? It will leave the active board.`;
  if (!window.confirm(archiveMessage)) return;
  setSaving(true);
  const mutation = startMutation();
  try {
    const archived = await state.repository.archiveTask(id, get("work-updated-at").value);
    if (!mutationIsCurrent(mutation)) return;
    if (!archived) {
      showFormError("This item changed elsewhere or your access changed, so it was not archived. Nothing was removed, and your draft is still here. Close this window, refresh the Hub, and reopen the item before trying again.");
      boardStatus.textContent = "The item was not archived because it changed elsewhere.";
      return;
    }
    state.formBaseline = null;
    const refreshed = await refreshTasks({ quiet: true });
    if (!mutationIsCurrent(mutation)) return;
    boardStatus.textContent = `${task.title} archived.`;
    if (refreshed) {
      showNotice(`${task.title} archived and removed from the board.`);
    } else {
      archiveButton.hidden = true;
      showFormError(`${task.title} was archived, but the board could not refresh. Close this window, then use Refresh to update the board.`);
    }
  } catch (error) {
    if (!mutationIsCurrent(mutation)) return;
    const friendly = humanRepositoryError(error);
    showFormError(friendly.message, friendly.fieldId);
  } finally {
    if (mutationIsCurrent(mutation)) setSaving(false);
  }
}

async function reconcileSession(session, event = "MANUAL") {
  const incomingUserId = session?.user?.id || "";
  const sameKnownUser = Boolean(incomingUserId && incomingUserId === state.user?.id && state.membership);
  if (sameKnownUser && ["TOKEN_REFRESHED", "SIGNED_IN"].includes(event)) return;

  const generation = ++state.generation;
  state.refreshSequence += 1;
  state.mutationSequence += 1;
  setSaving(false);
  state.refreshing = false;
  state.formBaseline = null;
  if (dialog.open) dialog.close();
  if (!session) {
    showSignedOut();
    return;
  }
  if (state.user && incomingUserId !== state.user.id) clearWorkspaceState();
  showChecking();
  try {
    const userResponse = await state.auth.getVerifiedUser();
    if (generation !== state.generation) return;
    if (userResponse.error || !userResponse.data?.user) {
      showSignedOut("Your sign-in expired. Request a new link.");
      return;
    }
    const user = userResponse.data.user;
    const workspaceData = await state.repository.loadWorkspace(user.id);
    if (generation !== state.generation) return;
    if (!workspaceData) {
      showAccessDenied();
      return;
    }
    state.user = user;
    state.membership = workspaceData.membership;
    state.workspace = workspaceData.workspace;
    state.members = workspaceData.members;
    state.workstreams = workspaceData.workstreams;
    state.tasks = workspaceData.tasks;
    state.stale = false;
    renderWorkspace({ focus: true });
  } catch {
    if (generation !== state.generation) return;
    clearWorkspaceState();
    setAccessView({
      copy: "The private workspace could not be verified.",
      retry: true,
      status: "Check the connection and try again. No company data was loaded."
    });
  }
}

async function startConnectedMode() {
  showChecking("Starting secure access…");
  try {
    state.auth = await createHubAuth(state.config);
    state.repository = createConnectedWorkRepository(state.auth.client, state.config.workspaceId);
    state.authSubscription = state.auth.onAuthStateChange((event, session) => {
      window.setTimeout(() => void reconcileSession(session, event), 0);
    });
    const initial = await state.auth.getInitialSession();
    if (initial.error) throw initial.error;
    await reconcileSession(initial.data?.session || null, "INITIAL_CHECK");
  } catch {
    clearWorkspaceState();
    setAccessView({
      copy: "Secure access could not start.",
      retry: true,
      status: "Check the Hub configuration and network connection."
    });
  }
}

/* Claude — 2026-08-12: password is the primary sign-in. Magic links stay as a
   fallback button, since the built-in email sender is rate limited and links
   often land in junk, which is poor for non-technical daily users. */
async function signInWithPassword(event) {
  event.preventDefault();
  const emailInput = get("team-email");
  const passwordInput = get("team-password");
  if (!signInForm.checkValidity()) {
    signInForm.reportValidity();
    return;
  }
  const button = get("signin-button");
  emailInput.disabled = true;
  passwordInput.disabled = true;
  button.disabled = true;
  accessStatus.textContent = "Signing in…";
  try {
    const result = await state.auth.signInWithPassword(emailInput.value, passwordInput.value);
    if (result?.error) throw result.error;
    accessStatus.textContent = "Signed in. Checking your workspace access…";
    passwordInput.value = "";
  } catch (error) {
    const message = String(error?.message || "");
    accessStatus.textContent = /invalid login/i.test(message)
      ? "That email and password did not match."
      : "Could not sign in. Please try again.";
  } finally {
    emailInput.disabled = false;
    passwordInput.disabled = false;
    button.disabled = false;
  }
}

async function requestMagicLink() {
  const emailInput = get("team-email");
  if (!emailInput.value.trim()) {
    accessStatus.textContent = "Enter your email address first.";
    emailInput.focus();
    return;
  }
  const button = get("magiclink-button");
  button.disabled = true;
  accessStatus.textContent = "Sending a one-time link…";
  try {
    const result = await state.auth.requestMagicLink(emailInput.value);
    accessStatus.textContent = result?.error && /rate limit/i.test(String(result.error.message || ""))
      ? "Too many emails requested. Wait an hour, or sign in with your password."
      : "If this address is invited, check its inbox for a sign-in link.";
  } catch {
    accessStatus.textContent = "If this address is invited, check its inbox for a sign-in link.";
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  ++state.generation;
  showSignedOut("Signed out on this device.");
  try {
    await state.auth?.signOut();
  } catch {
    // Local company data is already cleared. Remote revocation can be retried by signing in again.
  }
}

async function retryAccess() {
  retryAccessButton.disabled = true;
  try {
    if (!state.auth) await startConnectedMode();
    else {
      const initial = await state.auth.getInitialSession();
      if (initial.error) throw initial.error;
      await reconcileSession(initial.data?.session || null, "MANUAL_RETRY");
    }
  } catch {
    clearWorkspaceState();
    setAccessView({
      copy: "Secure access could not be retried.",
      retry: true,
      status: "Check the connection and try again. No company data was loaded."
    });
  } finally {
    retryAccessButton.disabled = false;
  }
}

function handleDialogClose() {
  state.formBaseline = null;
  window.requestAnimationFrame(() => {
    let target = state.dialogOpener;
    const isVisible = (element) => Boolean(element?.isConnected && element.getClientRects().length);
    if (!isVisible(target) && state.dialogOpenerTaskId) {
      target = [...board.querySelectorAll("button[data-task-id]")]
        .find((card) => card.dataset.taskId === state.dialogOpenerTaskId);
    }
    if (!isVisible(target)) target = isVisible(newWorkButton) ? newWorkButton : get("work");
    target?.focus();
    state.dialogOpener = null;
    state.dialogOpenerTaskId = "";
  });
}

function bindEvents() {
  signInForm.addEventListener("submit", signInWithPassword);
  get("magiclink-button").addEventListener("click", requestMagicLink);
  retryAccessButton.addEventListener("click", retryAccess);
  signOutButton.addEventListener("click", signOut);
  mobileSignOutButton.addEventListener("click", signOut);
  accessSignOutButton.addEventListener("click", signOut);
  refreshButton.addEventListener("click", requestWorkspaceRefresh);
  get("dismiss-app-error").addEventListener("click", hideAppError);
  get("dismiss-hub-notice").addEventListener("click", clearNotice);
  newWorkButton.addEventListener("click", openNewTask);
  form.addEventListener("submit", saveTask);
  form.addEventListener("input", clearEditedFieldError);
  form.addEventListener("change", clearEditedFieldError);
  archiveButton.addEventListener("click", archiveTask);
  get("close-work-dialog").addEventListener("click", requestDialogClose);
  get("cancel-work-button").addEventListener("click", requestDialogClose);
  statusInput.addEventListener("change", syncRequirements);
  searchInput.addEventListener("input", renderBoard);
  ownerFilter.addEventListener("change", renderBoard);
  workStageFilter.addEventListener("change", () => setMobileWorkStatus(workStageFilter.value, { announce: true }));
  primaryNav.addEventListener("click", (event) => {
    const link = event.target.closest('.nav-link[href^="#"]');
    if (link) activateSection(link.getAttribute("href").slice(1));
  });
  window.addEventListener("hashchange", () => activateSection(sectionIdFromHash()));
  window.addEventListener("beforeunload", (event) => {
    if (!isFormDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  dialog.addEventListener("cancel", (event) => {
    if (state.saving || (isFormDirty() && !window.confirm("Discard your unsaved changes?"))) {
      event.preventDefault();
      return;
    }
    state.formBaseline = null;
  });
  dialog.addEventListener("close", handleDialogClose);
  board.addEventListener("click", (event) => {
    const card = event.target.closest("button[data-task-id]");
    if (card) openTask(card.dataset.taskId);
  });
  get("home-week-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-open-task-id]");
    if (row) window.setTimeout(() => openTask(row.dataset.openTaskId), 0);
  });
  get("home-attention-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-open-task-id]");
    if (row) window.setTimeout(() => openTask(row.dataset.openTaskId), 0);
  });
}

function boot() {
  const phoneLayout = window.matchMedia("(max-width: 820px)");
  get("work-tools").open = !phoneLayout.matches;
  phoneLayout.addEventListener("change", (event) => {
    get("work-tools").open = !event.matches;
  });
  bindEvents();
  const validation = validateHubConfig(globalThis.FAKESNIFF_HUB_CONFIG);
  state.config = validation.config;
  if (!validation.ok || state.config.mode === "setup") {
    showSetupMode(validation.errors);
    return;
  }
  void startConnectedMode();
}

boot();
