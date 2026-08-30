/* Codex — 2026-08-12: pure Work rules shared by the browser UI and tests. */

import { addTranslations, t } from "./hub-i18n.js";
import en from "./lang/en.js";
import nl from "./lang/nl.js";

/* Codex — 2026-08-30: policy tests import this module without hub.js, so the
   safe, human error boundary registers its own dictionaries as well. */
addTranslations("en", en);
addTranslations("nl", nl);

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

const WORK_STATUS_KEYS = Object.freeze({
  backlog: "work.status_backlog",
  this_week: "work.status_this_week",
  doing: "work.status_doing",
  review: "work.status_review",
  waiting: "work.status_waiting",
  done: "work.status_done"
});

export function workStatusLabel(status) {
  return t(WORK_STATUS_KEYS[status] || "work.stage_fallback");
}

function translatedIssue(key, fieldId = "", vars = undefined) {
  const result = { message: t(key, vars), fieldId };
  /* Metadata lets an open inline error retranslate without changing the public
     result shape consumed by older tests and integrations. */
  Object.defineProperties(result, {
    key: { value: key, enumerable: false },
    vars: { value: vars || null, enumerable: false }
  });
  return result;
}

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
  const issue = (key, fieldId, vars) => translatedIssue(key, fieldId, vars);
  const statusLabel = workStatusLabel(values.status);
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

  if (!values.title) return issue("work.error_title_required", "work-title-input");
  if (values.title.length > 240) return issue("work.error_title_length", "work-title-input");
  if (!WORK_STATUSES.includes(values.status)) return issue("work.error_stage_invalid", "work-status");

  if (active) {
    if (!values.ownerId) return issue("work.error_owner_before_stage", "work-owner", {
      stage: statusLabel,
      stageCode: values.status
    });
    if (ownerNeedsRevalidation && !editableMemberIds.has(values.ownerId)) {
      return issue("work.error_owner_inactive", "work-owner");
    }
    if (!values.dueOn) return issue("work.error_due_before_stage", "work-date", {
      stage: statusLabel,
      stageCode: values.status
    });
    if (!values.nextAction) return issue("work.error_next_required", "work-next-action");
    if (!values.completion) return issue("work.error_completion_required", "work-completion");
  }

  if (values.status === "done") {
    if (!values.ownerId) return issue("work.error_done_owner", "work-owner");
    if (ownerNeedsRevalidation && !editableMemberIds.has(values.ownerId)) {
      return issue("work.error_owner_inactive", "work-owner");
    }
    if (!values.completion) return issue("work.error_done_result", "work-completion");
  }

  if (values.status === "waiting" && !values.blocker) {
    return issue("work.error_waiting_reason", "work-blocker");
  }

  if (values.status === "review" && !values.approverId) {
    return issue("work.error_reviewer_required", "work-approver");
  }
  if (values.approverId && values.ownerId === values.approverId) {
    return issue("work.error_reviewer_not_owner", "work-approver");
  }
  if (values.approverId && approverNeedsRevalidation && !editableMemberIds.has(values.approverId)) {
    if (existing?.approver_id === values.approverId && !isAdmin) {
      return issue("work.error_inactive_reviewer_admin", "work-status");
    }
    return issue("work.error_reviewer_inactive", "work-approver");
  }

  if (values.status === "done" && values.approverId && !isAdmin) {
    if (!existing) return issue("work.error_review_first", "work-status");
    if (!existing.approver_id) return issue("work.error_reviewer_first", "work-status");
  }

  if (!isValidWorkUrl(values.sourceUrl)) {
    return issue("work.error_source_url", "work-source-url");
  }
  if (!isValidWorkUrl(values.latestFileUrl, { httpsOnly: true })) {
    return issue("work.error_file_url", "work-latest-file-url");
  }

  return null;
}

