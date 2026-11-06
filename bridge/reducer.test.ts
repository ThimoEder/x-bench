import assert from "node:assert/strict";
import test from "node:test";
import { grokEventFromNotification as eventFromNotification } from "./grok/protocol.ts";
import { grokFacts } from "./grok/tools.ts";
import {
  cleanSuggestion,
  emptySession,
  reduce,
  type ReducerEvent,
  type SessionState,
  type TextItem,
  type ToolItem,
  type UserItem,
} from "./reducer.ts";

// The event a notification becomes. Fails the test when the notification is dropped.
function translate(message: unknown): ReducerEvent {
  const translated = eventFromNotification(message);
  assert.ok(translated && translated.event.type !== "catalog", "the notification was dropped");
  return translated.event;
}

function textAt(session: SessionState, index: number): TextItem {
  const item = session.transcript.at(index);
  assert.ok(item && item.type !== "tool", `no text item at ${index}`);
  return item;
}

function userAt(session: SessionState, index: number): UserItem {
  const item = session.transcript.at(index);
  assert.ok(item?.type === "user", `no user item at ${index}`);
  return item;
}

function toolAt(session: SessionState, index: number): ToolItem {
  const item = session.transcript.at(index);
  assert.ok(item?.type === "tool", `no tool item at ${index}`);
  return item;
}

test("token chunks merge until a tool call starts a new block", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  const before = session;
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, { type: "user", text: "hi" });
  session = reduce(session, { type: "chunk", role: "thought", text: "The" });
  session = reduce(session, { type: "chunk", role: "thought", text: " user" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "po" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "ng" });
  session = reduce(session, { type: "tool", toolCallId: "call-1", title: "write", rawInput: { file_path: "a.txt" } });
  session = reduce(session, { type: "chunk", role: "thought", text: "done" });
  session = reduce(session, { type: "turn-finished", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, modelCalls: null } });

  assert.equal(before.transcript.length, 0);
  assert.equal(session.status, "idle");
  assert.equal(session.stopReason, "end_turn");
  assert.equal(session.usage?.inputTokens, 3);
  const thoughts = session.transcript.filter((item) => item.type === "thought");
  assert.deepEqual(thoughts.map((item) => item.text), ["The user", "done"]);
  assert.equal(session.transcript.find((item) => item.type === "assistant")?.text, "pong");
  assert.equal(
    session.transcript.filter((item) => item.type !== "tool").every((item) => item.streaming === false),
    true,
  );
  const tool = session.transcript.find((item) => item.type === "tool");
  assert.equal(tool?.status, "in_progress");
  assert.deepEqual(tool?.rawInput, { file_path: "a.txt" });
});

test("settle closes a replayed stream and leaves a live turn alone", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "done" });
  assert.equal(textAt(session, -1).streaming, true);
  session = reduce(session, { type: "settle" });
  assert.equal(session.status, "idle");
  assert.equal(textAt(session, -1).streaming, false);
  assert.equal(textAt(session, -1).text, "done");
  const live = reduce({ ...session, status: "running", transcript: [{ ...textAt(session, 0), streaming: true }] }, { type: "settle" });
  assert.equal(live.status, "running");
  assert.equal(textAt(live, 0).streaming, true);
});

test("a later tool update fills the diff and completion without dropping the input", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "tool", toolCallId: "call-1", title: "write", rawInput: { content: "hello" } });
  session = reduce(session, {
    type: "tool",
    toolCallId: "call-1",
    title: "Write a.txt",
    status: "completed",
    diffs: [{ path: "a.txt", oldText: "", newText: "hello" }],
    rawOutput: { type: "SearchReplace" },
  });
  const tool = toolAt(session, 0);
  assert.equal(tool.title, "Write a.txt");
  assert.equal(tool.status, "completed");
  assert.deepEqual(tool.rawInput, { content: "hello" });
  assert.equal(tool.diffs[0]?.newText, "hello");
});

test("permission stays beside the transcript until the matching tool resolves", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, {
    type: "permission",
    rpcId: 7,
    toolCallId: "call-1",
    title: "Write a.txt",
    kind: "edit",
    rawInput: { file_path: "a.txt" },
    options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
  });
  assert.equal(session.pendingPermission?.rpcId, 7);
  session = reduce(session, { type: "permission-resolved", toolCallId: "other" });
  assert.equal(session.pendingPermission?.toolCallId, "call-1");
  session = reduce(session, { type: "permission-resolved", toolCallId: "call-1" });
  assert.equal(session.pendingPermission, null);
});

