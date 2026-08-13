import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidWorkUrl,
  mergeWorkDraft,
  reconcileWorkDraft,
  selectHomeFocus,
  translateWorkRepositoryError,
  validateWorkValues,
  workApprovalPermissions
} from "../hub-work-policy.js";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const editableMemberIds = new Set([MEMBER, OTHER]);

function values(overrides = {}) {
  return {
    title: "Ship the sample",
    status: "backlog",
    ownerId: "",
    approverId: "",
    priority: "normal",
    dueOn: "",
    nextAction: "",
    completion: "",
    blocker: "",
    flags: [],
    sourceUrl: "",
    latestFileUrl: "",
    ...overrides
  };
}

function validate(overrides, context = {}) {
  return validateWorkValues(values(overrides), { editableMemberIds, ...context });
}

test("active stages explain each missing field in human language", () => {
  assert.deepEqual(validate({ status: "this_week" }), {
    message: "Choose who owns this before moving it to This week.", fieldId: "work-owner"
  });
  assert.equal(validate({ status: "doing", ownerId: MEMBER }).fieldId, "work-date");
  assert.equal(validate({ status: "doing", ownerId: MEMBER, dueOn: "2026-08-14" }).fieldId, "work-next-action");
  assert.equal(validate({
    status: "doing", ownerId: MEMBER, dueOn: "2026-08-14", nextAction: "Call the supplier"
  }).fieldId, "work-completion");
});

test("waiting and review state requirements are specific", () => {
  const ready = { ownerId: MEMBER, dueOn: "2026-08-14", nextAction: "Send it", completion: "Approved" };
  assert.equal(validate({ ...ready, status: "waiting" }).fieldId, "work-blocker");
  assert.equal(validate({ ...ready, status: "review" }).message, "Choose another team member to review this work.");
  assert.equal(validate({ ...ready, status: "review", approverId: MEMBER }).message, "Choose someone other than the owner to approve this work.");
});

test("former members cannot receive active or approval work", () => {
  assert.match(validate({
    status: "doing", ownerId: "former", dueOn: "2026-08-14", nextAction: "Send it", completion: "Sent"
  }).message, /owner can no longer edit/i);
  assert.match(validate({
    status: "review", ownerId: MEMBER, approverId: "former", dueOn: "2026-08-14", nextAction: "Check", completion: "Approved"
  }).message, /approver is no longer available/i);
});

test("unchanged former references do not make ordinary metadata edits impossible", () => {
  const former = "former";
  const common = { dueOn: "2026-08-14", nextAction: "Send it", completion: "Sent" };
  assert.equal(validate({ ...common, status: "doing", ownerId: former }, {
    editingId: "task", tasks: [{ id: "task", status: "doing", owner_id: former, approver_id: null }]
  }), null);
  assert.match(validate({ ...common, status: "waiting", ownerId: former, blocker: "Supplier" }, {
    editingId: "task", tasks: [{ id: "task", status: "doing", owner_id: former, approver_id: null }]
  }).message, /owner can no longer edit/i);
  assert.equal(validate({ ...common, status: "doing", ownerId: MEMBER, approverId: former }, {
    editingId: "task", tasks: [{ id: "task", status: "doing", owner_id: MEMBER, approver_id: former }]
  }), null);
  assert.match(validate({ ...common, status: "review", ownerId: MEMBER, approverId: former }, {
    editingId: "task", tasks: [{ id: "task", status: "doing", owner_id: MEMBER, approver_id: former }]
  }).message, /only a workspace admin or owner can replace/i);
});

test("cached WIP state never blocks a database-valid save", () => {
  const tasks = ["a", "b", "c"].map((id) => ({ id, status: "this_week", owner_id: OTHER }));
  const common = { ownerId: MEMBER, dueOn: "2026-08-14", nextAction: "Send it", completion: "Sent" };
  assert.equal(validate({ ...common, status: "this_week" }, { tasks }), null);
  assert.equal(validate({ ...common, status: "doing" }, {
    tasks: [{ id: "d", status: "doing", owner_id: MEMBER }]
  }), null);
});

test("approval cannot be assigned while skipping straight to Done", () => {
  assert.match(validate({ status: "done", ownerId: MEMBER, approverId: OTHER, completion: "Approved" }).message, /Save this for Review first/i);
  assert.match(validate({ status: "done", ownerId: MEMBER, approverId: OTHER, completion: "Approved" }, {
    editingId: "task", tasks: [{ id: "task", approver_id: null }]
  }).message, /Save the approver first/i);
});

