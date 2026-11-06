import assert from "node:assert/strict";
import test from "node:test";
import { workingChatId } from "./workingChat.ts";

test("the one working chat in a folder is the one a ticket can attach to", () => {
  const found = workingChatId([
    { id: "idle", cwd: "/work/app", working: false },
    { id: "other", cwd: "/work/else", working: true },
    { id: "live", cwd: "/work/app", working: true },
  ], "/work/app");
  assert.deepEqual(found, { id: "live", count: 1 });
});

test("two working chats in one folder are not a single attachment", () => {
  const found = workingChatId([
    { id: "a", cwd: "/work/app", working: true },
    { id: "b", cwd: "/work/app", working: true },
  ], "/work/app");
  assert.deepEqual(found, { id: "", count: 2 });
  assert.deepEqual(workingChatId([], "/work/app"), { id: "", count: 0 });
  assert.deepEqual(workingChatId([{ id: "a", working: true }], "/work/app"), { id: "", count: 0 });
  assert.deepEqual(workingChatId([{ id: "a", cwd: "/work/app", working: true }], ""), { id: "", count: 0 });
});