test("a plan approval waits on the session until it is cleared", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "plan-approval", rpcId: 4, toolCallId: "call-1", plan: "# Hello" });
  assert.equal(session.pendingPlan?.plan, "# Hello");
  assert.equal(session.pendingPlan?.rpcId, 4);
  session = reduce(session, { type: "plan-cleared" });
  assert.equal(session.pendingPlan, null);
});

test("a folder change keeps the transcript", () => {
  let session = emptySession({ id: "s", cwd: "/repo" });
  session = reduce(session, { type: "user", text: "hi" });
  const revision = session.revision;
  const same = reduce(session, { type: "cwd", cwd: "/repo" });
  assert.equal(same, session);
  session = reduce(session, { type: "cwd", cwd: "/repo/.grok/worktrees/topic" });
  assert.equal(session.cwd, "/repo/.grok/worktrees/topic");
  assert.equal(textAt(session, 0).text, "hi");
  assert.equal(session.revision, revision + 1);
  assert.equal(reduce(session, { type: "cwd", cwd: "" }), session);
});

test("reset clears the transcript and keeps the session id", () => {
  let session = emptySession({ id: "s", cwd: "/work", configOptions: [{ id: "model", currentValue: "grok-4.7" }] });
  session = reduce(session, { type: "user", text: "hi" });
  session = reduce(session, { type: "reset", cwd: "/work" });
  assert.equal(session.id, "s");
  assert.equal(session.transcript.length, 0);
  assert.equal(session.modelId, "grok-4.7");
});

test("a queue keeps follow-ups and starts the next one as its own message", () => {
  const translated = translate({
    method: "_x.ai/queue/changed",
    params: {
      sessionId: "s",
      entries: [{ id: "q2", version: 1, text: "next", position: 0 }],
      runningPromptId: "p1",
      runningText: "first",
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, { type: "user", text: "first" });
  session = reduce(session, translated);
  assert.equal(session.status, "running");
  assert.equal(session.queue[0]?.text, "next");
  assert.equal(session.transcript.filter((item) => item.type === "user").length, 1);

  const started = translate({
    method: "_x.ai/queue/changed",
    params: { sessionId: "s", entries: [], runningPromptId: "q2", runningText: "next" },
  });
  session = reduce(session, started);
  assert.deepEqual(
    session.transcript.filter((item) => item.type === "user").map((item) => item.text),
    ["first", "next"],
  );
});

test("a steered message waits until the agent reads it, and is unread if the turn ends first", () => {
  let session = reduce(emptySession({ id: "s1", cwd: "/tmp" }), { type: "begin-turn" });
  session = reduce(session, { type: "user", text: "go" });
  session = reduce(session, { type: "user", text: "then left", deliveryId: "d1" });
  session = reduce(session, { type: "user", text: "then right", deliveryId: "d2" });
  assert.equal(userAt(session, 0).delivery, undefined);
  assert.deepEqual(userAt(session, 1).delivery, { id: "d1", state: "waiting" });

  session = reduce(session, { type: "delivery", id: "d1", state: "read" });
  assert.equal(userAt(session, 1).delivery?.state, "read");
  // A frame for a message the transcript does not hold (the turn's own prompt) changes nothing.
  assert.equal(reduce(session, { type: "delivery", id: "other", state: "read" }), session);

  session = reduce(session, { type: "turn-finished", stopReason: "end_turn" });
  assert.equal(userAt(session, 1).delivery?.state, "read");
  assert.equal(userAt(session, 2).delivery?.state, "unread");
  // Claude can still read it after the turn ended.
  session = reduce(session, { type: "delivery", id: "d2", state: "read" });
  assert.equal(userAt(session, 2).delivery?.state, "read");

  // Dropped by Claude Code: unread. A drop never overrides a read.
  session = reduce(session, { type: "user", text: "then up", deliveryId: "d4" });
  session = reduce(session, { type: "delivery", id: "d4", state: "unread" });
  assert.equal(userAt(session, 3).delivery?.state, "unread");
  assert.equal(reduce(session, { type: "delivery", id: "d2", state: "unread" }), session);

  session = reduce(session, { type: "delivery-resent", id: "d2", newId: "d3" });
  assert.deepEqual(userAt(session, 2).delivery, { id: "d3", state: "waiting" });

  session = reduce(session, { type: "delivery-removed", id: "d1" });
  assert.deepEqual(session.transcript.map((item) => item.text), ["go", "then right", "then up"]);
});

test("a mode update records the session approval mode", () => {
  const translated = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  assert.equal(session.modeId, "full");
  session = reduce(session, translated);
  assert.equal(session.modeId, "plan");
});

test("an echoed user chunk does not duplicate the local prompt", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, {
    type: "user",
    text: "hi",
    attachments: [{ name: "image.png", kind: "image", mimeType: "image/png", preview: "data:image/png;base64,a" }],
  });
  session = reduce(session, { type: "chunk", role: "user", text: "hi" });
  assert.equal(session.transcript.length, 1);
  assert.equal(userAt(session, 0).attachments?.[0]?.name, "image.png");
  assert.equal(userAt(session, 0).attachments?.[0]?.preview, "data:image/png;base64,a");
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function userPicture(promptIndex: number, data = png) {
  return translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", mimeType: "image/png", data },
        _meta: { promptIndex },
      },
    },
  });
}