test("client URLs match the database lowercase-scheme rules", () => {
  assert.equal(isValidWorkUrl("https://example.com/path"), true);
  assert.equal(isValidWorkUrl("HTTPS://example.com/path"), false);
  assert.equal(isValidWorkUrl("http://example.com/path", { httpsOnly: true }), false);
  assert.equal(isValidWorkUrl("https://example.com/a b"), false);
});

test("every migration workflow error has plain-language guidance", () => {
  const cases = [
    ["Owner must be an active member who can update work", "work-owner"],
    ["Approver must be an active member who can update work", "work-approver"],
    ["Only a workspace admin can create completed approval-bound work", "work-status"],
    ["Only a workspace admin can change an assigned approver", "work-approver"],
    ["Approval must be assigned before completion", "work-status"],
    ["Only the assigned approver or a workspace admin can archive this task", ""],
    ["Only the assigned approver or a workspace admin can move this review", "work-status"],
    ["Only the assigned approver or a workspace admin can reopen this task", "work-status"],
    ["Only the assigned approver or a workspace admin can complete this task", "work-status"],
    ["The This week lane is limited to three tasks", "work-status"],
    ["duplicate key value violates unique constraint \"tasks_one_doing_per_owner_active_uidx\"", "work-owner"]
  ];
  for (const [serverMessage, fieldId] of cases) {
    const translated = translateWorkRepositoryError({ serverMessage });
    assert.equal(translated.fieldId, fieldId, serverMessage);
    assert.doesNotMatch(translated.message, /postgres|constraint|PGRST/i, serverMessage);
  }
});

test("check constraints point to the field a person can fix", () => {
  const active = translateWorkRepositoryError(
    { serverMessage: 'new row violates check constraint "tasks_active_work_fields_present"', code: "23514" },
    { ownerId: MEMBER, dueOn: "", nextAction: "", completion: "" }
  );
  assert.equal(active.fieldId, "work-date");
  const missingApprover = translateWorkRepositoryError(
    { serverMessage: 'new row violates check constraint "tasks_review_has_separate_approver"', code: "23514" },
    { approverId: "" }
  );
  assert.match(missingApprover.message, /Choose another team member/i);
});

test("all task check constraints avoid raw database language", () => {
  const constraints = [
    ["tasks_title_length", "work-title-input", /title/i],
    ["tasks_status_allowed", "work-status", /stage/i],
    ["tasks_priority_allowed", "work-priority", /priorit/i],
    ["tasks_position_nonnegative", "", /position/i],
    ["tasks_kind_allowed", "", /unsupported type/i],
    ["tasks_flags_allowed", "", /attention flags/i],
    ["tasks_source_url_http", "work-source-url", /source link/i],
    ["tasks_latest_file_url_https", "work-latest-file-url", /file link/i],
    ["tasks_waiting_has_reason", "work-blocker", /waiting/i],
    ["tasks_review_has_separate_approver", "work-approver", /team member/i],
    ["tasks_active_work_fields_present", "work-owner", /active work/i],
    ["tasks_done_fields_present", "work-owner", /completed this work/i]
  ];
  for (const [name, fieldId, messagePattern] of constraints) {
    const translated = translateWorkRepositoryError({
      serverMessage: `new row for relation "tasks" violates check constraint "${name}"`,
      code: "23514"
    }, {});
    assert.equal(translated.fieldId, fieldId, name);
    assert.match(translated.message, messagePattern, name);
    assert.doesNotMatch(translated.message, /constraint|postgres|new row/i, name);
  }
});

test("foreign-key and access failures name the safe recovery", () => {
  const foreignKeys = [
    ["tasks_workstream_fk", "work-workstream"],
    ["tasks_owner_fk", "work-owner"],
    ["tasks_approver_fk", "work-approver"],
    ["tasks_source_design_fk", ""],
    ["tasks_source_idea_fk", ""]
  ];
  for (const [name, fieldId] of foreignKeys) {
    const translated = translateWorkRepositoryError({
      serverMessage: `insert or update violates foreign key constraint "${name}"`, code: "23503"
    });
    assert.equal(translated.fieldId, fieldId, name);
    assert.match(translated.message, /Refresh|source design/i, name);
  }
  assert.match(translateWorkRepositoryError({ code: "42501" }).message, /access changed/i);
});

test("approval permissions do not leak from one item to the next", () => {
  const someoneElsesReview = workApprovalPermissions({ status: "review", approver_id: OTHER }, MEMBER, false);
  assert.equal(someoneElsesReview.disableStatus, true);
  assert.equal(someoneElsesReview.disableDone, true);
  assert.equal(someoneElsesReview.canArchive, false);

  const unrelatedTask = workApprovalPermissions({ status: "doing", approver_id: null }, MEMBER, false);
  assert.equal(unrelatedTask.disableStatus, false);
  assert.equal(unrelatedTask.disableDone, false);
  assert.equal(unrelatedTask.disableApprover, false);
  assert.equal(unrelatedTask.canArchive, true);
});

