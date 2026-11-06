import assert from "node:assert/strict";
import test from "node:test";
import { emptySession } from "../../bridge/reducer.ts";
import { chatsToClose, isBusy } from "./idleChats.ts";

const now = 100_000_000;
const ago = (minutes: number) => now - minutes * 60_000;
const idle = (...ids: string[]) => ids.map((id) => ({ id, busy: false }));

test("under the limit only chats unseen for two hours close", () => {
  const shown = new Map([["a", ago(100)], ["b", ago(130)]]);
  assert.deepEqual(chatsToClose(idle("a", "b"), shown, now, 2), ["b"]);
});

test("past the limit chats unseen for half an hour close, the longest unseen first, until the limit is met", () => {
  const shown = new Map([["a", ago(40)], ["b", ago(90)], ["c", ago(35)], ["d", ago(5)]]);
  assert.deepEqual(chatsToClose(idle("a", "b", "c", "d"), shown, now, 3), ["b"]);
  assert.deepEqual(chatsToClose(idle("a", "b", "c", "d"), shown, now, 1), ["b", "a", "c"]);
});

test("busy chats and chats seen within half an hour stay, even past the limit", () => {
  const shown = new Map([["running", ago(300)], ["recent", ago(10)], ["old", ago(31)]]);
  const loaded = [{ id: "running", busy: true }, ...idle("recent", "old")];
  assert.deepEqual(chatsToClose(loaded, shown, now, 0), ["old"]);
});

test("a chat whose background tasks all ended can close, and one with a task running stays", () => {
  const session = emptySession({ id: "a", cwd: "/tmp" });
  const task = { id: "t", kind: "shell", label: "npm test" };
  assert.equal(isBusy({ ...session, backgroundTasks: [{ ...task, status: "completed" }, { ...task, status: "failed" }] }, new Set()), false);
  assert.equal(isBusy({ ...session, backgroundTasks: [{ ...task, status: "running" }] }, new Set()), true);
  assert.equal(isBusy(session, new Set(["a"])), true);
});
