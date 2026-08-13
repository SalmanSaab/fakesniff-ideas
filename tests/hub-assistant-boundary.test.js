/* Codex — 2026-08-13: the assistant must inherit the caller's access boundary. */

import test from "node:test";
import assert from "node:assert/strict";

const WORKSPACE_ID = "6b9f4ba4-e480-4c08-b67e-4d389db3f9d1";
const env = new Map([
  ["GEMINI_API_KEY", "test-gemini-key"],
  ["SUPABASE_URL", "https://supabase.test"],
  ["SUPABASE_ANON_KEY", "test-anon-key"]
]);

let handler;
const previousDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno");
Object.defineProperty(globalThis, "Deno", {
  configurable: true,
  value: {
    env: { get: (name) => env.get(name) },
    serve: (candidate) => { handler = candidate; }
  }
});
const { SECTIONS, splitAction } = await import("../supabase/functions/assistant/index.ts");
if (previousDeno) Object.defineProperty(globalThis, "Deno", previousDeno);
else delete globalThis.Deno;

assert.equal(typeof handler, "function", "the Edge Function handler must be captured");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function assistantRequest(token, body = { message: "What needs attention?", section: "home" }) {
  const headers = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("https://edge.test/functions/v1/assistant", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function responseBody(response, expectedStatus) {
  assert.equal(response.status, expectedStatus);
  return await response.json();
}

function assertClosedBody(body) {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
  assert.doesNotMatch(
    JSON.stringify(body),
    /workspace|fakesniff|member|role|tasks?|decisions?|lookbook|ideas?|reply|action|model|who|image|detail|token/i
  );
}

test("missing, expired and nonmember sessions fail before workspace or model access", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("a missing token must not call downstream services");
  };
  let response = await handler(assistantRequest(undefined));
  assertClosedBody(await responseBody(response, 401));
  assert.deepEqual(calls, []);

  calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    return jsonResponse({ message: "expired" }, 401);
  };
  response = await handler(assistantRequest("expired-token"));
  assertClosedBody(await responseBody(response, 401));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/auth\/v1\/user$/);

  for (const requestBody of [
    { message: "Tell me everything", section: "home" },
    { mode: "image", prompt: "Make a campaign image" }
  ]) {
    calls = [];
    const downstreamHeaders = [];
    globalThis.fetch = async (...args) => {
      const url = String(args[0]);
      calls.push(url);
      downstreamHeaders.push(args[1]?.headers ?? {});
      if (url.endsWith("/auth/v1/user")) return jsonResponse({ id: "outsider-user" });
      if (url.includes("/rest/v1/members?")) return jsonResponse([]);
      throw new Error(`nonmember reached a forbidden downstream call: ${url}`);
    };

    response = await handler(assistantRequest("valid-outsider-token", requestBody));
    assertClosedBody(await responseBody(response, 403));
    assert.equal(calls.length, 2);
    assert.match(calls[1], new RegExp(`workspace_id=eq\\.${WORKSPACE_ID}`));
    assert.match(calls[1], /user_id=eq\.outsider-user/);
    assert.match(calls[1], /archived_at=is\.null/);
    assert.deepEqual(downstreamHeaders.map((headers) => headers.Authorization), [
      "Bearer valid-outsider-token",
      "Bearer valid-outsider-token"
    ]);
    assert.doesNotMatch(calls.join("\n"), /generativelanguage|\/rest\/v1\/(tasks|decisions|lookbook_items|ideas)/);
  }
});

test("an active member's context reads stay inside the fixed workspace", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (...args) => {
    const url = String(args[0]);
    calls.push({ url, options: args[1] ?? {} });
    if (url.endsWith("/auth/v1/user")) return jsonResponse({ id: "member-user" });
    if (url.includes("/rest/v1/members?")) {
      return jsonResponse([{
        workspace_id: WORKSPACE_ID,
        user_id: "member-user",
        display_name: "Marco",
        role: "owner",
        archived_at: null
      }]);
    }
    if (url.includes("/rest/v1/tasks?")) {
      return jsonResponse([{ title: "Approve sample", status: "doing", next_action: "Check print" }]);
    }
    if (/\/rest\/v1\/(decisions|lookbook_items|ideas)\?/.test(url)) return jsonResponse([]);
    if (url.includes("generativelanguage.googleapis.com")) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "Nothing urgent." }] } }] });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const body = await responseBody(await handler(assistantRequest("member-token")), 200);
  assert.equal(body.reply, "Nothing urgent.");
  assert.equal(body.who, "Marco");
  const supabaseCalls = calls.filter(({ url }) => url.startsWith("https://supabase.test/"));
  for (const { options } of supabaseCalls) {
    assert.equal(options.headers.Authorization, "Bearer member-token");
    assert.equal(options.headers.apikey, "test-anon-key");
  }
  const contextCalls = calls.filter(({ url }) => /\/rest\/v1\/(tasks|decisions|lookbook_items|ideas)\?/.test(url));
  assert.equal(contextCalls.length, 4);
  for (const { url } of contextCalls) assert.match(url, new RegExp(`workspace_id=eq\\.${WORKSPACE_ID}`));
  const taskCall = contextCalls.find(({ url }) => url.includes("/tasks?")).url;
  assert.match(taskCall, /select=title,status,next_action/);
  assert.doesNotMatch(taskCall, /title,state,next_action/);
});

test("navigate and compose actions are limited to the fixed Hub section list", () => {
  const allowed = ["home", "work", "idea-lab", "lookbook", "decisions"];
  assert.deepEqual([...SECTIONS], allowed);

  for (const actionName of ["navigate", "compose"]) {
    for (const section of allowed) {
      const parsed = splitAction(`Open it.\n${JSON.stringify({ action: actionName, section })}`);
      assert.equal(parsed.reply, "Open it.");
      assert.deepEqual(parsed.action, { action: actionName, section });
    }
    for (const section of ["admin", "settings", "tokens", "designs", "", null, {}, []]) {
      const parsed = splitAction(`No.\n${JSON.stringify({ action: actionName, section })}`);
      assert.equal(parsed.action, null, `${actionName} must reject ${JSON.stringify(section)}`);
    }
  }
});
