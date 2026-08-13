/* Codex — 2026-08-13: pure Home change-feed policy.
 *
 * The database RPC already removes raw audit snapshots. This second boundary
 * accepts only the small public contract the interface understands, then adds
 * persistent review attention from the currently loaded Work board.
 */

export const HOME_CHANGE_KINDS = Object.freeze([
  "task_waiting",
  "task_review",
  "decision_recorded",
  "decision_agreed"
]);

const HOME_CHANGE_KIND_SET = new Set(HOME_CHANGE_KINDS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECEIPT_IDS = 500;

function safeText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function safeDate(value) {
  const text = safeText(value, 64);
  return text && !Number.isNaN(Date.parse(text)) ? text : "";
}

export function normalizeHomeChanges(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const seen = new Set();
  const items = [];
  let remainingReceiptCapacity = MAX_RECEIPT_IDS;
  let receiptsTruncated = false;

  for (const raw of Array.isArray(source.items) ? source.items : []) {
    const kind = safeText(raw?.kind, 40);
    const eventId = safeText(raw?.eventId, 50);
    const entityId = safeText(raw?.entityId, 50);
    const title = safeText(raw?.title, 240);
    const occurredAt = safeDate(raw?.occurredAt);
    if (
      !HOME_CHANGE_KIND_SET.has(kind)
      || !UUID.test(eventId)
      || !UUID.test(entityId)
      || !title
      || !occurredAt
    ) continue;

    const key = `${kind.startsWith("task_") ? "task" : "decision"}:${entityId}`;
    if (seen.has(key)) continue;

    const receiptIds = [];
    const receiptSeen = new Set();
    const rawReceiptIds = Array.isArray(raw?.receiptEventIds) ? raw.receiptEventIds : [];
    for (const value of rawReceiptIds.slice(0, MAX_RECEIPT_IDS + 1)) {
      const id = safeText(value, 50);
      if (!UUID.test(id) || receiptSeen.has(id)) continue;
      receiptSeen.add(id);
      if (remainingReceiptCapacity > 0) {
        receiptIds.push(id);
        remainingReceiptCapacity -= 1;
      } else {
        receiptsTruncated = true;
      }
    }
    if (rawReceiptIds.length > MAX_RECEIPT_IDS + 1) receiptsTruncated = true;
    if (!receiptIds.length) continue;
    seen.add(key);
    items.push(Object.freeze({
      eventId,
      kind,
      entityId,
      title,
      actorName: safeText(raw?.actorName, 80) || "Someone on the team",
      occurredAt,
      needsYou: raw?.needsYou === true,
      receiptEventIds: Object.freeze(receiptIds)
    }));
    if (items.length === 10) break;
  }

  return Object.freeze({
    firstVisit: source.firstVisit === true,
    lastOpenedAt: safeDate(source.lastOpenedAt),
    hasMore: source.hasMore === true || receiptsTruncated,
    items: Object.freeze(items)
  });
}

export function selectStaleReviews(tasks, memberId, now = Date.now(), limit = 2) {
  const threshold = Number(now) - (24 * 60 * 60 * 1000);
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => {
      if (!task || task.status !== "review" || task.archived_at) return false;
      const updated = Date.parse(task.updated_at || "");
      return Number.isFinite(updated) && updated <= threshold;
    })
    .map((task) => {
      const updated = Date.parse(task.updated_at);
      return Object.freeze({
        eventId: "",
        kind: "review_stale",
        entityId: safeText(task.id, 50),
        title: safeText(task.title, 240) || "Untitled work",
        actorName: "",
        occurredAt: task.updated_at,
        needsYou: Boolean(memberId && task.approver_id === memberId),
        hoursUntouched: Math.max(24, Math.floor((Number(now) - updated) / (60 * 60 * 1000))),
        receiptEventIds: Object.freeze([])
      });
    })
    .filter((item) => UUID.test(item.entityId))
    .sort((left, right) => {
      if (left.needsYou !== right.needsYou) return left.needsYou ? -1 : 1;
      return Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    })
    .slice(0, Math.max(0, Math.min(Number(limit) || 0, 5)));
}

export function composeHomeActivity(payload, tasks, memberId, now = Date.now(), limit = 5) {
  const normalized = normalizeHomeChanges(payload);
  const changedEntities = new Set(normalized.items.map((item) => item.entityId));
  const stale = selectStaleReviews(tasks, memberId, now, 2)
    .filter((item) => !changedEntities.has(item.entityId));
  const max = Math.max(1, Math.min(Number(limit) || 5, 10));

  const items = [...normalized.items, ...stale]
    .sort((left, right) => {
      const leftRank = left.needsYou ? (left.kind === "review_stale" ? 1 : 0) : (left.kind === "review_stale" ? 3 : 2);
      const rightRank = right.needsYou ? (right.kind === "review_stale" ? 1 : 0) : (right.kind === "review_stale" ? 3 : 2);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    })
    .slice(0, max);

  const renderedEventCount = items.filter((item) => item.eventId).length;
  return Object.freeze({
    ...normalized,
    hasMore: normalized.hasMore || renderedEventCount < normalized.items.length,
    items: Object.freeze(items)
  });
}
