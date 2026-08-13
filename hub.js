/* Codex — 2026-08-11: authenticated Hub controller. No company records are embedded in this file. */

import { createHubAuth, validateHubConfig } from "./hub-auth.js";
import { createConnectedWorkRepository, HubRepositoryError } from "./hub-work-repository.js";
import { composeHomeActivity, normalizeHomeChanges } from "./hub-home-activity.js";
import {
  ACTIVE_WORK_STATUSES as ACTIVE_STATUSES,
  WORK_STATUSES as STATUSES,
  WORK_STATUS_LABELS as STATUS_LABELS,
  isValidWorkUrl,
  reconcileWorkDraft,
  selectHomeFocus,
  translateWorkRepositoryError,
  validateWorkValues,
  workApprovalPermissions
} from "./hub-work-policy.js";

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
const REGISTERABLE_SECTION_IDS = new Set(["idea-lab", "lookbook", "decisions", "designs"]);
const PRODUCTION_SUPABASE_HOST = "kayxejofqyxoqlberrgw.supabase.co";
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
  refreshWhenDialogCloses: false,
  lastRefreshedAt: 0,
  stale: false,
  activeSectionId: "home",
  mobileWorkStatus: "this_week",
  originalApproverId: "",
  formBaseline: null,
  formBaselineValues: null,
  conflictDraft: null,
  conflictReview: null,
  noticeTimer: null,
  dialogOpener: null,
  dialogOpenerTaskId: "",
  homeActivityRequestSequence: 0,
  homeActivityAckSequence: 0,
  homeActivityObserver: null,
  homeActivity: {
    status: "idle",
    payload: null,
    acknowledgementWarning: false,
    lastRefreshedAt: 0
  }
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
const reloadLatestButton = get("reload-latest-work-button");
const conflictReviewPanel = get("work-conflict-review");
const conflictFields = get("work-conflict-fields");
const dialogStatus = get("work-dialog-status");
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
  const sectionChanged = state.activeSectionId !== normalized;
  state.activeSectionId = normalized;
  // Claude — 2026-08-12: show only the active section. Without this every
  // section renders at once and the nav appears not to work.
  document.querySelectorAll(".page-section").forEach((section) => {
    section.classList.toggle("is-active", section.id === normalized);
  });
  navLinks.forEach((link) => {
    const current = link.getAttribute("href") === `#${normalized}`;
    link.classList.toggle("is-current", current);
    if (current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  void mountRegisteredSection(normalized);
  if (normalized !== "home") {
    disconnectHomeActivityObserver();
  } else if (
    sectionChanged
    || ["idle", "error"].includes(state.homeActivity.status)
    || Date.now() - state.homeActivity.lastRefreshedAt >= 30_000
  ) {
    void refreshHomeActivity();
  }
}

/* Codex — 2026-08-13: the environment marker belongs to the shell, not an
   optional feature module. Staging must remain unmistakable even if the
   assistant fails to load. */
function applyEnvironmentMarker(config) {
  let isStaging = false;
  try {
    isStaging = config?.mode === "connected"
      && new URL(config.supabaseUrl).hostname !== PRODUCTION_SUPABASE_HOST;
  } catch {
    isStaging = false;
  }
  document.body.classList.toggle("is-staging", isStaging);
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
  state.homeActivityRequestSequence += 1;
  state.homeActivityAckSequence += 1;
  disconnectHomeActivityObserver();
  state.conflictDraft = null;
  state.conflictReview = null;
  setSaving(false);
  state.refreshing = false;
  state.refreshWhenDialogCloses = false;
  clearRegisteredSections();
  state.formBaseline = null;
  state.formBaselineValues = null;
  clearNotice();
  clearDialogStatus();
  renderConflictReview();
  state.user = null;
  state.membership = null;
  state.workspace = null;
  state.members = [];
  state.workstreams = [];
  state.tasks = [];
  state.lastRefreshedAt = 0;
  state.stale = false;
  state.dialogOpener = null;
  state.dialogOpenerTaskId = "";
  state.homeActivity = {
    status: "idle",
    payload: null,
    acknowledgementWarning: false,
    lastRefreshedAt: 0
  };
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
  get("home-changes-status").textContent = "Checking…";
  get("home-changes-retry").hidden = true;
  get("home-changes-list").replaceChildren(createElement("p", "module-empty-copy", "Checking recent changes…"));
  get("home-changes-list").setAttribute("aria-busy", "true");
  get("home-changes-note").textContent = "";
  get("home-changes-note").hidden = true;
  hideAppError();
  get("work-nav-count").textContent = "0";
  get("work-nav-count").setAttribute("aria-label", "0 active work items");
  get("home-active-work-count").textContent = "00";
  get("home-active-work-note").textContent = "No active owners";
  get("home-week-count").textContent = "00";
  get("home-review-count").textContent = "00";
  get("home-waiting-count").textContent = "00";
  get("home-focus-date").textContent = "Today";
  get("home-focus-value").textContent = "Your next move will appear here.";
  get("home-focus-detail").textContent = "Sign in to load the shared work board.";
  get("home-focus-action").hidden = true;
  reloadLatestButton.hidden = true;
  setMobileWorkStatus("this_week");
}

function hasEditRole() {
  return ROLE_RANK[state.membership?.role] >= ROLE_RANK.member;
}

function canEdit() {
  return hasEditRole() && !state.stale;
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
  return isValidWorkUrl(value, { httpsOnly });
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

function taskDateLabel(task) {
  if (task.status === "done" && task.completed_at) {
    const completed = new Date(task.completed_at);
    if (!Number.isNaN(completed.getTime())) {
      return `Done ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(completed)}`;
    }
  }
  return formatDate(task.due_on);
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
  const approvalLabel = task.status === "review"
    ? (task.approver_id === state.membership?.user_id
      ? "Needs your approval"
      : `Review by ${memberName(task.approver_id, "Approver needed")}`)
    : "";
  if (approvalLabel) {
    button.setAttribute("aria-label", `${canEdit() ? "Edit" : "View"} ${task.title}. ${STATUS_LABELS[task.status]}. ${approvalLabel}.`);
  }
  if (flags.length || !task.owner_id || approvalLabel) {
    const flagRow = createElement("span", "task-card-flags");
    flags.forEach((flag) => flagRow.append(createElement("span", "task-flag", FLAG_LABELS[flag])));
    if (!task.owner_id) flagRow.append(createElement("span", "task-flag task-flag-owner", "Owner needed"));
    if (approvalLabel) flagRow.append(createElement("span", "task-flag task-flag-approval", approvalLabel));
    button.append(flagRow);
  }

  const footer = createElement("span", "task-card-footer");
  footer.append(createElement("span", `owner-chip ${ownerClass(task.owner_id)}`, memberName(task.owner_id)));
  footer.append(createElement("span", isOverdue(task) ? "task-card-date-overdue" : "", taskDateLabel(task)));
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

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function homeActivityTime(value, now = Date.now()) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "Recently";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(timestamp));
}

function homeActivityKindLabel(kind) {
  return {
    task_waiting: "Waiting",
    task_review: "Review",
    decision_recorded: "Decision",
    decision_agreed: "Agreed",
    review_stale: "Untouched"
  }[kind] || "Update";
}

function homeActivityDetail(item) {
  if (item.kind === "task_waiting") {
    return `${item.actorName} moved this to Waiting.`;
  }
  if (item.kind === "task_review") {
    if (item.needsYou) return "Ready for your review.";
    return `${item.actorName} sent this for review.`;
  }
  if (item.kind === "decision_recorded") return `${item.actorName} recorded this decision.`;
  if (item.kind === "decision_agreed") return `${item.actorName} marked this decision agreed.`;
  if (item.kind === "review_stale") {
    const task = taskById(item.entityId);
    const days = Math.max(1, Math.floor(item.hoursUntouched / 24));
    if (item.needsYou) return `Waiting for your review for ${days} ${days === 1 ? "day" : "days"}.`;
    return `Still waiting for ${memberName(task?.approver_id, "an approver")} after ${days} ${days === 1 ? "day" : "days"}.`;
  }
  return "Open this item to see what changed.";
}

function makeHomeActivityRow(item) {
  const row = createElement("article", "home-change-row");

  const copy = createElement("span", "home-change-copy");
  const detail = homeActivityDetail(item);
  copy.append(
    createElement("strong", "", item.title),
    createElement("small", "", detail)
  );

  const meta = createElement("span", "home-change-meta");
  const attention = item.needsYou || item.kind === "task_waiting" || item.kind === "review_stale";
  meta.append(
    createElement("span", `home-change-kind${attention ? " is-attention" : ""}`, homeActivityKindLabel(item.kind)),
    createElement("span", "home-change-time", item.kind === "review_stale" ? "Still open" : homeActivityTime(item.occurredAt))
  );
  row.append(copy, meta);
  return row;
}

function renderHomeActivity() {
  const list = get("home-changes-list");
  const status = get("home-changes-status");
  const note = get("home-changes-note");
  const retry = get("home-changes-retry");
  const hasPayload = Boolean(state.homeActivity.payload);
  const payload = state.homeActivity.payload || { firstVisit: false, hasMore: false, items: [] };
  const digest = composeHomeActivity(payload, state.tasks, state.membership?.user_id || "", Date.now(), 5);
  const newCount = digest.items.filter((item) => item.eventId).length;

  list.setAttribute("aria-busy", state.homeActivity.status === "loading" ? "true" : "false");
  let receiptGroups = [];
  if (state.homeActivity.status === "loading" && !hasPayload) {
    list.replaceChildren(createElement("p", "module-empty-copy", "Checking recent changes…"));
  } else if (!digest.items.length) {
    const copy = state.homeActivity.status === "error"
      ? "Couldn’t check recent changes. Your Work board is still available."
      : digest.firstVisit
        ? "First check-in. Changes recorded today will appear here."
        : "Nothing new since your last look.";
    list.replaceChildren(createElement("p", "module-empty-copy", copy));
  } else {
    const rows = digest.items.map(makeHomeActivityRow);
    list.replaceChildren(...rows);
    receiptGroups = digest.items
      .map((item, index) => ({
        element: rows[index],
        receiptEventIds: Object.freeze([...(item.receiptEventIds || [])])
      }))
      .filter((group) => group.receiptEventIds.length);
  }

  if (state.homeActivity.status === "loading") status.textContent = "Checking…";
  else if (state.homeActivity.status === "error") status.textContent = "Couldn’t check";
  else if (digest.firstVisit && newCount) status.textContent = "Today";
  else if (newCount) status.textContent = `${newCount} new`;
  else if (digest.items.length) status.textContent = "Still open";
  else status.textContent = "Up to date";
  retry.hidden = state.homeActivity.status !== "error";

  const notes = [];
  if (digest.hasMore) notes.push("Showing the newest changes. Open Work and Decisions for the rest.");
  if (state.homeActivity.acknowledgementWarning) notes.push("This check-in may repeat because its seen marker could not be saved.");
  if (state.homeActivity.status === "error" && hasPayload && payload.items.length) notes.push("The items shown are from the last successful check.");
  note.textContent = notes.join(" ");
  note.hidden = !notes.length;

  return Object.freeze({
    digest,
    receiptGroups: Object.freeze(
      receiptGroups.length
        ? receiptGroups.map(Object.freeze)
        : [Object.freeze({ element: list, receiptEventIds: Object.freeze([]) })]
    )
  });
}

function homeActivityRequestIsCurrent(generation, userId, requestSequence) {
  return Boolean(
    generation === state.generation
    && requestSequence === state.homeActivityRequestSequence
    && userId
    && state.user?.id === userId
    && state.membership?.user_id === userId
  );
}

function disconnectHomeActivityObserver() {
  state.homeActivityObserver?.disconnect();
  state.homeActivityObserver = null;
  state.homeActivityAckSequence += 1;
}

function scheduleHomeActivityAcknowledgement(receiptGroups, generation, userId, requestSequence) {
  disconnectHomeActivityObserver();
  if (typeof window.IntersectionObserver !== "function") return;
  const pending = new Map(
    receiptGroups.map((group) => [
      group.element,
      Object.freeze([...new Set(group.receiptEventIds)].slice(0, 500))
    ])
  );
  if (!pending.size) return;
  const ackSequence = ++state.homeActivityAckSequence;
  const observer = new window.IntersectionObserver((entries) => {
    const visibleEntries = entries.filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6);
    if (!visibleEntries.length) return;
    const exactIds = [];
    visibleEntries.forEach((entry) => {
      exactIds.push(...(pending.get(entry.target) || []));
      pending.delete(entry.target);
      observer.unobserve(entry.target);
    });
    if (!pending.size) {
      observer.disconnect();
      if (state.homeActivityObserver === observer) state.homeActivityObserver = null;
    }
    if (
      !homeActivityRequestIsCurrent(generation, userId, requestSequence)
      || ackSequence !== state.homeActivityAckSequence
      || state.activeSectionId !== "home"
      || document.hidden
    ) return;

    void (async () => {
      try {
        const acknowledgement = await state.repository.acknowledgeHomeChanges(userId, exactIds);
        if (
          !homeActivityRequestIsCurrent(generation, userId, requestSequence)
          || ackSequence !== state.homeActivityAckSequence
        ) return;
        if (acknowledgement?.openedAt && state.homeActivity.payload) {
          state.homeActivity.payload = Object.freeze({
            ...state.homeActivity.payload,
            lastOpenedAt: acknowledgement.openedAt
          });
        }
      } catch {
        if (
          homeActivityRequestIsCurrent(generation, userId, requestSequence)
          && ackSequence === state.homeActivityAckSequence
        ) {
          state.homeActivity.acknowledgementWarning = true;
          renderHomeActivity();
        }
      }
    })();
  }, { threshold: [0.6] });
  state.homeActivityObserver = observer;
  pending.forEach((_eventIds, element) => observer.observe(element));
}

async function refreshHomeActivity() {
  if (
    state.activeSectionId !== "home"
    || appShell.hidden
    || document.hidden
    || !state.repository
    || !state.membership
    || !state.user
    || state.homeActivity.status === "loading"
  ) return false;

  const generation = state.generation;
  const userId = state.user.id;
  const requestSequence = ++state.homeActivityRequestSequence;
  disconnectHomeActivityObserver();
  state.homeActivity.status = "loading";
  state.homeActivity.acknowledgementWarning = false;
  renderHomeActivity();

  try {
    const raw = await state.repository.loadHomeChanges(userId, 5);
    if (!homeActivityRequestIsCurrent(generation, userId, requestSequence)) return false;
    const payload = normalizeHomeChanges(raw);
    state.homeActivity = {
      status: "ready",
      payload,
      acknowledgementWarning: false,
      lastRefreshedAt: Date.now()
    };
    const rendered = renderHomeActivity();
    scheduleHomeActivityAcknowledgement(
      rendered.receiptGroups,
      generation,
      userId,
      requestSequence
    );
    return true;
  } catch {
    if (!homeActivityRequestIsCurrent(generation, userId, requestSequence)) return false;
    state.homeActivity.status = "error";
    state.homeActivity.lastRefreshedAt = Date.now();
    renderHomeActivity();
    return false;
  }
}

function renderHomeFocus() {
  const action = get("home-focus-action");
  const today = new Date();
  const todayIso = localDateIso(today);
  const focus = selectHomeFocus(state.tasks, state.membership?.user_id || "", todayIso);
  get("home-focus-date").textContent = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "short"
  }).format(today);
  action.hidden = false;
  delete action.dataset.taskId;
  delete action.dataset.homeAction;

  if (!focus) {
    const teamHasActiveWork = state.tasks.some((task) => ACTIVE_STATUSES.has(task.status));
    const backlogCount = state.tasks.filter((task) => task.status === "backlog").length;
    if (backlogCount && !teamHasActiveWork) {
      get("home-focus-value").textContent = "Choose what moves next.";
      get("home-focus-detail").textContent = `${backlogCount} backlog ${backlogCount === 1 ? "item is" : "items are"} ready to plan.`;
      action.textContent = "Review backlog";
      action.setAttribute("aria-label", "Open the Work backlog");
      action.dataset.homeAction = "open-backlog";
    } else if (hasEditRole() && !teamHasActiveWork) {
      if (state.stale) {
        get("home-focus-value").textContent = "Work needs a refresh.";
        get("home-focus-detail").textContent = "Editing is paused until the shared board reconnects.";
        action.textContent = "Refresh board";
        action.setAttribute("aria-label", "Refresh the shared Work board");
        action.dataset.homeAction = "refresh";
      } else {
        // Codex — 2026-08-13: a first visit teaches the smallest safe action instead of presenting an empty dashboard.
        get("home-focus-value").textContent = "Add the first thing we need to do.";
        get("home-focus-detail").textContent = "Start it in Backlog with just a title. Add details when the team chooses it for This week.";
        action.textContent = "Create first work item";
        action.setAttribute("aria-label", "Create the first work item");
        action.dataset.homeAction = "create";
      }
    } else if (!teamHasActiveWork) {
      get("home-focus-value").textContent = "No work has been added yet.";
      get("home-focus-detail").textContent = "A workspace member can add the first work item.";
      action.hidden = true;
    } else {
      get("home-focus-value").textContent = "Nothing needs you right now.";
      get("home-focus-detail").textContent = "The team's active work is on the board.";
      action.textContent = "Open Work";
      action.setAttribute("aria-label", "Open the shared Work board");
      action.dataset.homeAction = "open-work";
    }
    return;
  }

  const { task, reason } = focus;
  get("home-focus-value").textContent = task.title;
  action.textContent = "Open item";
  action.setAttribute("aria-label", `Open ${task.title}`);
  action.dataset.taskId = task.id;
  const next = task.next_action ? ` Next: ${task.next_action}` : "";
  const details = {
    assigned_review: `Needs your decision.${next}`,
    owned_overdue: `Overdue since ${formatDate(task.due_on)}.${next}`,
    owned_doing: task.next_action ? `Next: ${task.next_action}` : `Due ${formatDate(task.due_on)}. Add the next step.`,
    owned_this_week: task.next_action ? `This week · Next: ${task.next_action}` : `Due ${formatDate(task.due_on)}. Add the next step.`,
    team_attention: task.status === "waiting"
      ? `Blocked: ${task.blocker_note || "Waiting reason needed"}`
      : `Review by ${memberName(task.approver_id, "Approver needed")}.`
  };
  get("home-focus-detail").textContent = details[reason] || "Open this item to see the next move.";
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
  renderHomeFocus();

  renderHomeList(
    get("home-week-list"),
    week,
    (task) => task.next_action || "Next step not recorded",
    "Nothing is planned for this week yet. Choose up to three items from Backlog when the team is ready."
  );
  const memberId = state.membership?.user_id;
  const attention = [...review, ...waiting].sort((left, right) => {
    const leftMine = left.approver_id === memberId ? 0 : 1;
    const rightMine = right.approver_id === memberId ? 0 : 1;
    if (leftMine !== rightMine) return leftMine - rightMine;
    const leftOverdue = isOverdue(left) ? 0 : 1;
    const rightOverdue = isOverdue(right) ? 0 : 1;
    if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue;
    return String(left.due_on || "9999-12-31").localeCompare(String(right.due_on || "9999-12-31"));
  });
  renderHomeList(
    get("home-attention-list"),
    attention.slice(0, 5),
    (task) => task.status === "waiting" ? task.blocker_note : `Review by ${memberName(task.approver_id, "Approver needed")}`,
    "All clear — nothing is waiting for review or blocked."
  );
  renderHomeActivity();
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
  newWorkButton.disabled = !canEdit();
  renderBoard();
  appShell.hidden = false;
  accessScreen.hidden = true;
  document.querySelector(".skip-link")?.setAttribute("href", "#main-content");
  activateSection(sectionIdFromHash());
  state.lastRefreshedAt = Date.now();
  setSyncState("Loaded just now", false);
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
  state.formBaselineValues = valuesFromForm();
}

