import assert from "node:assert/strict";
import test from "node:test";
import { ConfigOptionList, SessionResult, permissionFromRequest } from "./protocol.ts";
import { grokEventFromNotification as eventFromNotification } from "./grok/protocol.ts";
import type { ReducerEvent } from "./reducer.ts";

function translate(message: unknown): ReducerEvent {
  const translated = eventFromNotification(message);
  assert.ok(translated && translated.event.type !== "catalog", "the notification was dropped");
  return translated.event;
}

test("a message without a method is dropped", () => {
  assert.equal(eventFromNotification(null), null);
  assert.equal(eventFromNotification("session/update"), null);
  assert.equal(eventFromNotification({ params: { sessionId: "s" } }), null);
  assert.equal(eventFromNotification({ method: 7, params: {} }), null);
  assert.equal(eventFromNotification({ method: "", params: {} }), null);
});

test("an unknown method or update kind is dropped", () => {
  assert.equal(eventFromNotification({ method: "_x.ai/something_new", params: { sessionId: "s" } }), null);
  assert.equal(
    eventFromNotification({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "later" } } }),
    null,
  );
});

test("params that are not an object read as empty", () => {
  const event = translate({ method: "_x.ai/session/prompt_complete", params: "nope" });
  assert.deepEqual(event, { type: "turn-finished", stopReason: null });
});

test("unknown fields pass and a field with the wrong type reads as missing", () => {
  const event = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      somethingNew: { nested: true },
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: 42,
        kind: "read",
        extra: "ignored",
        _meta: { "x.ai/tool": { label: "Read a.txt", name: "read_file" } },
      },
    },
  });
  assert.equal(event.type, "tool");
  assert.equal(event.type === "tool" && event.title, "Read a.txt");
  assert.equal(event.type === "tool" && event.name, "read_file");
});

test("a null tool status stays explicit", () => {
  const event = translate({
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: null } },
  });
  assert.equal(event.type === "tool" && event.status, null);
});

test("a tool that sends its output only as text content keeps that text as its output", () => {
  const update = (extra: Record<string, unknown>) =>
    translate({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", ...extra } } });
  const content = [
    { type: "content", content: { type: "text", text: "Opened a page." } },
    { type: "content", content: { type: "image", data: "iVBORw0KGgoAAAANSUhEUg", mimeType: "image/png" } },
    { type: "content", content: { type: "text", text: "Second block." } },
  ];
  const textOnly = update({ content });
  assert.equal(textOnly.type === "tool" && textOnly.rawOutput, "Opened a page.\nSecond block.");
  const both = update({ content, rawOutput: { output: "own" } });
  assert.deepEqual(both.type === "tool" && both.rawOutput, { output: "own" }, "a harness's own raw output wins");
  const none = update({});
  assert.equal(none.type === "tool" && none.rawOutput, undefined);
});

test("a list keeps the good items when one item is malformed", () => {
  const event = translate({
    method: "_x.ai/queue/changed",
    params: { sessionId: "s", entries: [null, "next", { id: "q1", text: "next", position: 0 }] },
  });
  assert.deepEqual(event.type === "queue" && event.entries, [{ id: "q1", version: 0, text: "next", position: 0 }]);
});

test("plan entries keep only the listed fields", () => {
  const event = translate({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Read the file", priority: "high", status: "pending", env: { TOKEN: "do-not-keep" } }],
      },
    },
  });
  assert.deepEqual(event.type === "plan" && event.entries, [
    { content: "Read the file", priority: "high", status: "pending" },
  ]);
  assert.equal(JSON.stringify(event).includes("do-not-keep"), false);
});

test("a numeric running prompt id is compared as a string", () => {
  const event = translate({
    method: "_x.ai/queue/changed",
    params: { sessionId: "s", entries: [{ id: 3, text: "next", position: 0 }], runningPromptId: 3 },
  });
  assert.equal(event.type === "queue" && event.runningPromptId, "3");
  assert.equal(event.type === "queue" && event.entries[0]?.id, "3");
});

test("a permission request keeps the options that can be answered", () => {
  const event = permissionFromRequest({
    id: 9,
    method: "session/request_permission",
    params: {
      sessionId: "s",
      toolCall: { toolCallId: "call-1", title: "Write a.txt", kind: "edit", rawInput: { file_path: "a.txt" } },
      options: [{ optionId: "allow", name: "Yes", kind: "allow_once" }, { name: "No id" }],
    },
  });
  assert.equal(event.rpcId, 9);
  assert.equal(event.sessionId, "s");
  assert.deepEqual(event.options, [{ optionId: "allow", name: "Yes", kind: "allow_once" }]);
});

test("a permission request without params still asks", () => {
  const event = permissionFromRequest({ id: 1, method: "session/request_permission" });
  assert.equal(event.toolCallId, null);
  assert.equal(event.title, "");
  assert.deepEqual(event.options, []);
});

test("config options keep only the fields the page shows", () => {
  const options = ConfigOptionList.parse([
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "grok-4.7",
      options: [{ value: "grok-4.7", name: "Grok 4.7", _meta: { key: "do-not-keep" } }],
      _meta: { key: "do-not-keep" },
    },
    { name: "no id" },
  ]);
  assert.deepEqual(options, [
    { id: "model", name: "Model", currentValue: "grok-4.7", options: [{ value: "grok-4.7", name: "Grok 4.7" }] },
  ]);
});

test("a session result without a session id reads as missing", () => {
  assert.equal(SessionResult.parse({ configOptions: [] }).sessionId, undefined);
  assert.equal(SessionResult.parse(null).sessionId, undefined);
});

test("a markdown plan_update is a plan document, anything else of that kind is dropped", () => {
  const plan = (value: unknown) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan_update", plan: value } } });
  assert.deepEqual(translate(plan({ type: "markdown", planId: "p1", content: "1. Go" })), { type: "plan-doc", id: "p1", text: "1. Go" });
  assert.equal(eventFromNotification(plan({ type: "html", planId: "p1", content: "x" })), null);
  assert.equal(eventFromNotification(plan({ type: "markdown", content: "no id" })), null);
});

test("a message chunk keeps the harness's message id", () => {
  const event = translate({
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" }, messageId: "msg-1" } },
  });
  assert.deepEqual(event, { type: "chunk", role: "assistant", text: "Hi", messageId: "msg-1" });
});
