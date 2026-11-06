import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions, sessionIndex } from "./sessions.ts";
import { emptySession, type SessionState, type ToolItem, type UserItem } from "../../bridge/reducer.ts";
import { presentSession, type PresentedSession, type PresentedTextItem, type PresentedToolItem } from "../present.ts";

// A full session: the fields a test does not name keep their empty values.
function session(overrides: Partial<SessionState>): SessionState {
  return { ...emptySession({ id: "s", cwd: "/work" }), ...overrides };
}

function user(fields: Pick<UserItem, "id" | "text"> & Partial<UserItem>): UserItem {
  return { type: "user", streaming: false, ...fields };
}

function tool(fields: Pick<ToolItem, "id" | "toolCallId" | "title"> & Partial<ToolItem>): ToolItem {
  return {
    type: "tool",
    name: "",
    kind: "",
    status: null,
    rawInput: undefined,
    rawOutput: undefined,
    facts: { role: "other" },
    diffs: [],
    locations: null,
    ...fields,
  };
}

function textAt(view: PresentedSession, index: number): PresentedTextItem {
  const item = view.transcript.at(index);
  assert.ok(item && item.type !== "tool", `no text item at ${index}`);
  return item;
}

function toolAt(view: PresentedSession, index: number): PresentedToolItem {
  const item = view.transcript.at(index);
  assert.ok(item?.type === "tool", `no tool item at ${index}`);
  return item;
}

test("listSessions returns titles for one working directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-sessions-"));
  const cwd = "/work/app";
  const other = "/work/else";
  writeSummary(root, cwd, "aaa", { generated_title: "Newer", updated_at: "2026-09-21T12:00:00Z" });
  writeSummary(root, cwd, "bbb", { generated_title: "Older", updated_at: "2026-09-21T08:00:00Z" });
  writeSummary(root, other, "ccc", { generated_title: "Elsewhere", updated_at: "2026-09-21T18:00:00Z" });

  const rows = listSessions(cwd, root);
  assert.deepEqual(rows.map((row) => row.title), ["Newer", "Older"]);
  assert.equal(rows[0]?.id, "aaa");
  rmSync(root, { recursive: true, force: true });
});

test("a subagent session is not its own chat", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-subagent-"));
  writeSummary(root, "/work/app", "parent", { generated_title: "Parent", updated_at: "2026-09-22T12:00:00Z" });
  writeSummary(root, "/work/app", "child", {
    generated_title: "Read package.json and report project info",
    updated_at: "2026-09-22T12:05:00Z",
    session_kind: "subagent",
  });
  assert.deepEqual(listSessions("/work/app", root).map((row) => row.id), ["parent"]);
  assert.deepEqual(sessionIndex(root).rows.map((row) => row.id), ["parent"]);
  assert.deepEqual(sessionIndex(root).subagentIds, ["child"]);
  rmSync(root, { recursive: true, force: true });
});

test("a worktree session keeps the checkout it was started from", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-worktree-"));
  writeSummary(root, "/wt/topic", "wt", {
    generated_title: "Topic",
    updated_at: "2026-09-24T21:32:00Z",
    source_workspace_dir: "/repo",
    worktree_label: "topic",
    session_kind: "worktree",
  });
  const row = sessionIndex(root).rows[0];
  assert.equal(row?.cwd, "/wt/topic");
  assert.equal(row?.source, "/repo");
  assert.equal(row?.worktreeLabel, "topic");
  rmSync(root, { recursive: true, force: true });
});

test("presentSession keeps a hidden user note marked hidden", () => {
  const view = presentSession(
    session({
      status: "idle",
      transcript: [user({ id: "user-1", text: "<system-reminder>done</system-reminder>", hidden: true })],
    }),
  );
  assert.equal(textAt(view, 0).hidden, true);
  assert.equal(textAt(view, 0).text.includes("system-reminder"), true);
});

test("presentSession drops tool output blobs and permission rpc ids", () => {
  const view = presentSession(
    session({
      status: "idle",
      stopReason: "end_turn",
      revision: 3,
      modelId: "grok-4.7",
      reasoningEffort: "high",
      configOptions: [],
      pendingPermission: { rpcId: 9, toolCallId: "c", title: "Write", name: "Write", kind: "edit", rawInput: { file_path: "a.txt" }, facts: { role: "edit", path: "a.txt" }, options: [] },
      transcript: [
        tool({
          id: "tool:c",
          toolCallId: "c",
          title: "Write",
          status: "completed",
          rawInput: { file_path: "a.txt" },
          rawOutput: { secret: "do-not-send", tool_output_for_prompt_concise: "created" },
          diffs: [{ path: "a.txt", oldText: "", newText: "hi" }],
        }),
      ],
    }),
  );
  assert.ok(view.pendingPermission);
  assert.equal(Reflect.get(view.pendingPermission, "rpcId"), undefined);
  assert.equal(view.activity, null);
  assert.equal(Reflect.get(toolAt(view, 0), "rawOutput"), undefined);
  assert.equal(toolAt(view, 0).outputPreview, "created");
  assert.equal(JSON.stringify(view).includes("do-not-send"), false);

  const nested = presentSession(
    session({
      status: "idle",
      transcript: [
        tool({
          id: "tool:c",
          toolCallId: "c",
          title: "Write",
          status: "completed",
          rawOutput: { type: "SearchReplace", EditsApplied: { tool_output_for_prompt_concise: "created" } },
          diffs: [],
        }),
      ],
    }),
  );
  assert.equal(toolAt(nested, 0).outputPreview, "created");

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const pictured = presentSession(
    session({
      status: "idle",
      transcript: [
        tool({
          id: "tool:shot",
          toolCallId: "call-shot",
          title: "Read shot.png",
          status: "completed",
          images: [{ mimeType: "image/png", data: png }],
        }),
      ],
    }),
  );
  assert.deepEqual(toolAt(pictured, 0).images, [{ index: 0, mimeType: "image/png" }]);
  assert.equal(JSON.stringify(pictured).includes(png), false);

  const sent = presentSession(
    session({
      status: "idle",
      transcript: [
        user({
          id: "user-2",
          text: "",
          promptIndex: 4,
          images: [{ mimeType: "image/png", data: png }],
        }),
      ],
    }),
  );
  assert.equal(textAt(sent, 0).type, "user");
  assert.equal(textAt(sent, 0).text, "");
  assert.deepEqual(textAt(sent, 0).images, [{ index: 0, mimeType: "image/png" }]);
  assert.equal(Reflect.get(textAt(sent, 0), "promptIndex"), undefined);
  assert.equal(JSON.stringify(sent).includes(png), false);

  const working = presentSession(
    session({
      status: "running",
      activity: { key: "think:1", label: "Thinking...", since: 1_700_000_000_000 },
    }),
  );
  assert.deepEqual(working.activity, { label: "Thinking...", since: 1_700_000_000_000 });

  const hinted = presentSession(session({ status: "idle", suggestion: "next" }));
  assert.equal(hinted.suggestion, "next");
  const quiet = presentSession(session({ status: "idle" }));
  assert.equal(quiet.suggestion, null);
});

function writeSummary(root: string, cwd: string, id: string, fields: Record<string, unknown>) {
  const dir = path.join(root, encodeURIComponent(cwd), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ info: { id, cwd }, ...fields }),
  );
}
