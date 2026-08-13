import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../migrations/20260813_006_home_changes.sql", import.meta.url),
  "utf8"
);

test("Home feed tables are private and callable only through authenticated RPCs", () => {
  assert.match(sql, /alter table public\.home_feed_state enable row level security/i);
  assert.match(sql, /alter table public\.home_event_receipts enable row level security/i);
  assert.match(sql, /revoke all privileges on table[\s\S]*home_feed_state[\s\S]*home_event_receipts[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /security definer[\s\S]*set row_security = off/i);
  assert.match(sql, /auth\.role\(\) <> 'authenticated'/i);
  assert.match(sql, /v_user_id is distinct from p_expected_user_id/i);
  assert.match(sql, /app_private\.has_workspace_role\(p_workspace_id, 'viewer'\)/i);
  assert.match(sql, /grant execute on function public\.get_home_changes\(uuid, uuid, integer\) to authenticated/i);
  assert.match(sql, /grant execute on function public\.ack_home_changes\(uuid, uuid, uuid\[\]\) to authenticated/i);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete).*home_(?:feed_state|event_receipts).*authenticated/i);
});

test("Home feed returns allow-listed fields and acknowledges exact workspace events", () => {
  for (const field of ["eventId", "kind", "entityId", "title", "actorName", "occurredAt", "needsYou", "receiptEventIds"]) {
    assert.match(sql, new RegExp(`'${field}'`));
  }
  assert.doesNotMatch(sql, /'eventData'|'event_data'\s*,|'storagePath'|'sourceUrl'/i);
  assert.match(sql, /receipt\.user_id = v_user_id/i);
  assert.equal((sql.match(/v_user_id is distinct from p_expected_user_id/gi) || []).length, 2);
  assert.match(sql, /e\.workspace_id = p_workspace_id/i);
  assert.match(sql, /e\.id = requested\.event_id[\s\S]*e\.workspace_id = p_workspace_id/i);
  assert.match(sql, /array_agg\(event_id[\s\S]*as receipt_event_ids/i);
  assert.match(sql, /cardinality\(coalesce\(p_event_ids[\s\S]*> 500/i);
  assert.doesNotMatch(sql, /earlier\.occurred_at|anchors as/i);
  assert.match(sql, /last_opened_at = greatest/i);
  assert.match(sql, /on conflict \(workspace_id, user_id, event_id\) do nothing/i);
  assert.doesNotMatch(sql, /from public\.activity\b/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
});