function isFormDirty() {
  return Boolean(
    dialog.open
    && (
      state.conflictDraft
      || state.conflictReview?.unresolvedKeys?.length
      || (
        state.formBaseline !== null
        && ROLE_RANK[state.membership?.role] >= ROLE_RANK.member
        && formSnapshot() !== state.formBaseline
      )
    )
  );
}

function requestDialogClose() {
  if (state.saving) return;
  if (isFormDirty() && !window.confirm("Discard your unsaved changes?")) return;
  state.formBaseline = null;
  state.formBaselineValues = null;
  dialog.close();
}

async function requestWorkspaceRefresh() {
  if (state.refreshing) return;
  if (isFormDirty() && !window.confirm("Refresh the Hub and discard your unsaved changes?")) return;
  state.formBaseline = null;
  state.formBaselineValues = null;
  if (dialog.open) dialog.close();
  await refreshTasks();
}

function refreshAfterReturning() {
  const refreshIsDue = Date.now() - state.lastRefreshedAt >= 30_000;
  if (dialog.open && refreshIsDue && state.user && state.membership) {
    state.refreshWhenDialogCloses = true;
    return true;
  }
  if (state.refreshing) return true;
  if (
    document.visibilityState !== "visible"
    || !state.user
    || !state.membership
    || state.saving
    || dialog.open
    || !refreshIsDue
  ) return false;
  void refreshTasks({ quiet: true });
  return true;
}

