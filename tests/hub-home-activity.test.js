import test from "node:test";
import assert from "node:assert/strict";

import {
  composeHomeActivity,
  normalizeHomeChanges,
  selectStaleReviews
} from "../hub-home-activity.js";

const EVENT = "11111111-1111-4111-8111-111111111111";
const EVENT_TWO = "22222222-2222-4222-8222-222222222222";
const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function change(overrides = {}) {
  return {
    eventId: EVENT,
    kind: "task_review",
    entityId: TASK,
    title: "Approve the sample",
    actorName: "Emiel",
    occurredAt: "2026-08-13T10:00:00Z",
    needsYou: true,
    receiptEventIds: [EVENT],
    ...overrides
  };
}

test("Home accepts only the sanitized change contract", () => {
  const result = normalizeHomeChanges({
    firstVisit: true,
    hasMore: true,
    lastOpenedAt: "2026-08-13T09:00:00Z",
    items: [
      { ...change(), event_data: { new: { secret: "must not survive" } }, storage_path: "private/file.jpg" },
      change({ eventId: "not-a-uuid", entityId: TASK_TWO }),
      change({ eventId: EVENT_TWO, entityId: TASK_TWO, kind: "admin_override" }),
      change({ eventId: EVENT_TWO, entityId: TASK_TWO, title: "" })
    ]
  });

  assert.equal(result.firstVisit, true);
  assert.equal(result.hasMore, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]), [
    "eventId", "kind", "entityId", "title", "actorName", "occurredAt", "needsYou", "receiptEventIds"
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|storage_path|private\/file/i);
});

test("malformed, duplicated and action-shaped audit data is discarded", () => {
  const result = normalizeHomeChanges({ items: [
    change(),
    change({ eventId: EVENT_TWO, title: "Duplicate event for the same task" }),
    change({ eventId: EVENT_TWO, entityId: TASK_TWO, title: "<script>alert(1)</script>", actorName: "A".repeat(200), receiptEventIds: [EVENT_TWO] }),
    { action: "navigate", section: "admin" },
    null
  ] });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].title, "<script>alert(1)</script>");
  assert.equal(result.items[1].actorName.length, 80);
  assert.equal("action" in result.items[1], false);
});

test("Home receipts only exact allow-listed event IDs from the RPC snapshot", () => {
  const result = normalizeHomeChanges({ items: [change({
    receiptEventIds: [EVENT, EVENT_TWO, EVENT, "not-an-event", { id: EVENT_TWO }]
  })] });

  assert.deepEqual(result.items[0].receiptEventIds, [EVENT, EVENT_TWO]);
  assert.equal("event_data" in result.items[0], false);
});

test("reviews become persistent attention only after a full untouched day", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  const tasks = [
    { id: TASK, title: "Mine", status: "review", approver_id: MEMBER, updated_at: "2026-08-12T11:00:00Z" },
    { id: TASK_TWO, title: "Too recent", status: "review", approver_id: "other", updated_at: "2026-08-12T13:00:00Z" },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Resolved", status: "done", updated_at: "2026-08-01T00:00:00Z" }
  ];

  const stale = selectStaleReviews(tasks, MEMBER, now);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].entityId, TASK);
  assert.equal(stale[0].needsYou, true);
  assert.equal(stale[0].hoursUntouched, 25);
});

test("new changes lead, stale review is added once, and resolved state is suppressed", () => {
  const payload = { items: [change()], firstVisit: false, hasMore: false };
  const tasks = [
    { id: TASK, title: "Approve the sample", status: "review", approver_id: MEMBER, updated_at: "2026-08-10T10:00:00Z" },
    { id: TASK_TWO, title: "Other review", status: "review", approver_id: "other", updated_at: "2026-08-09T10:00:00Z" }
  ];
  const digest = composeHomeActivity(payload, tasks, MEMBER, Date.parse("2026-08-13T12:00:00Z"));

  assert.equal(digest.items.length, 2);
  assert.equal(digest.items[0].kind, "task_review");
  assert.equal(digest.items[0].entityId, TASK);
  assert.equal(digest.items[1].kind, "review_stale");
  assert.equal(digest.items[1].entityId, TASK_TWO);
});

test("Home says there is more when stale attention pushes a new event off screen", () => {
  const items = Array.from({ length: 5 }, (_, index) => {
    const digit = String(index + 1);
    const eventId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const entityId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-9${digit.repeat(3)}-${digit.repeat(12)}`;
    return change({ eventId, entityId, receiptEventIds: [eventId], needsYou: false });
  });
  const staleId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const tasks = [{
    id: staleId,
    title: "Review me",
    status: "review",
    approver_id: MEMBER,
    updated_at: "2026-08-10T10:00:00Z"
  }];

  const digest = composeHomeActivity(
    { items, firstVisit: false, hasMore: false },
    tasks,
    MEMBER,
    Date.parse("2026-08-13T12:00:00Z"),
    5
  );
  assert.equal(digest.items.length, 5);
  assert.equal(digest.hasMore, true);
  assert.equal(digest.items.some((item) => item.kind === "review_stale"), true);
});
