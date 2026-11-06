import assert from "node:assert/strict";
import test from "node:test";
import { emptySession, reduce } from "../bridge/reducer.ts";
import { presentFrozen, presentInput, presentSession, type PresentedItem } from "./present.ts";

function waitingOn(rawInput: unknown) {
  return reduce(emptySession({ id: "s", cwd: "/repo" }), {
    type: "permission",
    rpcId: 0,
    toolCallId: "call-1",
    title: "Approve Plan",
    kind: "switch_mode",
    rawInput,
    options: [
      { optionId: "default", name: "Yes, manually approve edits", kind: "allow_once" },
      { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
    ],
  });
}

test("a permission that carries a plan presents the plan, so the page shows it as one", () => {
  const shown = presentSession(waitingOn({ plan: "# Plan\n\n1. Read\n2. Write" }));
  assert.equal(shown.pendingPermission?.plan, "# Plan\n\n1. Read\n2. Write");
  assert.deepEqual(shown.pendingPermission?.options.map((option) => option.optionId), ["default", "plan"]);
});

test("the page gets a tool's facts beside its fields, cut on the row and whole on its permission", () => {
  const command = "x".repeat(5000);
  const classify = () => ({ role: "shell" as const, command, background: true });
  let session = reduce(
    emptySession({ id: "s", cwd: "/repo" }),
    { type: "tool", toolCallId: "call-1", title: "Run", kind: "execute", status: "in_progress", rawInput: { command } },
    classify,
  );
  session = reduce(session, { type: "permission", rpcId: 1, toolCallId: "call-1", title: "Run", kind: "execute", options: [] }, classify);
  const view = presentSession(session);
  const tool = view.transcript[0];
  assert.equal(tool?.type === "tool" ? tool.role : null, "shell");
  assert.equal(tool?.type === "tool" ? tool.background : null, true);
  assert.equal(tool?.type === "tool" ? tool.command?.length : null, 4001);
  assert.equal(view.pendingPermission?.command, command);
});

test("a tool frozen before tools had facts gets the role its kind names", () => {
  const frozen = { id: "tool:1", type: "tool", toolCallId: "1", title: "Edit a.ts", kind: "edit", status: "completed", rawInput: null, diffs: [], outputPreview: "" };
  const [old, kept] = presentFrozen([frozen as unknown as PresentedItem, { ...frozen, role: "shell" } as PresentedItem]);
  assert.equal(old?.type === "tool" ? old.role : null, "edit");
  assert.equal(kept?.type === "tool" ? kept.role : null, "shell");
});

test("an ordinary permission has no plan", () => {
  assert.equal(presentSession(waitingOn({ command: "ls" })).pendingPermission?.plan, undefined);
  assert.equal(presentSession(waitingOn({ plan: "   " })).pendingPermission?.plan, undefined);
});

test("an edit's text is left out of its input when its diffs carry it, and long strings are cut", () => {
  const long = "x".repeat(5000);
  assert.deepEqual(presentInput({ file_path: "a.txt", old_string: "one", new_string: "two", variant: "SearchReplace" }, true), {
    file_path: "a.txt",
    variant: "SearchReplace",
  });
  assert.deepEqual(presentInput({ file_path: "a.txt", content: long }, true), { file_path: "a.txt" });
  // Without diffs the text is all there is, so it stays, cut to a readable length.
  const kept = presentInput({ file_path: "a.txt", new_string: "two", content: long }, false);
  assert.deepEqual(Object.keys(kept as object), ["file_path", "new_string", "content"]);
  assert.equal((kept as { content: string }).content.length, 4001);
  assert.ok((kept as { content: string }).content.endsWith("…"));
  assert.deepEqual(presentInput({ command: "npm test", nested: { prompt: long }, list: [long] }, false), {
    command: "npm test",
    nested: { prompt: `${"x".repeat(4000)}…` },
    list: [`${"x".repeat(4000)}…`],
  });
  assert.equal(presentInput(undefined, false), null);
  assert.equal(presentInput(long, false), `${"x".repeat(4000)}…`);
});

test("a permission keeps its whole input", () => {
  const long = "x".repeat(5000);
  const view = presentSession(waitingOn({ command: long }));
  assert.deepEqual(view.pendingPermission?.rawInput, { command: long });
});

test("a permission that sends only its tool call's id takes the title and input from that tool row", () => {
  let session = reduce(emptySession({ id: "s", cwd: "/repo" }), {
    type: "tool",
    toolCallId: "call-7",
    title: "mcp.linear.get_issue",
    kind: "execute",
    status: "in_progress",
    rawInput: { server: "linear", tool: "get_issue", arguments: { id: "ABC-1" } },
  });
  session = reduce(session, {
    type: "permission",
    rpcId: 3,
    toolCallId: "call-7",
    title: "",
    name: "",
    kind: "execute",
    rawInput: null,
    options: [{ optionId: "approved", name: "Allow", kind: "allow_once" }],
  });
  const permission = presentSession(session).pendingPermission;
  assert.equal(permission?.title, "mcp.linear.get_issue");
  assert.equal(permission?.kind, "execute");
  assert.deepEqual(permission?.rawInput, { server: "linear", tool: "get_issue", arguments: { id: "ABC-1" } });
  assert.equal(presentSession(waitingOn({ command: "ls" })).pendingPermission?.title, "Approve Plan");
});