function refreshHomeAfterReturning() {
  const workRefreshOwnsReturn = refreshAfterReturning();
  if (
    !workRefreshOwnsReturn
    && !state.refreshing
    && !state.saving
    && !dialog.open
    && document.visibilityState === "visible"
    && state.activeSectionId === "home"
    && Date.now() - state.homeActivity.lastRefreshedAt >= 30_000
  ) {
    void refreshHomeActivity();
  }
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

function clearDialogStatus() {
  dialogStatus.hidden = true;
  dialogStatus.textContent = "";
}

function showDialogStatus(message, { focus = false } = {}) {
  dialogStatus.textContent = message;
  dialogStatus.hidden = false;
  if (focus) window.requestAnimationFrame(() => dialogStatus.focus());
}

const CONFLICT_FIELD_LABELS = Object.freeze({
  title: "Title",
  workstreamId: "Area",
  status: "Status",
  ownerId: "Owner",
  approverId: "Approver",
  priority: "Priority",
  dueOn: "Due date",
  nextAction: "Next step",
  completion: "Done condition",
  blocker: "Waiting reason",
  flags: "Attention flags",
  sourceUrl: "Source link",
  latestFileUrl: "File link"
});

function conflictValueLabel(key, value) {
  if (key === "ownerId" || key === "approverId") return memberName(value, "Nobody");
  if (key === "workstreamId") return value ? workstreamName(value) : "No area";
  if (key === "status") return STATUS_LABELS[value] || value;
  if (key === "flags") return value?.length ? value.map((flag) => FLAG_LABELS[flag] || flag).join(", ") : "None";
  return String(value || "Empty");
}

function protectedConflictNote(review) {
  const labels = (review?.protectedFields || [])
    .map((key) => CONFLICT_FIELD_LABELS[key]?.toLowerCase())
    .filter(Boolean)
    .join(", ");
  return labels ? ` The latest ${labels} was kept because approval authority changed.` : "";
}

function renderConflictReview() {
  conflictFields.replaceChildren();
  const review = state.conflictReview;
  if (!review?.unresolvedKeys?.length) {
    conflictReviewPanel.hidden = true;
    return;
  }

  review.unresolvedKeys.forEach((key, index) => {
    const label = CONFLICT_FIELD_LABELS[key] || key;
    const row = createElement("article", "conflict-choice");
    const copy = createElement("div", "conflict-choice-copy");
    const title = createElement("p", "conflict-field-label");
    const titleId = `work-conflict-field-${index}`;
    const latestId = `work-conflict-latest-${index}`;
    const mineId = `work-conflict-mine-${index}`;
    title.id = titleId;
    title.append(createElement("strong", "", label));
    const latest = createElement("p");
    latest.id = latestId;
    latest.append(createElement("strong", "", "Latest: "), document.createTextNode(conflictValueLabel(key, review.latestValues[key])));
    const mine = createElement("p");
    mine.id = mineId;
    mine.append(createElement("strong", "", "Yours: "), document.createTextNode(conflictValueLabel(key, review.draftValues[key])));
    copy.append(title, latest, mine);

    const actions = createElement("div", "conflict-choice-actions");
    const keepLatest = createElement("button", "text-button", "Keep latest");
    keepLatest.type = "button";
    keepLatest.dataset.conflictKey = key;
    keepLatest.dataset.conflictChoice = "latest";
    keepLatest.setAttribute("aria-label", `Keep latest ${label.toLowerCase()}`);
    keepLatest.setAttribute("aria-describedby", latestId);
    const useMine = createElement("button", "text-button", "Use mine");
    useMine.type = "button";
    useMine.dataset.conflictKey = key;
    useMine.dataset.conflictChoice = "draft";
    useMine.setAttribute("aria-label", `Use my ${label.toLowerCase()}`);
    useMine.setAttribute("aria-describedby", mineId);
    actions.append(keepLatest, useMine);
    row.setAttribute("role", "group");
    row.setAttribute("aria-labelledby", titleId);
    row.append(copy, actions);
    conflictFields.append(row);
  });
  conflictReviewPanel.hidden = false;
}

function resolveConflictChoice(key, choice) {
  const review = state.conflictReview;
  if (!review?.unresolvedKeys?.includes(key) || state.saving) return;
  /* People may continue polishing unrelated fields while comparing a conflict.
     Start from the live form so resolving one field never rewinds those edits. */
  review.mergedValues = valuesFromForm();
  const selected = choice === "draft" ? review.draftValues[key] : review.latestValues[key];
  review.mergedValues[key] = Array.isArray(selected) ? [...selected] : selected;
  review.unresolvedKeys = review.unresolvedKeys.filter((candidate) => candidate !== key);
  applyValuesToForm(review.mergedValues);
  syncRequirements();
  renderConflictReview();
  saveButton.disabled = Boolean(review.unresolvedKeys.length) || !canEdit();
  archiveButton.disabled = Boolean(review.unresolvedKeys.length);
  if (review.unresolvedKeys.length) {
    showDialogStatus(`${review.unresolvedKeys.length} conflict ${review.unresolvedKeys.length === 1 ? "choice remains" : "choices remain"}.${protectedConflictNote(review)}`);
    conflictFields.querySelector("button")?.focus();
    return;
  }
  const authorityNote = protectedConflictNote(review);
  state.conflictReview = null;
  showDialogStatus(`Conflict choices resolved.${authorityNote} Review the item, then save your edits.`);
  const firstAffectedControl = get({
    title: "work-title-input", workstreamId: "work-workstream", status: "work-status",
    ownerId: "work-owner", approverId: "work-approver", priority: "work-priority",
    dueOn: "work-date", nextAction: "work-next-action", completion: "work-completion",
    blocker: "work-blocker", sourceUrl: "work-source-url", latestFileUrl: "work-latest-file-url"
  }[key]);
  if (firstAffectedControl && get("work-more-details").contains(firstAffectedControl)) {
    get("work-more-details").open = true;
  }
  window.requestAnimationFrame(() => {
    const isFocusable = (control) => Boolean(
      control
      && !control.disabled
      && !control.hidden
      && control.getClientRects().length
    );
    const target = isFocusable(firstAffectedControl)
      ? firstAffectedControl
      : (isFocusable(saveButton) ? saveButton : dialogStatus);
    target.focus();
  });
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
  statusInput.querySelectorAll("option").forEach((option) => {
    option.disabled = false;
  });
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
  if (readOnly) archiveButton.hidden = true;
  if (get("work-id").value) get("work-dialog-title").textContent = readOnly ? "View work item" : "Edit work item";
  get("cancel-work-button").textContent = readOnly ? "Close" : "Cancel";
}

function syncRequirements() {
  const status = statusInput.value;
  const active = ACTIVE_STATUSES.has(status);
  const done = status === "done";
  const review = status === "review";
  const waiting = status === "waiting";
  const statusChoicePending = state.conflictReview?.unresolvedKeys?.includes("status");
  if (!statusChoicePending) {
    if (!review && !state.originalApproverId) approverInput.value = "";
    if (!waiting) get("work-blocker").value = "";
  }
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
  const permissions = workApprovalPermissions(task, state.membership.user_id, isAdmin());

  /* Migration 002 intentionally rejects every update to an approved Done item
     from an unrelated member, not just a status change. Reflect that authority
     before somebody writes into fields that the database cannot save. */
  if (permissions.readOnly) {
    setFormReadOnly(true);
    get("work-status-guidance").textContent = `This approved item is locked. Only ${memberName(task.approver_id, "its approver")} or a workspace admin or owner can change or reopen it.`;
    archiveButton.hidden = true;
    return;
  }

  approverInput.disabled = permissions.disableApprover;
  statusInput.disabled = permissions.disableStatus;
  const doneOption = [...statusInput.options].find((option) => option.value === "done");
  if (doneOption) doneOption.disabled = permissions.disableDone;
  archiveButton.hidden = !permissions.canArchive;
}

function openNewTask() {
  if (!canEdit() || newWorkButton.disabled || state.refreshing || state.saving) return;
  state.dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.dialogOpenerTaskId = "";
  populateReferenceControls();
  form.reset();
  state.conflictDraft = null;
  state.conflictReview = null;
  reloadLatestButton.hidden = true;
  renderConflictReview();
  clearDialogStatus();
  if (!state.saving) saveButton.disabled = false;
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
  if (state.refreshing || state.saving) {
    boardStatus.textContent = state.saving
      ? "Wait for the current save to finish before opening another item."
      : "Wait for Refresh to finish before opening work.";
    return;
  }
  const task = taskById(id);
  if (!task) return;
  setMobileWorkStatus(task.status);
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.dialogOpener = activeElement?.matches("[data-open-task-id]") ? null : activeElement;
  state.dialogOpenerTaskId = id;
  state.conflictDraft = null;
  state.conflictReview = null;
  reloadLatestButton.hidden = true;
  renderConflictReview();
  clearDialogStatus();
  saveButton.disabled = false;
  populateReferenceControls();
  addMissingReferenceOption(get("work-workstream"), task.workstream_id, "Archived area");
  addMissingReferenceOption(ownerInput, task.owner_id, "Former member");
  addMissingReferenceOption(approverInput, task.approver_id, "Former member");
  setFormReadOnly(!canEdit());

  get("work-id").value = task.id;
  get("work-updated-at").value = task.updated_at;
  state.originalApproverId = task.approver_id || "";
  applyValuesToForm(valuesFromTask(task));
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

function valuesFromTask(task) {
  return {
    title: task.title || "",
    workstreamId: task.workstream_id || "",
    status: task.status || "backlog",
    ownerId: task.owner_id || "",
    approverId: task.approver_id || "",
    priority: task.priority || "normal",
    dueOn: task.due_on || "",
    nextAction: task.next_action || "",
    completion: task.completion_condition || "",
    blocker: task.blocker_note || "",
    flags: Array.isArray(task.flags) ? task.flags : [],
    sourceUrl: task.source_url || "",
    latestFileUrl: task.latest_file_url || "",
    position: Number.isInteger(task.position) ? task.position : 0
  };
}

function applyValuesToForm(values) {
  get("work-title-input").value = values.title;
  get("work-workstream").value = values.workstreamId;
  statusInput.value = values.status;
  ownerInput.value = values.ownerId;
  approverInput.value = values.approverId;
  get("work-priority").value = values.priority;
  get("work-date").value = values.dueOn;
  get("work-next-action").value = values.nextAction;
  get("work-completion").value = values.completion;
  get("work-blocker").value = values.blocker;
  form.querySelectorAll('input[name="flags"]').forEach((checkbox) => {
    checkbox.checked = values.flags.includes(checkbox.value);
  });
  get("work-source-url").value = values.sourceUrl;
  get("work-latest-file-url").value = values.latestFileUrl;
}

function validationError(values, editingId) {
  const editableMemberIds = new Set(state.members
    .filter((member) => !member.archived_at && ROLE_RANK[member.role] >= ROLE_RANK.member)
    .map((member) => member.user_id));
  return validateWorkValues(values, {
    editingId,
    tasks: state.tasks,
    editableMemberIds,
    isAdmin: isAdmin()
  });
}

function humanRepositoryError(error) {
  if (!(error instanceof HubRepositoryError)) {
    return { message: "The Hub could not save this change. Check your connection and try again.", fieldId: "" };
  }
  return translateWorkRepositoryError(error, valuesFromForm());
}

function setSaving(saving, busyLabel = "Saving…") {
  state.saving = saving;
  form.setAttribute("aria-busy", String(saving));
  if (saving) {
    form.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = true;
    });
  } else {
    const task = taskById(get("work-id").value);
    setFormReadOnly(Boolean(state.conflictDraft) || !canEdit());
    if (task && !state.conflictDraft) configureApprovalControls(task);
    if (state.conflictDraft) {
      get("work-dialog-title").textContent = state.conflictDraft.locked
        ? "Draft — item is now locked"
        : "Work item changed";
      get("cancel-work-button").textContent = "Cancel";
    }
  }
  saveButton.disabled = saving
    || Boolean(state.conflictDraft)
    || Boolean(state.conflictReview?.unresolvedKeys?.length);
  archiveButton.disabled = saving
    || Boolean(state.conflictDraft)
    || Boolean(state.conflictReview?.unresolvedKeys?.length);
  reloadLatestButton.disabled = saving;
  newWorkButton.disabled = saving || !canEdit();
  refreshButton.disabled = saving || state.refreshing;
  get("close-work-dialog").disabled = saving;
  get("cancel-work-button").disabled = saving;
  saveButton.textContent = saving ? busyLabel : "Save work";
}