test("an unrelated member sees approval-bound Done work as read-only", () => {
  assert.equal(workApprovalPermissions({ status: "done", approver_id: OTHER }, MEMBER, false).readOnly, true);
  assert.equal(workApprovalPermissions({ status: "done", approver_id: MEMBER }, MEMBER, false).readOnly, false);
  assert.equal(workApprovalPermissions({ status: "done", approver_id: OTHER }, MEMBER, true).readOnly, false);
});

test("three-way merge reapplies only the user's changed fields", () => {
  const base = values({ title: "Old title", dueOn: "2026-08-14", flags: ["legal"] });
  const draft = { ...base, title: "My title", flags: ["legal", "budget"] };
  const latest = { ...base, dueOn: "2026-08-18", nextAction: "Teammate changed this" };
  const merged = mergeWorkDraft(base, draft, latest);
  assert.equal(merged.values.title, "My title");
  assert.equal(merged.values.dueOn, "2026-08-18");
  assert.equal(merged.values.nextAction, "Teammate changed this");
  assert.deepEqual(merged.values.flags, ["legal", "budget"]);
  assert.deepEqual(merged.conflictedFields, []);
});

test("three-way merge keeps the latest value when both people changed one field", () => {
  const base = values({ dueOn: "2026-08-14" });
  const draft = { ...base, dueOn: "2026-08-15" };
  const latest = { ...base, dueOn: "2026-08-16" };
  const merged = mergeWorkDraft(base, draft, latest);
  assert.equal(merged.values.dueOn, "2026-08-16");
  assert.deepEqual(merged.conflictedFields, ["dueOn"]);
});

test("approval reconciliation never reapplies an unauthorized Done draft", () => {
  const base = values({ status: "doing", ownerId: MEMBER });
  const draft = { ...base, status: "done", completion: "Finished" };
  const latest = { ...base, status: "waiting", approverId: OTHER, blocker: "Supplier" };
  const merged = reconcileWorkDraft(base, draft, latest, {
    disableDone: true,
    disableApprover: true,
    disableStatus: false
  });
  assert.equal(merged.values.status, "waiting");
  assert.equal(merged.values.approverId, OTHER);
  assert.ok(merged.protectedFields.includes("status"));
  assert.ok(!merged.unresolvedFields.includes("status"));
});

test("Home focus prioritises my approval, overdue work, Doing, then This week", () => {
  const base = [
    { id: "week", status: "this_week", owner_id: MEMBER, due_on: "2026-08-15" },
    { id: "doing", status: "doing", owner_id: MEMBER, due_on: "2026-08-16" },
    { id: "overdue", status: "waiting", owner_id: MEMBER, due_on: "2026-08-11" },
    { id: "review", status: "review", owner_id: OTHER, approver_id: MEMBER, due_on: "2026-08-20" }
  ];
  assert.deepEqual(selectHomeFocus(base, MEMBER, "2026-08-12"), { task: base[3], reason: "assigned_review" });
  assert.equal(selectHomeFocus(base.slice(0, 3), MEMBER, "2026-08-12").reason, "owned_overdue");
  assert.equal(selectHomeFocus(base.slice(0, 2), MEMBER, "2026-08-12").reason, "owned_doing");
  assert.equal(selectHomeFocus(base.slice(0, 1), MEMBER, "2026-08-12").reason, "owned_this_week");
});

test("Home focus ordering is stable and ignores completed work", () => {
  const tasks = [
    { id: "late", status: "this_week", owner_id: MEMBER, due_on: "2026-08-20", position: 0 },
    { id: "done", status: "done", owner_id: MEMBER, due_on: "2026-08-01" },
    { id: "early", status: "this_week", owner_id: MEMBER, due_on: "2026-08-14", position: 5 }
  ];
  assert.equal(selectHomeFocus(tasks, MEMBER, "2026-08-12").task.id, "early");
  assert.equal(selectHomeFocus([], MEMBER, "2026-08-12"), null);
});

test("Home focus safely sorts tasks without due dates", () => {
  const tasks = [
    { id: "no-date", status: "this_week", owner_id: MEMBER, due_on: null, position: 0 },
    { id: "dated", status: "this_week", owner_id: MEMBER, due_on: "2026-08-19", position: 9 }
  ];
  assert.equal(selectHomeFocus(tasks, MEMBER, "2026-08-12").task.id, "dated");
});