test("a picture with no caption is its own user message", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "user", text: "earlier" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "ok" });
  session = reduce(session, userPicture(3));
  const mine = session.transcript.filter((item) => item.type === "user");
  assert.equal(mine.length, 2);
  assert.equal(mine[1]?.text, "");
  assert.equal(mine[1]?.images?.[0]?.data, png);
  assert.equal(mine[1]?.images?.[0]?.mimeType, "image/png");
});

test("a caption and its picture stay one user message", () => {
  const text = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "look" },
        _meta: { promptIndex: 1 },
      },
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, text);
  session = reduce(session, userPicture(1));
  assert.equal(session.transcript.length, 1);
  assert.equal(session.transcript[0]?.type, "user");
  assert.equal(userAt(session, 0).text, "look");
  assert.equal(userAt(session, 0).images?.length, 1);
});

test("a picture omitted on replay can be restored onto that prompt", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "chunk", role: "user", text: "", promptIndex: 10 });
  assert.equal(userAt(session, 0).images, undefined);
  session = reduce(session, { type: "user-images", promptIndex: 10, images: [{ mimeType: "image/png", data: png }] });
  assert.equal(session.transcript.length, 1);
  assert.equal(userAt(session, 0).images?.[0]?.data, png);
});

test("an echoed picture stays on the local prompt instead of a second bubble", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, {
    type: "user",
    text: "",
    attachments: [{ name: "Pasted image.png", kind: "image", mimeType: "image/png", preview: "data:image/png;base64,a" }],
  });
  session = reduce(session, userPicture(4));
  assert.equal(session.transcript.length, 1);
  assert.equal(userAt(session, 0).text, "");
  assert.equal(userAt(session, 0).images?.[0]?.data, png);
  assert.equal(userAt(session, 0).attachments?.[0]?.name, "Pasted image.png");
  assert.equal(userAt(session, 0).promptIndex, 4);
});