export function translateWorkRepositoryError({ serverMessage = "", code = "" } = {}, current = {}) {
  const issue = (key, fieldId = "", vars) => translatedIssue(key, fieldId, vars);
  const server = String(serverMessage || "").toLowerCase();

  if (server.includes("owner must be an active member")) return issue("work.error_owner_inactive", "work-owner");
  if (server.includes("approver must be an active member")) return issue("work.error_reviewer_inactive", "work-approver");
  if (server.includes("workspace admin can create completed approval-bound")) return issue("work.error_review_first", "work-status");
  if (server.includes("workspace admin can change an assigned approver")) return issue("work.error_reviewer_locked", "work-approver");
  if (server.includes("approval must be assigned before completion")) return issue("work.error_reviewer_first", "work-status");
  if (server.includes("archive this task")) return issue("work.error_archive_permission");
  if (server.includes("move this review")) return issue("work.error_move_review_permission", "work-status");
  if (server.includes("reopen this task")) return issue("work.error_reopen_permission", "work-status");
  if (server.includes("complete this task")) return issue("work.error_complete_permission", "work-status");
  if (server.includes("the this week lane is limited to three tasks")) return issue("work.error_week_limit", "work-status");
  if (server.includes("tasks_one_doing_per_owner_active_uidx") || server.includes("one active doing")) {
    return issue("work.error_doing_limit", "work-owner");
  }

  if (server.includes("tasks_title_length")) return issue("work.error_title_length", "work-title-input");
  if (server.includes("tasks_status_allowed")) return issue("work.error_stage_invalid", "work-status");
  if (server.includes("tasks_priority_allowed")) return issue("work.error_priority_invalid", "work-priority");
  if (server.includes("tasks_position_nonnegative")) return issue("work.error_position_invalid");
  if (server.includes("tasks_kind_allowed")) return issue("work.error_type_invalid");
  if (server.includes("tasks_flags_allowed")) return issue("work.error_flags_invalid");
  if (server.includes("tasks_source_url_http")) return issue("work.error_source_url", "work-source-url");
  if (server.includes("tasks_latest_file_url_https")) return issue("work.error_file_url", "work-latest-file-url");
  if (server.includes("tasks_waiting_has_reason")) return issue("work.error_waiting_reason", "work-blocker");
  if (server.includes("tasks_review_has_separate_approver")) {
    return current.approverId
      ? issue("work.error_reviewer_not_owner", "work-approver")
      : issue("work.error_reviewer_required", "work-approver");
  }
  if (server.includes("tasks_active_work_fields_present")) {
    if (!current.ownerId) return issue("work.error_active_owner", "work-owner");
    if (!current.dueOn) return issue("work.error_active_due", "work-date");
    if (!current.nextAction) return issue("work.error_active_next", "work-next-action");
    if (!current.completion) return issue("work.error_active_completion", "work-completion");
    return issue("work.error_active_details");
  }
  if (server.includes("tasks_done_fields_present")) {
    if (!current.ownerId) return issue("work.error_completed_owner", "work-owner");
    if (!current.completion) return issue("work.error_completed_result", "work-completion");
    return issue("work.error_completed_details");
  }

  if (code === "23505") return issue("work.error_concurrent_save");
  if (code === "23503") {
    if (server.includes("tasks_workstream_fk")) return issue("work.error_area_missing", "work-workstream");
    if (server.includes("tasks_owner_fk")) return issue("work.error_owner_missing", "work-owner");
    if (server.includes("tasks_approver_fk")) return issue("work.error_reviewer_missing", "work-approver");
    if (server.includes("tasks_source_design_fk")) return issue("work.error_design_missing");
    if (server.includes("tasks_source_idea_fk")) return issue("work.error_idea_missing");
    return issue("work.error_linked_changed");
  }
  if (code === "23514") return issue("work.error_legacy_rule");
  if (["42501", "PGRST301"].includes(code)) return issue("work.error_access_changed");
  return issue("work.error_save_unknown");
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
