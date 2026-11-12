import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySession, type SessionState } from "../../bridge/reducer.ts";
import { createWaitClock, waitCards } from "./needsYou.ts";

function session(change: Partial<SessionState>): SessionState {
  return { ...emptySession({ id: "s1", cwd: "/repo" }), ...change };
}

const permission = { rpcId: 7, toolCallId: null, title: "Run git push", name: "Bash", kind: "execute", rawInput: { command: "git push" }, facts: { role: "shell" as const }, options: [] };
const question = { rpcId: 8, message: "Which one?", fields: [], actions: [] };
const hostPrompt = { id: "p1", permission: { toolCallId: null, title: "Open a site", name: "browser", kind: "browser", rawInput: "", role: "other" as const, options: [] } };

test("a chat that waits on nothing has no row", () => {
  assert.deepEqual(waitCards(session({}), null), []);
});

test("each request a chat waits on is a row of its own", () => {
  const cards = waitCards(session({ pendingPermission: permission, pendingElicitation: question, pendingPlan: { rpcId: 9, toolCallId: "t1", plan: "Do it" } }), null);
  assert.deepEqual(cards.map((card) => card.key), ["s1:permission:7", "s1:question:8", "s1:plan:t1"]);
  assert.equal(cards[0]?.permission?.title, "Run git push");
  assert.equal(cards[1]?.question?.message, "Which one?");
  assert.equal(cards[2]?.plan?.plan, "Do it");
});

test("the app's own prompt shows while the agent asks no permission", () => {
  assert.equal(waitCards(session({}), hostPrompt)[0]?.permission?.title, "Open a site");
  assert.deepEqual(
    [hostPrompt, { ...hostPrompt, id: "p2" }].map((prompt) => waitCards(session({}), prompt)[0]?.key),
    ["s1:prompt:p1", "s1:prompt:p2"],
    "the next prompt of a chat is a new row",
  );
  assert.equal(waitCards(session({ pendingPermission: permission }), hostPrompt)[0]?.permission?.title, "Run git push");
});

test("a wait keeps the time it was first listed, and the longest wait leads", () => {
  let now = 100;
  const stamp = createWaitClock(() => now);
  assert.deepEqual(stamp([{ key: "a" }]), [{ key: "a", since: 100 }]);
  now = 200;
  assert.deepEqual(stamp([{ key: "b" }, { key: "a" }]), [{ key: "a", since: 100 }, { key: "b", since: 200 }]);
  now = 300;
  stamp([{ key: "b" }]);
  assert.deepEqual(stamp([{ key: "a" }, { key: "b" }]), [{ key: "b", since: 200 }, { key: "a", since: 300 }]);
});