test("a replayed turn_completed closes the streaming text", () => {
  const translated = translate({
    method: "_x.ai/session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "pong" });
  session = reduce(session, translated);
  assert.equal(session.status, "idle");
  assert.equal(session.stopReason, "end_turn");
  assert.equal(textAt(session, 0).streaming, false);
});

test("the working line names the phase and keeps its timer", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "begin-turn" });
  assert.equal(session.activity?.label, "Waiting for response");
  const waiting = session.activity?.since;

  session = reduce(session, { type: "chunk", role: "thought", text: "Hmm", at: 1_700_000_000_000 });
  assert.equal(session.activity?.label, "Thinking...");
  assert.equal(session.activity?.since, 1_700_000_000_000);
  session = reduce(session, { type: "chunk", role: "thought", text: " more", at: 1_700_000_005_000 });
  assert.equal(session.activity?.label, "Thinking...");
  assert.equal(session.activity?.since, 1_700_000_000_000);

  session = reduce(session, {
    type: "tool",
    toolCallId: "read-1",
    kind: "read",
    title: "read_file",
    status: "in_progress",
    at: 1_700_000_010_000,
  });
  assert.equal(session.activity?.label, "Reading");
  assert.equal(session.activity?.since, 1_700_000_010_000);
  session = reduce(session, { type: "tool", toolCallId: "read-1", kind: "read", status: "in_progress" });
  assert.equal(session.activity?.label, "Reading");
  assert.equal(session.activity?.since, 1_700_000_010_000);

  session = reduce(session, { type: "tool", toolCallId: "read-1", status: "completed", at: 1_700_000_012_000 });
  assert.equal(session.activity?.label, "Waiting for response");
  assert.equal(session.activity?.since, 1_700_000_012_000);
  assert.notEqual(session.activity?.since, waiting);

  // The provider's classifier names a subagent: standard ACP has no kind for one.
  session = reduce(
    session,
    { type: "tool", toolCallId: "sub-1", kind: "think", rawInput: { description: "Look around" }, status: "in_progress", at: 1_700_000_020_000 },
    () => ({ role: "subagent" }),
  );
  assert.equal(session.activity?.label, "Waiting on subagent");

  session = reduce(session, { type: "tool", toolCallId: "sub-1", status: "completed", at: 1_700_000_021_000 });
  session = reduce(session, { type: "retry", active: true, attempt: 2, max: 15, at: 1_700_000_030_000 });
  assert.equal(session.activity?.label, "Retrying (2/15)");
  assert.equal(session.activity?.since, 1_700_000_030_000);

  session = reduce(session, { type: "chunk", role: "assistant", text: "Done", at: 1_700_000_040_000 });
  assert.equal(session.activity?.label, "Responding");
  assert.equal(session.retry, null);

  session = reduce(session, { type: "turn-finished", stopReason: "end_turn" });
  assert.equal(session.activity, null);
});

test("a tool's facts are read from the whole call so far, and a permission's from its row", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "tool", toolCallId: "run-1", name: "run_terminal_command", kind: "execute", title: "run_terminal_command", status: "pending" }, grokFacts);
  session = reduce(session, { type: "tool", toolCallId: "run-1", title: "Execute `ls`", rawInput: { command: "ls", description: "List", variant: "Bash" } }, grokFacts);
  const tool = session.transcript[0];
  assert.deepEqual(tool?.type === "tool" ? tool.facts : null, { role: "shell", command: "ls", label: "List" });
  session = reduce(session, { type: "permission", rpcId: 1, toolCallId: "run-1", title: "", kind: "", options: [] }, grokFacts);
  assert.deepEqual(session.pendingPermission?.facts, { role: "shell", command: "ls", label: "List" });
});

test("a new turn resets the wait instead of keeping the session age", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, {
    type: "tool",
    toolCallId: "old",
    name: "read_file",
    status: "in_progress",
    at: 1_700_000_000_000,
  });
  session = reduce(session, { type: "tool", toolCallId: "old", status: "completed", at: 1_700_000_010_000 });
  session = reduce(session, { type: "turn-finished", stopReason: "end_turn" });
  const started = Date.now();
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, { type: "user", text: "again" });
  assert.equal(session.activity?.label, "Waiting for response");
  const since = session.activity?.since ?? 0;
  assert.ok(since >= started && since <= Date.now());
  const waiting = session.activity?.since;
  session = reduce(session, { type: "user", text: "again" });
  assert.equal(session.activity?.since, waiting);

  session = reduce(session, {
    type: "tool",
    toolCallId: "read-2",
    name: "read_file",
    status: "in_progress",
    at: 1_700_000_050_000,
  });
  session = reduce(session, { type: "tool", toolCallId: "read-2", status: "completed", at: 1_700_000_052_000 });
  assert.equal(session.activity?.label, "Waiting for response");
  assert.equal(session.activity?.since, 1_700_000_052_000);
});

