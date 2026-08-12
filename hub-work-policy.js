/* Codex — 2026-08-12: pure Work rules shared by the browser UI and tests. */

export const WORK_STATUSES = ["backlog", "this_week", "doing", "review", "waiting", "done"];
export const ACTIVE_WORK_STATUSES = new Set(["this_week", "doing", "review", "waiting"]);

export const WORK_STATUS_LABELS = Object.freeze({
  backlog: "Backlog",
  this_week: "This week",
  doing: "Doing",
  review: "Review / Decision",
  waiting: "Waiting / Blocked",
  done: "Done"
});

export function isValidWorkUrl(value, { httpsOnly = false } = {}) {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  const allowedPrefix = httpsOnly ? /^https:\/\// : /^https?:\/\//;
  if (!allowedPrefix.test(value)) return false;
  try {
    const parsed = new URL(value);
    return httpsOnly ? parsed.protocol === "https:" : ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function validateWorkValues(values, {
  editingId = "",
  tasks = [],
  editableMemberIds = new Set(),
  isAdmin = false
} = {}) {
  const issue = (message, fieldId) => ({ message, fieldId });
  const statusLabel = WORK_STATUS_LABELS[values.status] || "that stage";
  const active = ACTIVE_WORK_STATUSES.has(values.status);
  const existing = tasks.find((task) => task.id === editingId);
  const existingWasActive = Boolean(existing && (ACTIVE_WORK_STATUSES.has(existing.status) || existing.status === "done"));
  const ownerNeedsRevalidation = !existing
    || values.ownerId !== existing.owner_id
    || !existingWasActive
    || (values.status !== existing.status && (active || values.status === "done"));
  const approverNeedsRevalidation = !existing
    || values.approverId !== existing.approver_id
    || (values.status === "review" && existing.status !== "review")
    || (values.status === "done" && existing.status !== "done");

  if (!values.title) return issue("Add a short title so the team can recognise this work.", "work-title-input");
  if (values.title.length > 240) return issue("Shorten the title to 240 characters or fewer.", "work-title-input");
  if (!WORK_STATUSES.includes(values.status)) return issue("Choose one of the available stages.", "work-status");

  if (active) {
    if (!values.ownerId) return issue(`Choose who owns this before moving it to ${statusLabel}.`, "work-owner");
    if (ownerNeedsRevalidation && !editableMemberIds.has(values.ownerId)) {
      return issue("That owner can no longer edit work. Refresh and choose an active team member.", "work-owner");
    }
    if (!values.dueOn) return issue(`Add a due date before moving this to ${statusLabel}.`, "work-date");
    if (!values.nextAction) return issue("Write the next concrete step so the owner knows what to do.", "work-next-action");
    if (!values.completion) return issue("Describe the result that will mean this work is Done.", "work-completion");
  }

  if (values.status === "done") {
    if (!values.ownerId) return issue("Choose who completed this work before marking it Done.", "work-owner");
    if (ownerNeedsRevalidation && !editableMemberIds.has(values.ownerId)) {
      return issue("That owner can no longer edit work. Refresh and choose an active team member.", "work-owner");
    }
    if (!values.completion) return issue("Record the result that means this work is Done.", "work-completion");
  }

  if (values.status === "waiting" && !values.blocker) {
    return issue("Say which person, answer, file, or event this work is waiting for.", "work-blocker");
  }

  if (values.status === "review" && !values.approverId) {
    return issue("Choose another team member to review this work.", "work-approver");
  }
  if (values.approverId && values.ownerId === values.approverId) {
    return issue("Choose someone other than the owner to approve this work.", "work-approver");
  }
  if (values.approverId && approverNeedsRevalidation && !editableMemberIds.has(values.approverId)) {
    if (existing?.approver_id === values.approverId && !isAdmin) {
      return issue("This item's approver is no longer active and only a workspace admin or owner can replace them. Ask an admin to repair the approval before moving this item to Review or Done.", "work-status");
    }
    return issue("That approver is no longer available. Refresh and choose another active team member.", "work-approver");
  }

  if (values.status === "done" && values.approverId && !isAdmin) {
    if (!existing) return issue("Save this for Review first. The chosen approver can mark it Done afterward.", "work-status");
    if (!existing.approver_id) return issue("Save the approver first. Then that person can mark the item Done.", "work-status");
  }

  if (!isValidWorkUrl(values.sourceUrl)) {
    return issue("Remove spaces from the source link and make sure it starts with lowercase http:// or https://.", "work-source-url");
  }
  if (!isValidWorkUrl(values.latestFileUrl, { httpsOnly: true })) {
    return issue("Remove spaces from the file link and make sure it starts with lowercase https://.", "work-latest-file-url");
  }

  return null;
}

export function translateWorkRepositoryError({ serverMessage = "", code = "" } = {}, current = {}) {
  const issue = (message, fieldId = "") => ({ message, fieldId });
  const server = String(serverMessage || "").toLowerCase();

  if (server.includes("owner must be an active member")) return issue("That owner can no longer edit work. Refresh and choose an active team member.", "work-owner");
  if (server.includes("approver must be an active member")) return issue("That approver is no longer available. Refresh and choose another active team member.", "work-approver");
  if (server.includes("workspace admin can create completed approval-bound")) return issue("Save this for Review first. The approver can mark it Done afterward.", "work-status");
  if (server.includes("workspace admin can change an assigned approver")) return issue("The approver is locked after assignment. Ask a workspace admin or owner to change it.", "work-approver");
  if (server.includes("approval must be assigned before completion")) return issue("Save the approver first. Then that person can mark the item Done.", "work-status");
  if (server.includes("archive this task")) return issue("Only this item's approver or a workspace admin or owner can archive it.");
  if (server.includes("move this review")) return issue("This review is waiting for its approver. Only that person or a workspace admin or owner can move it.", "work-status");
  if (server.includes("reopen this task")) return issue("Only this item's approver or a workspace admin or owner can reopen it.", "work-status");
  if (server.includes("complete this task")) return issue("Only the assigned approver or a workspace admin or owner can mark this Done.", "work-status");
  if (server.includes("the this week lane is limited to three tasks")) return issue("This week already has three items. Refresh to see the latest board, then move or finish one before adding another.", "work-status");
  if (server.includes("tasks_one_doing_per_owner_active_uidx") || server.includes("one active doing")) {
    return issue("That owner already has one item in Doing. Refresh to see it, then finish or move it before starting another.", "work-owner");
  }

  if (server.includes("tasks_title_length")) return issue("Add a title of 240 characters or fewer.", "work-title-input");
  if (server.includes("tasks_status_allowed")) return issue("Choose one of the available stages.", "work-status");
  if (server.includes("tasks_priority_allowed")) return issue("Choose one of the available priorities.", "work-priority");
  if (server.includes("tasks_position_nonnegative")) return issue("This older item's board position is invalid. Ask a workspace admin or owner to repair it.");
  if (server.includes("tasks_kind_allowed")) return issue("This older item has an unsupported type. Ask a workspace admin or owner to repair it.");
  if (server.includes("tasks_flags_allowed")) return issue("Choose only the available attention flags.");
  if (server.includes("tasks_source_url_http")) return issue("Remove spaces from the source link and make sure it starts with lowercase http:// or https://.", "work-source-url");
  if (server.includes("tasks_latest_file_url_https")) return issue("Remove spaces from the file link and make sure it starts with lowercase https://.", "work-latest-file-url");
  if (server.includes("tasks_waiting_has_reason")) return issue("Say which person, answer, file, or event this work is waiting for.", "work-blocker");
  if (server.includes("tasks_review_has_separate_approver")) {
    return current.approverId
      ? issue("Choose someone other than the owner to approve this work.", "work-approver")
      : issue("Choose another team member to review this work.", "work-approver");
  }
  if (server.includes("tasks_active_work_fields_present")) {
    if (!current.ownerId) return issue("Choose who owns this active work.", "work-owner");
    if (!current.dueOn) return issue("Add a due date for this active work.", "work-date");
    if (!current.nextAction) return issue("Write the next concrete step for this active work.", "work-next-action");
    if (!current.completion) return issue("Describe the result that will mean this work is Done.", "work-completion");
    return issue("Review the required details for this active work, save it, and try again.");
  }
  if (server.includes("tasks_done_fields_present")) {
    if (!current.ownerId) return issue("Choose who completed this work.", "work-owner");
    if (!current.completion) return issue("Record the result that made this work complete.", "work-completion");
    return issue("Review the completion details, save the item, and try again.");
  }

  if (code === "23505") return issue("This item conflicts with another saved change. Refresh the Hub and try again.");
  if (code === "23503") {
    if (server.includes("tasks_workstream_fk")) return issue("That area is no longer available. Refresh and choose another area.", "work-workstream");
    if (server.includes("tasks_owner_fk")) return issue("That owner is no longer available. Refresh and choose another team member.", "work-owner");
    if (server.includes("tasks_approver_fk")) return issue("That approver is no longer available. Refresh and choose another team member.", "work-approver");
    if (server.includes("tasks_source_design_fk")) return issue("That source design is no longer available. Refresh and choose another design.");
    if (server.includes("tasks_source_idea_fk")) return issue("That source idea is no longer available. Refresh and choose another idea.");
    return issue("A linked idea, design, or workspace changed. Refresh the Hub and try again.");
  }
  if (code === "23514") return issue("This older item does not meet a current Hub rule. Ask a workspace admin or owner to repair it.");
  if (["42501", "PGRST301"].includes(code)) return issue("Your workspace access changed. Refresh the Hub or sign in again.");
  return issue("The Hub could not save this change. Check your connection, then refresh and try again.");
}

export function workApprovalPermissions(task, actorId, isAdmin) {
  const actorIsApprover = Boolean(task?.approver_id && task.approver_id === actorId);
  const approvalBound = Boolean(task?.approver_id);
  return {
    actorIsApprover,
    readOnly: Boolean(task?.status === "done" && approvalBound && !actorIsApprover && !isAdmin),
    disableApprover: Boolean(approvalBound && !isAdmin),
    disableStatus: Boolean(
      ((task?.status === "review") || (task?.status === "done" && approvalBound))
      && !actorIsApprover
      && !isAdmin
    ),
    disableDone: Boolean(approvalBound && !actorIsApprover && !isAdmin),
    canArchive: Boolean(isAdmin || actorIsApprover || (!approvalBound && task?.status !== "review"))
  };
}

const MERGE_VALUE_KEYS = Object.freeze([
  "title", "workstreamId", "status", "ownerId", "approverId", "priority",
  "dueOn", "nextAction", "completion", "blocker", "flags", "sourceUrl",
  "latestFileUrl", "position"
]);

function sameWorkValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
  }
  return left === right;
}