async function reloadLatestConflict() {
  const conflict = state.conflictDraft;
  const userId = state.user?.id;
  if (!conflict || !userId || state.saving || !state.repository) return;
  const generation = state.generation;
  setSaving(true, "Reloading…");
  clearDialogStatus();
  clearFormError();
  try {
    const workspaceData = await state.repository.loadWorkspace(userId);
    if (generation !== state.generation || state.user?.id !== userId) return;
    if (!workspaceData) {
      showAccessDenied();
      return;
    }

    state.membership = workspaceData.membership;
    state.workspace = workspaceData.workspace;
    state.members = workspaceData.members;
    state.workstreams = workspaceData.workstreams;
    state.tasks = workspaceData.tasks;
    state.stale = false;
    state.lastRefreshedAt = Date.now();
    const latest = taskById(conflict.id);
    if (!latest) {
      state.conflictDraft = { ...conflict, removed: true };
      reloadLatestButton.hidden = true;
      setFormReadOnly(true);
      renderBoard();
      showFormError("This item was archived or removed by someone else. Your draft remains visible here, but it can no longer be saved.");
      return;
    }

    if (!canEdit()) {
      state.conflictDraft = { ...conflict, locked: true, accessChanged: true };
      reloadLatestButton.hidden = true;
      setFormReadOnly(true);
      renderBoard();
      showFormError("Your workspace access changed while this draft was open. The draft remains visible so you can copy it, but it can no longer be saved.");
      return;
    }

    const permissions = workApprovalPermissions(latest, state.membership.user_id, isAdmin());
    if (permissions.readOnly) {
      state.conflictDraft = { ...conflict, locked: true };
      reloadLatestButton.hidden = true;
      renderBoard();
      showFormError("This item was approved by someone else and is now locked. Your unsaved draft is still visible here so you can copy it, but it cannot be saved.");
      return;
    }

    populateReferenceControls();
    addMissingReferenceOption(get("work-workstream"), latest.workstream_id, "Archived area");
    addMissingReferenceOption(get("work-workstream"), conflict.draftValues.workstreamId, "No longer active");
    addMissingReferenceOption(ownerInput, latest.owner_id, "Former member");
    addMissingReferenceOption(approverInput, latest.approver_id, "Former member");
    addMissingReferenceOption(ownerInput, conflict.draftValues.ownerId, "No longer active");
    addMissingReferenceOption(approverInput, conflict.draftValues.approverId, "No longer active");
    get("work-updated-at").value = latest.updated_at;
    state.originalApproverId = latest.approver_id || "";

    const latestValues = valuesFromTask(latest);
    const merged = reconcileWorkDraft(
      conflict.baseValues,
      conflict.draftValues,
      latestValues,
      permissions
    );
    const protectedFields = merged.protectedFields;
    const unresolvedKeys = merged.unresolvedFields;

    state.conflictReview = unresolvedKeys.length ? {
      unresolvedKeys: [...unresolvedKeys],
      protectedFields: [...protectedFields],
      draftValues: conflict.draftValues,
      latestValues,
      mergedValues: merged.values
    } : null;
    applyValuesToForm(latestValues);
    syncRequirements();
    captureFormBaseline();
    applyValuesToForm(merged.values);
    syncRequirements();
    setFormReadOnly(!canEdit());
    configureApprovalControls(latest);
    state.conflictDraft = null;
    reloadLatestButton.hidden = true;
    renderConflictReview();
    renderBoard();
    if (unresolvedKeys.length) {
      const labels = unresolvedKeys.map((key) => CONFLICT_FIELD_LABELS[key]).filter(Boolean).join(", ");
      showDialogStatus(`Latest version loaded. Choose which ${labels || "conflicting values"} to keep before saving.${protectedConflictNote(state.conflictReview)}`, { focus: true });
    } else if (protectedFields.length) {
      const labels = protectedFields.map((key) => CONFLICT_FIELD_LABELS[key]?.toLowerCase()).filter(Boolean).join(", ");
      showDialogStatus(`Latest version loaded. Your other edits are still here; the latest ${labels || "approval workflow"} was kept because approval authority changed.`, { focus: true });
    } else {
      showDialogStatus("Latest version loaded. Your edits are still here and ready to review.", { focus: true });
    }
    boardStatus.textContent = "Latest item loaded; draft ready to review.";
  } catch {
    showFormError("The latest version could not be loaded. Check your connection and try again.");
  } finally {
    if (generation === state.generation) setSaving(false);
  }
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
  // Codex — 2026-08-13: Work refresh owns the return path. Cancel any older
  // Home request/visibility receipt; renderWorkspace starts exactly one fresh
  // Home check after the current task state is installed.
  state.homeActivityRequestSequence += 1;
  disconnectHomeActivityObserver();
  if (state.homeActivity.status === "loading") state.homeActivity.status = "idle";
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
      state.formBaselineValues = null;
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
    renderHomeFocus();
    setSyncState("Refresh failed", false);
    showAppError("The last loaded board is still visible, but editing is paused until refresh succeeds.");
    return false;
  }
}

