import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Wait } from "../../server/snapshot.ts";
import { click, installDom } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { NeedsYou, whyOf } = await import("./NeedsYou.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const base = { sessionId: "s1", cwd: "/repo", title: "Warn the keeper", provider: "claude", folder: "lighthouse", chat: false, since: Date.now() };
const options = [
  { optionId: "allow", name: "Allow", kind: "allow_once" as const },
  { optionId: "reject", name: "Deny", kind: "reject_once" as const },
];
const permission: Wait = { ...base, key: "s1:permission:7", permission: { id: "7", toolCallId: null, title: "git push", name: "Bash", kind: "execute", rawInput: { command: "git push" }, role: "shell", command: "git push", options } };

async function mount(waits: Wait[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const calls: [string, unknown][] = [];
  const opened: string[] = [];
  const tickets = { boards: [], bySession: { s1: [{ taskId: 9, projectId: 1, title: "Warn", reference: null, status: null }] } };
  const call = async (path: string, body: unknown) => {
    calls.push([path, body]);
  };
  await act(async () => createRoot(container).render(createElement(NeedsYou, { waits, tickets, providers: [], call, onOpenChat: (wait) => opened.push(wait.sessionId) })));
  return { container, calls, opened };
}

test("an empty list says that nothing waits", async () => {
  const { container } = await mount([]);
  assert.match(container.textContent || "", /Nothing waits on you/);
});

test("a row names the chat, its ticket, its folder and what waits, and opens to the answer and the chat", async () => {
  const { container, calls, opened } = await mount([permission]);
  const row = container.querySelector(".wait") as HTMLElement;
  assert.match(row.textContent || "", /#9 Warn the keeper/);
  assert.match(row.textContent || "", /lighthouse · asks to run a command · since /);
  assert.equal(container.querySelector("[data-testid=permission]"), null);
  await act(async () => click(row));
  const allow = [...container.querySelectorAll("[data-testid=permission] button")].find((item) => /allow/i.test(item.textContent || ""));
  assert.ok(allow, "no Allow button");
  await act(async () => click(allow));
  assert.deepEqual(calls, [["/api/permission", { optionId: "allow", id: "7", sessionId: "s1" }]]);
  await act(async () => click(container.querySelector("[data-testid=wait-open-chat]") as HTMLElement));
  assert.deepEqual(opened, ["s1"]);
});

test("a question and a plan say what they are", () => {
  assert.equal(whyOf({ ...base, key: "q", question: { id: "8", message: "Which one?", fields: [], actions: [] } }), "asks a question");
  assert.equal(whyOf({ ...base, key: "p", plan: { toolCallId: null, plan: "Do it", planMissing: false } }), "has a plan to approve");
  assert.equal(whyOf({ ...permission, permission: { ...permission.permission!, plan: "Do it" } }), "has a plan to approve");
});