export function mergeWorkDraft(base, draft, latest) {
  const values = { ...latest, flags: [...(latest.flags || [])] };
  const conflictedFields = [];
  const reappliedFields = [];

  for (const key of MERGE_VALUE_KEYS) {
    if (sameWorkValue(draft[key], base[key])) continue;
    if (!sameWorkValue(latest[key], base[key]) && !sameWorkValue(latest[key], draft[key])) {
      conflictedFields.push(key);
      continue;
    }
    values[key] = Array.isArray(draft[key]) ? [...draft[key]] : draft[key];
    reappliedFields.push(key);
  }
  return { values, conflictedFields, reappliedFields };
}

export function reconcileWorkDraft(base, draft, latest, permissions = {}) {
  const merged = mergeWorkDraft(base, draft, latest);
  const protectedFields = [];
  const keepLatest = (key) => {
    merged.values[key] = Array.isArray(latest[key]) ? [...latest[key]] : latest[key];
    if (!sameWorkValue(draft[key], latest[key]) && !protectedFields.includes(key)) {
      protectedFields.push(key);
    }
  };

  if (permissions.disableStatus) keepLatest("status");
  if (permissions.disableDone && draft.status === "done") keepLatest("status");
  if (permissions.disableApprover) keepLatest("approverId");

  return {
    ...merged,
    protectedFields,
    unresolvedFields: merged.conflictedFields.filter((key) => !protectedFields.includes(key))
  };
}