test("a background task snapshot stays on an idle session and drops the log path", () => {
  const translated = translate({
    method: "_x.ai/session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "background_tasks",
        tasks: [
          {
            task_id: "task-1",
            kind: "bash",
            status: "running",
            description: "Start the UI server on port 8787",
            command: "npm run dev",
            output_file: "/secret/dev.log",
          },
          {
            task_id: "task-2",
            kind: "monitor",
            status: "running",
            display_command: "[monitor] Watch the UI",
          },
        ],
      },
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, translated);
  assert.equal(session.status, "idle");
  assert.equal(session.activity, null);
  assert.deepEqual(session.backgroundTasks, [
    { id: "task-1", kind: "bash", status: "running", label: "Start the UI server on port 8787" },
    { id: "task-2", kind: "monitor", status: "running", label: "[monitor] Watch the UI" },
  ]);
  assert.equal(JSON.stringify(session).includes("/secret/dev.log"), false);
  assert.equal(JSON.stringify(session).includes("npm run dev"), false);

  const cleared = translate({
    method: "_x.ai/session/update",
    params: { sessionId: "s", update: { sessionUpdate: "background_tasks", tasks: [] } },
  });
  session = reduce(session, cleared);
  assert.deepEqual(session.backgroundTasks, []);
});

test("the live context count follows update metadata and ignores billed usage", () => {
  const translated = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
      _meta: { totalTokens: 119796 },
    },
  });
  assert.equal(translated.contextUsed, 119796);
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, translated);
  assert.equal(session.contextUsed, 119796);
  session = reduce(session, { type: "turn-finished", stopReason: "end_turn", usage: { inputTokens: 3000000, outputTokens: 10, totalTokens: 3000010, modelCalls: null } });
  assert.equal(session.contextUsed, 119796);
  assert.equal(session.usage?.inputTokens, 3000000);
  session = reduce(session, { type: "chunk", role: "assistant", text: "more", contextUsed: 120100 });
  assert.equal(session.contextUsed, 120100);
  session = reduce(session, { type: "reset", cwd: "/tmp" });
  assert.equal(session.contextUsed, null);
});

test("a retry update keeps the agent clock and a permission pauses the line", () => {
  const translated = translate({
    timestamp: 1700000030,
    method: "_x.ai/session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15 },
      _meta: { agentTimestampMs: 1_700_000_030_500 },
    },
  });
  assert.equal(translated.at, 1_700_000_030_500);
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, translated);
  assert.equal(session.activity?.label, "Retrying (1/15)");
  assert.equal(session.activity?.since, 1_700_000_030_500);

  session = reduce(session, {
    type: "permission",
    rpcId: 1,
    toolCallId: "c",
    title: "Write",
    kind: "edit",
    options: [],
  });
  assert.equal(session.activity?.label, "Waiting for approval");
});

test("retries Grok gave up on end the turn with their reason, and the next turn clears it", () => {
  const update = (fields: Record<string, unknown>) => translate({ method: "_x.ai/session/update", params: { sessionId: "s", update: fields } });
  let session = reduce(emptySession({ id: "s", cwd: "/tmp" }), { type: "begin-turn" });
  session = reduce(session, update({ sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15, reason: "429 Too Many Requests" }));
  assert.equal(session.error, null);
  session = reduce(session, update({ sessionUpdate: "retry_state", type: "exhausted", attempts: 0, reason: "API error (status 429 Too Many Requests)", is_rate_limited: true }));
  assert.equal(session.retry, null);
  session = reduce(session, update({ sessionUpdate: "turn_completed", stop_reason: "rate_limit" }));
  assert.deepEqual([session.status, session.stopReason, session.error], ["idle", "rate_limit", "API error (status 429 Too Many Requests)"]);
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, { type: "turn-finished", stopReason: "end_turn" });
  assert.equal(session.error, null);
});

test("replayed tool calls become a diff item", () => {
  const translated = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Write a.txt",
        kind: "edit",
        status: "completed",
        rawInput: { file_path: "a.txt", content: "hello" },
        content: [{ type: "diff", path: "a.txt", oldText: "", newText: "hello" }],
      },
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, translated);
  const tool = toolAt(session, 0);
  assert.equal(tool.status, "completed");
  assert.equal(tool.diffs[0]?.newText, "hello");
});

test("a tool image stays on the row and is not cleared by a later status update", () => {
  const withImage = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-shot",
        status: "completed",
        kind: "read",
        title: "Read shot.png",
        content: [{ type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
        rawOutput: { type: "ReadFile", ImageContent: { data: png, mimeType: "image/png" } },
      },
    },
  });
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, withImage);
  assert.equal(toolAt(session, 0).images?.length, 1);
  assert.equal(toolAt(session, 0).images?.[0]?.mimeType, "image/png");
  assert.equal(toolAt(session, 0).images?.[0]?.data, png);

  const statusOnly = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId: "call-shot", status: "completed" },
    },
  });
  session = reduce(session, statusOnly);
  assert.equal(toolAt(session, 0).images?.[0]?.data, png);
});