async function saveTask(event) {
  event.preventDefault();
  if (
    !canEdit()
    || state.saving
    || state.conflictDraft
    || state.conflictReview?.unresolvedKeys?.length
  ) return;
  clearDialogStatus();
  syncRequirements();
  const id = get("work-id").value;
  const values = valuesFromForm();
  const invalid = validationError(values, id);
  if (invalid) {
    showFormError(invalid.message, invalid.fieldId);
    return;
  }
  if (!form.checkValidity()) {
    const invalidControl = form.querySelector("input:invalid, select:invalid, textarea:invalid");
    if (invalidControl && get("work-more-details").contains(invalidControl)) get("work-more-details").open = true;
    showFormError("Check this field and try again.", invalidControl?.id || "");
    form.reportValidity();
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
      state.conflictReview = null;
      renderConflictReview();
      state.conflictDraft = {
        id,
        baseValues: state.formBaselineValues || values,
        draftValues: values
      };
      reloadLatestButton.hidden = false;
      showFormError("This item changed elsewhere, so your draft was not saved. Choose Reload latest version below; your typing will stay here for review.");
      boardStatus.textContent = "Draft not saved because the item changed elsewhere.";
      return;
    }
    state.conflictDraft = null;
    state.conflictReview = null;
    renderConflictReview();
    reloadLatestButton.hidden = true;
    setMobileWorkStatus(values.status);
    state.formBaseline = null;
    state.formBaselineValues = null;
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
  if (
    !task
    || !canEdit()
    || state.saving
    || state.conflictDraft
    || state.conflictReview?.unresolvedKeys?.length
    || archiveButton.hidden
  ) return;
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
    state.conflictDraft = null;
    reloadLatestButton.hidden = true;
    state.formBaseline = null;
    state.formBaselineValues = null;
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
  state.formBaselineValues = null;
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
  state.formBaselineValues = null;
  state.conflictDraft = null;
  state.conflictReview = null;
  reloadLatestButton.hidden = true;
  renderConflictReview();
  clearDialogStatus();
  if (!state.saving) saveButton.disabled = false;
  const shouldRefresh = state.refreshWhenDialogCloses;
  state.refreshWhenDialogCloses = false;
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
  if (shouldRefresh) window.setTimeout(refreshAfterReturning, 0);
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
  reloadLatestButton.addEventListener("click", reloadLatestConflict);
  conflictFields.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-conflict-key]");
    if (!button) return;
    resolveConflictChoice(button.dataset.conflictKey, button.dataset.conflictChoice);
  });
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
  window.addEventListener("focus", refreshHomeAfterReturning);
  document.addEventListener("visibilitychange", refreshHomeAfterReturning);
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
    state.formBaselineValues = null;
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
  get("home-changes-retry").addEventListener("click", () => {
    void refreshHomeActivity();
  });
  get("home-focus-action").addEventListener("click", (event) => {
    const taskId = event.currentTarget.dataset.taskId;
    const homeAction = event.currentTarget.dataset.homeAction;
    if (homeAction === "refresh") {
      void requestWorkspaceRefresh();
      return;
    }
    window.location.hash = "work";
    if (taskId) window.setTimeout(() => openTask(taskId), 0);
    else if (homeAction === "create") window.setTimeout(openNewTask, 0);
    else {
      if (homeAction === "open-backlog") setMobileWorkStatus("backlog");
      window.setTimeout(() => get("work").focus(), 0);
    }
  });
}

function boot() {
  const phoneLayout = window.matchMedia("(max-width: 820px)");
  get("work-tools").open = !phoneLayout.matches;
  phoneLayout.addEventListener("change", (event) => {
    get("work-tools").open = !event.matches;
  });
  bindEvents();
  // Codex — 2026-08-13: consume a deep link that existed before listeners were bound.
  activateSection(sectionIdFromHash());
  const validation = validateHubConfig(globalThis.FAKESNIFF_HUB_CONFIG);
  state.config = validation.config;
  applyEnvironmentMarker(state.config);
  if (!validation.ok || state.config.mode === "setup") {
    showSetupMode(validation.errors);
    return;
  }
  void startConnectedMode();
}

boot();
