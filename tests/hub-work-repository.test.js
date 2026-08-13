import test from "node:test";
import assert from "node:assert/strict";

import { createConnectedWorkRepository, HubRepositoryError } from "../hub-work-repository.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeClient(responses = {}) {
  const calls = [];
  const take = (table) => {
    const response = responses[table];
    if (Array.isArray(response)) return response.shift();
    return response;
  };
  return {
    calls,
    from(table) {
      const call = { table, filters: [], orders: [] };
      calls.push(call);
      const builder = {
        select(columns) { call.select = columns; return builder; },
        insert(payload) { call.insert = payload; return builder; },
        update(payload) { call.update = payload; return builder; },
        eq(column, value) { call.filters.push(["eq", column, value]); return builder; },
        is(column, value) { call.filters.push(["is", column, value]); return builder; },
        order(column) { call.orders.push(column); return builder; },
        maybeSingle() { return Promise.resolve(take(table) || { data: null, error: null }); },
        single() { return Promise.resolve(take(table) || { data: { id: "saved" }, error: null }); },
        then(resolve, reject) { return Promise.resolve(take(table) || { data: [], error: null }).then(resolve, reject); }
      };
      return builder;
    }
  };
}

function values(overrides = {}) {
  return {
    title: "Test work",
    workstreamId: "",
    status: "backlog",
    priority: "normal",
    ownerId: "",
    approverId: "",
    dueOn: "",
    nextAction: "",
    completion: "",
    blocker: "",
    flags: [],
    sourceUrl: "",
    latestFileUrl: "",
    position: 0,
    ...overrides
  };
}

test("create scopes a normal task to the configured workspace", async () => {
  const client = fakeClient({ tasks: { data: { id: "new" }, error: null } });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  await repository.createTask(values());
  const call = client.calls[0];
  assert.equal(call.insert.workspace_id, WORKSPACE);
  assert.equal(call.insert.kind, "task");
  assert.equal(call.insert.workstream_id, null);
  assert.equal(call.insert.owner_id, null);
});

test("update uses workspace and timestamp as an optimistic concurrency gate", async () => {
  const client = fakeClient({ tasks: { data: { id: "task" }, error: null } });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  await repository.updateTask("task", "2026-08-12T10:00:00Z", values({ title: "My draft" }));
  const call = client.calls[0];
  assert.deepEqual(call.filters, [
    ["eq", "workspace_id", WORKSPACE],
    ["eq", "id", "task"],
    ["eq", "updated_at", "2026-08-12T10:00:00Z"],
    ["is", "archived_at", null]
  ]);
  assert.equal(call.update.title, "My draft");
  assert.equal("workspace_id" in call.update, false);
});

test("zero-row updates and archives surface as optimistic conflicts", async () => {
  const client = fakeClient({
    tasks: [
      { data: null, error: null },
      { data: null, error: null }
    ]
  });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  assert.equal(await repository.updateTask("task", "stale", values()), null);
  assert.equal(await repository.archiveTask("task", "stale"), null);
});

test("archive is soft, scoped, and concurrency checked", async () => {
  const client = fakeClient({ tasks: { data: { id: "task" }, error: null } });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  await repository.archiveTask("task", "2026-08-12T10:00:00Z");
  const call = client.calls[0];
  assert.match(call.update.archived_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(call.filters.slice(0, 3), [
    ["eq", "workspace_id", WORKSPACE],
    ["eq", "id", "task"],
    ["eq", "updated_at", "2026-08-12T10:00:00Z"]
  ]);
});

test("database error metadata survives the repository boundary", async () => {
  const client = fakeClient({
    tasks: { data: null, error: { code: "23514", message: "tasks_waiting_has_reason", details: "row", hint: "fix" } }
  });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  await assert.rejects(repository.createTask(values()), (error) => {
    assert.ok(error instanceof HubRepositoryError);
    assert.equal(error.operation, "task create");
    assert.equal(error.code, "23514");
    assert.equal(error.serverMessage, "tasks_waiting_has_reason");
    return true;
  });
});

test("workspace load scopes every collection and rechecks membership", async () => {
  const membership = { workspace_id: WORKSPACE, user_id: "user", display_name: "Salman", role: "member", archived_at: null };
  const client = fakeClient({
    members: [
      { data: membership, error: null },
      { data: [membership], error: null },
      { data: membership, error: null }
    ],
    workspaces: { data: { id: WORKSPACE, name: "FAKESNIFF", slug: "fakesniff" }, error: null },
    workstreams: { data: [], error: null },
    tasks: { data: [], error: null }
  });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  const loaded = await repository.loadWorkspace("user");
  assert.equal(loaded.membership.user_id, "user");
  const tasksCall = client.calls.find((call) => call.table === "tasks");
  assert.deepEqual(tasksCall.filters, [["eq", "workspace_id", WORKSPACE], ["is", "archived_at", null]]);
  const workspaceCall = client.calls.find((call) => call.table === "workspaces");
  assert.deepEqual(workspaceCall.filters, [["eq", "id", WORKSPACE]]);
  const memberListCall = client.calls.find((call) => call.table === "members" && call.select === "user_id,display_name,role,archived_at");
  assert.deepEqual(memberListCall.filters, [["eq", "workspace_id", WORKSPACE]]);
  const workstreamCall = client.calls.find((call) => call.table === "workstreams");
  assert.deepEqual(workstreamCall.filters, [["eq", "workspace_id", WORKSPACE]]);
  const membershipChecks = client.calls.filter((call) => call.table === "members" && call.select.includes("workspace_id"));
  assert.equal(membershipChecks.length, 2);
  for (const call of membershipChecks) {
    assert.deepEqual(call.filters, [
      ["eq", "workspace_id", WORKSPACE], ["eq", "user_id", "user"], ["is", "archived_at", null]
    ]);
  }
});

test("workspace data is discarded if membership disappears during load", async () => {
  const membership = { workspace_id: WORKSPACE, user_id: "user", display_name: "Salman", role: "member", archived_at: null };
  const client = fakeClient({
    members: [
      { data: membership, error: null },
      { data: [membership], error: null },
      { data: null, error: null }
    ],
    workspaces: { data: { id: WORKSPACE }, error: null },
    workstreams: { data: [], error: null },
    tasks: { data: [{ id: "private" }], error: null }
  });
  const repository = createConnectedWorkRepository(client, WORKSPACE);
  assert.equal(await repository.loadWorkspace("user"), null);
});