test("a hidden task wake-up is stored without looking like a typed prompt", () => {
  const text = `<system-reminder>\nBackground task "call-1" completed (exit code: 0).\nDescription: Sleep for 30 seconds as requested | Duration: 30.3s\n</system-reminder>`;
  const translated = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
        _meta: { hideFromScrollback: true },
      },
    },
  });
  assert.equal(translated.type === "chunk" && translated.hidden, true);
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "user", text: "run sleep" });
  session = reduce(session, translated);
  const notes = session.transcript.filter((item) => item.type === "user");
  assert.deepEqual(notes.map((item) => item.hidden || false), [false, true]);
  assert.equal(notes[1]?.text, text);

  const plain = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } },
    },
  });
  assert.equal(plain.type === "chunk" ? plain.hidden : "not a chunk", undefined);
});

test("a suggestion stays until the next turn, and NONE is dropped", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "user", text: "hi" });
  session = reduce(session, { type: "suggestion", text: "next" });
  assert.equal(session.suggestion, "next");
  session = reduce(session, { type: "begin-turn" });
  assert.equal(session.suggestion, null);
  assert.equal(cleanSuggestion("NONE"), null);
  assert.equal(cleanSuggestion("  "), null);
});

test("a notice during a streaming reply is a line of its own, and the reply goes on after it", () => {
  let session = emptySession({ id: "s", cwd: "/tmp" });
  session = reduce(session, { type: "begin-turn" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "The build " });
  session = reduce(session, { type: "notice", text: "**Task stopped by user**" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "passed." });
  assert.deepEqual(
    session.transcript.map((item) => (item.type === "tool" ? "" : item.text)),
    ["The build ", "**Task stopped by user**", "passed."],
  );
  assert.equal(session.status, "running");
});

test("a written plan is one reply rewritten as it grows, and the session's plan document", () => {
  const update = (content: string) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "item-7", content } } } });
  let session = reduce(emptySession({ id: "s", cwd: "/w" }), { type: "begin-turn" });
  session = reduce(session, { type: "chunk", role: "thought", text: "**Planning**" });
  session = reduce(session, translate(update("1. Read")));
  session = reduce(session, translate(update("1. Read the notes\n2. Write the file")));
  const replies = session.transcript.filter((item) => item.type === "assistant");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.text, "1. Read the notes\n2. Write the file");
  // The thought before the plan has ended, and the plan does not take in the next reply.
  assert.equal(session.transcript.find((item) => item.type === "thought")?.streaming, false);
  assert.deepEqual(session.planDoc, { id: "item-7", text: "1. Read the notes\n2. Write the file" });
  session = reduce(session, { type: "chunk", role: "assistant", text: "Shall I go on?" });
  assert.deepEqual(session.transcript.filter((item) => item.type === "assistant").map((item) => item.text), ["1. Read the notes\n2. Write the file", "Shall I go on?"]);
});

test("a new message id starts a new reply, and a plan update in between does not", () => {
  const say = (session: SessionState, text: string, messageId?: string) => reduce(session, { type: "chunk", role: "assistant", text, messageId });
  let session = say(emptySession({ id: "s", cwd: "/repo" }), "Starting step one.", "msg-1");
  session = reduce(session, { type: "plan", entries: [{ content: "Step one", status: "in_progress" }] });
  session = say(session, " Still step one.", "msg-1");
  session = say(session, "Step one is done.", "msg-2");
  session = say(session, " No id here.");
  assert.deepEqual(session.transcript.map((item) => (item as TextItem).text), ["Starting step one. Still step one.", "Step one is done. No id here."]);
});

test("a finished plan ends with its turn, and an unfinished one stays into the next", () => {
  const done = [{ content: "Step one", status: "completed" }];
  let session = reduce(emptySession({ id: "s", cwd: "/repo" }), { type: "plan", entries: done });
  session = reduce(session, { type: "begin-turn" });
  assert.equal(session.plan, null);
  const open = [{ content: "Step one", status: "in_progress" }];
  session = reduce(session, { type: "plan", entries: open });
  session = reduce(session, { type: "begin-turn" });
  assert.deepEqual(session.plan, open);
});
