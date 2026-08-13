/* Codex — 2026-08-11: authenticated Work data boundary. RLS remains the authority. */

const TASK_COLUMNS = [
  "id", "workspace_id", "workstream_id", "title", "status", "priority",
  "owner_id", "approver_id", "due_on", "next_action", "completion_condition",
  "blocker_note", "flags", "source_url", "latest_file_url", "position",
  "completed_at", "created_at", "updated_at", "archived_at"
].join(",");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HubRepositoryError extends Error {
  constructor(message, cause, operation) {
    super(message);
    this.name = "HubRepositoryError";
    this.operation = operation;
    this.code = cause?.code || "";
    this.details = cause?.details || "";
    this.hint = cause?.hint || "";
    this.serverMessage = cause?.message || "";
  }
}

function assertResponse(response, operation) {
  if (response.error) throw new HubRepositoryError(`Hub ${operation} failed.`, response.error, operation);
  return response.data;
}

function editableTaskPayload(values) {
  return {
    workstream_id: values.workstreamId || null,
    title: values.title,
    status: values.status,
    priority: values.priority,
    owner_id: values.ownerId || null,
    approver_id: values.approverId || null,
    due_on: values.dueOn || null,
    next_action: values.nextAction,
    completion_condition: values.completion,
    blocker_note: values.blocker,
    flags: values.flags,
    source_url: values.sourceUrl,
    latest_file_url: values.latestFileUrl
  };
}

function newTaskPayload(workspaceId, values) {
  return {
    workspace_id: workspaceId,
    kind: "task",
    ...editableTaskPayload(values),
    position: Number.isInteger(values.position) ? values.position : 0
  };
}

export function createConnectedWorkRepository(client, workspaceId) {
  async function verifyMembership(userId) {
    const response = await client
      .from("members")
      .select("workspace_id,user_id,display_name,role,archived_at")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .is("archived_at", null)
      .maybeSingle();
    return assertResponse(response, "membership check");
  }

  async function loadWorkspace(userId) {
    const membership = await verifyMembership(userId);
    if (!membership) return null;

    const [workspaceResponse, membersResponse, workstreamsResponse, tasksResponse] = await Promise.all([
      client.from("workspaces").select("id,name,slug").eq("id", workspaceId).maybeSingle(),
      client.from("members").select("user_id,display_name,role,archived_at").eq("workspace_id", workspaceId).order("display_name"),
      client.from("workstreams").select("id,name,slug,status,position,archived_at").eq("workspace_id", workspaceId).order("position"),
      client.from("tasks").select(TASK_COLUMNS).eq("workspace_id", workspaceId).is("archived_at", null).order("position").order("created_at")
    ]);

    const currentMembership = await verifyMembership(userId);
    if (!currentMembership) return null;

    return {
      membership: currentMembership,
      workspace: assertResponse(workspaceResponse, "workspace load"),
      members: assertResponse(membersResponse, "member load") || [],
      workstreams: assertResponse(workstreamsResponse, "workstream load") || [],
      tasks: assertResponse(tasksResponse, "task load") || []
    };
  }

  async function createTask(values) {
    const response = await client.from("tasks").insert(newTaskPayload(workspaceId, values)).select(TASK_COLUMNS).single();
    return assertResponse(response, "task create");
  }

  async function updateTask(id, originalUpdatedAt, values) {
    const response = await client
      .from("tasks")
      .update(editableTaskPayload(values))
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .eq("updated_at", originalUpdatedAt)
      .is("archived_at", null)
      .select(TASK_COLUMNS)
      .maybeSingle();
    return assertResponse(response, "task update");
  }

  async function archiveTask(id, originalUpdatedAt) {
    const response = await client
      .from("tasks")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .eq("updated_at", originalUpdatedAt)
      .is("archived_at", null)
      .select("id")
      .maybeSingle();
    return assertResponse(response, "task archive");
  }

  /* Codex — 2026-08-13: Home receives only the sanitized RPC result. Raw
     activity_events.event_data never crosses the repository boundary. */
  async function loadHomeChanges(expectedUserId, limit = 5) {
    const response = await client.rpc("get_home_changes", {
      p_workspace_id: workspaceId,
      p_expected_user_id: expectedUserId,
      p_limit: Math.max(1, Math.min(Number(limit) || 5, 10))
    });
    return assertResponse(response, "Home changes load");
  }

  async function acknowledgeHomeChanges(expectedUserId, eventIds = []) {
    const uniqueIds = [...new Set(Array.isArray(eventIds) ? eventIds.map(String).filter((id) => UUID_PATTERN.test(id)) : [])].slice(0, 500);
    const response = await client.rpc("ack_home_changes", {
      p_workspace_id: workspaceId,
      p_expected_user_id: expectedUserId,
      p_event_ids: uniqueIds
    });
    return assertResponse(response, "Home changes acknowledgement");
  }

  return {
    verifyMembership,
    loadWorkspace,
    createTask,
    updateTask,
    archiveTask,
    loadHomeChanges,
    acknowledgeHomeChanges
  };
}