function dueOrder(task) {
  return task.due_on || "9999-12-31";
}

function stableTaskOrder(left, right) {
  return dueOrder(left).localeCompare(dueOrder(right))
    || Number(left.position || 0) - Number(right.position || 0)
    || String(left.created_at || "").localeCompare(String(right.created_at || ""))
    || String(left.id || "").localeCompare(String(right.id || ""));
}

export function selectHomeFocus(tasks, memberId, todayIso) {
  const visible = tasks.filter((task) => !task.archived_at && task.status !== "done");
  const first = (matches) => [...matches].sort(stableTaskOrder)[0] || null;

  const assignedReview = first(visible.filter((task) => task.status === "review" && task.approver_id === memberId));
  if (assignedReview) return { task: assignedReview, reason: "assigned_review" };

  const ownedOverdue = first(visible.filter((task) => (
    ACTIVE_WORK_STATUSES.has(task.status)
    && task.owner_id === memberId
    && task.due_on
    && task.due_on < todayIso
  )));
  if (ownedOverdue) return { task: ownedOverdue, reason: "owned_overdue" };

  const ownedDoing = first(visible.filter((task) => task.status === "doing" && task.owner_id === memberId));
  if (ownedDoing) return { task: ownedDoing, reason: "owned_doing" };

  const ownedThisWeek = first(visible.filter((task) => task.status === "this_week" && task.owner_id === memberId));
  if (ownedThisWeek) return { task: ownedThisWeek, reason: "owned_this_week" };

  const teamAttention = first(visible.filter((task) => ["review", "waiting"].includes(task.status)));
  if (teamAttention) return { task: teamAttention, reason: "team_attention" };
  return null;
}
