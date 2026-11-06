import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom } from "../../testing/dom.ts";
import { GLIDE_MS } from "./scroll.ts";
import type { PresentedItem } from "../../../server/present.ts";
import type { TranscriptSession } from "../Transcript.tsx";
import type { FrozenStretch } from "../../../server/chat/chatRecords.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { MessageList, TurnCards } = await import("./MessageList.tsx");

const mounted: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function tool(fields: Partial<Extract<PresentedItem, { type: "tool" }>> & { toolCallId: string }): PresentedItem {
  return { id: `tool:${fields.toolCallId}`, type: "tool", title: "", kind: "", status: "completed", rawInput: null, role: "other", diffs: [], outputPreview: "", ...fields };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Renders the list and returns a function that renders it again with a newer transcript.
async function renderLive(transcript: PresentedItem[]) {
  const session = (items: PresentedItem[]): TranscriptSession => ({ id: "s", cwd: "/repo", title: "Chat", transcript: items, status: "running", configOptions: [], queue: [], revision: 1, modeId: "auto" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MessageList, { session: session(transcript), plain: false, drafting: false })));
  return {
    container,
    update: (items: PresentedItem[]) => act(async () => root.render(createElement(MessageList, { session: session(items), plain: false, drafting: false }))),
  };
}

async function render(transcript: PresentedItem[]) {
  const session: TranscriptSession = { id: "s", cwd: "/repo", title: "Chat", transcript, status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MessageList, { session, plain: false, drafting: false })));
  return container;
}

test("chat errors use a local alert card with the provider's message", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const session: TranscriptSession = { id: "failed", cwd: "/repo", title: "Chat", transcript: [], status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto" };
  const detail = "You've hit your weekly limit · resets 1pm (Europe/Berlin)\n<details>";
  const show = (error: string | null, running: boolean, providerLabel?: string) => act(async () => root.render(createElement(TurnCards, {
    session: { ...session, error }, providerLabel, running, remote: false, act: async () => {},
  })));
  for (const running of [false, true]) {
    await show(`Internal error: ${detail}`, running);
    const card = container.querySelector("[data-testid=turn-error]");
    assert.equal(card?.getAttribute("role"), "alert");
    assert.equal(card?.querySelector(".turn-error-title")?.textContent, "Chat error");
    assert.equal(card?.querySelector(".turn-error-message")?.textContent, detail);
    assert.equal(card?.querySelector("details"), null);
  }
  await show("Connection closed", false);
  assert.equal(container.querySelector(".turn-error-message")?.textContent, "Connection closed");
  await show(`Internal error: ${detail}`, false, "Claude");
  assert.equal(container.querySelector(".turn-error-title")?.textContent, "Claude error");
  await show(null, false);
  assert.equal(container.querySelector("[data-testid=turn-error]"), null);
});

test("Try again sends the last message again, and dismiss hides the error until a new one", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const sent: unknown[] = [];
  const transcript: PresentedItem[] = [
    { id: "user-1", type: "user", text: "Bump Electron", streaming: false },
    { id: "assistant-1", type: "assistant", text: "On it.", streaming: false },
  ];
  const show = (error: string, items = transcript) => act(async () => root.render(createElement(TurnCards, {
    session: { id: "retry", cwd: "/repo", title: "Chat", transcript: items, status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto", error },
    running: false,
    remote: false,
    act: async (path: string, body?: Record<string, unknown>) => {
      sent.push([path, body]);
      return {};
    },
  })));
  const press = (testId: string) => act(async () => container.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`)!.click());
  await show("Connection closed");
  await press("turn-retry");
  assert.deepEqual(sent, [["/api/prompt", { text: "Bump Electron" }]]);
  await press("turn-dismiss");
  assert.equal(container.querySelector("[data-testid=turn-error]"), null);
  await show("Connection closed");
  assert.equal(container.querySelector("[data-testid=turn-error]"), null);
  await show("Rate limited");
  assert.ok(container.querySelector("[data-testid=turn-error]"));
  await press("turn-dismiss");
  await show("Rate limited", [...transcript, { id: "user-2", type: "user", text: "Try once more", streaming: false }]);
  assert.ok(container.querySelector("[data-testid=turn-error]"));
});

test("a waiting permission stands in for its tool row at the end of the thread, and its receipt stays where it was answered", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const sent: unknown[] = [];
  const edit = { toolCallId: "edit-1", kind: "edit", role: "edit" as const, title: "Edit `log.ts`", diffs: [{ path: "/repo/log.ts", oldText: "ts\n", newText: "time\n", truncated: false }] };
  const asking = tool({ ...edit, status: "pending" });
  const base: TranscriptSession = { id: "receipts", cwd: "/repo", title: "Chat", transcript: [], status: "running", configOptions: [], queue: [], revision: 1, modeId: "default" };
  const permission = { id: "7", toolCallId: "edit-1", title: "Edit `log.ts`", name: "Edit", kind: "edit", rawInput: { file_path: "/repo/log.ts" }, role: "edit" as const, path: "/repo/log.ts", options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "reject", name: "No", kind: "reject_once" }] };
  const show = (session: Partial<TranscriptSession>) => act(async () => root.render(createElement(MessageList, {
    session: { ...base, ...session },
    plain: false,
    drafting: false,
    agentLabel: "Claude",
    act: async (path: string, body?: Record<string, unknown>) => {
      sent.push([path, body]);
      return {};
    },
  })));
  const user: PresentedItem = { id: "user-1", type: "user", text: "Rename the field", streaming: false };
  await show({ transcript: [user, asking], pendingPermission: permission });
  const card = container.querySelector("[data-testid=permission]");
  assert.equal(card?.querySelector("h2")?.textContent, "Claude wants to edit log.ts");
  assert.equal(container.querySelectorAll("[data-testid=tool]").length, 0);
  assert.deepEqual([...card!.querySelectorAll(".dl")].map((line) => line.textContent), ["1−ts", "1+time"]);
  assert.equal(card!.querySelector(".perm-cut"), null);
  await act(async () => card!.querySelector<HTMLButtonElement>("[data-testid=permission-allow_once]")!.click());
  assert.deepEqual(sent, [["/api/permission", { optionId: "allow-once", id: "7" }]]);
  const reply: PresentedItem = { id: "assistant-1", type: "assistant", text: "Renamed.", streaming: false };
  await show({ transcript: [user, tool(edit), reply], pendingPermission: null });
  assert.equal(container.querySelector("[data-testid=permission]"), null);
  const receipt = container.querySelector("[data-testid=receipt]");
  assert.equal(receipt?.textContent, "Allowed oncelog.ts");
  assert.equal(receipt?.nextElementSibling?.getAttribute("data-testid"), "activity");
  // After a switch the old items move to an earlier stretch, and the new provider numbers its items from the start.
  const earlier: FrozenStretch = { provider: "claude", harnessId: "h-1", model: "Opus", modelId: "opus", items: [user, tool(edit), reply], start: null };
  await show({ transcript: [{ ...user, text: "Carry on" }], stretches: [earlier], pendingPermission: null });
  const receipts = [...container.querySelectorAll("[data-testid=receipt]")];
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0]?.closest("[data-testid=earlier-stretch]"));
});

test("Try again resends the failed message, not a follow-up the agent never read", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const sent: unknown[] = [];
  const transcript: PresentedItem[] = [
    { id: "user-1", type: "user", text: "Bump Electron", streaming: false },
    { id: "user-2", type: "user", text: "Also lint", streaming: false, delivery: { id: "d-1", state: "unread" } },
  ];
  await act(async () => root.render(createElement(TurnCards, {
    session: { id: "retry-unread", cwd: "/repo", title: "Chat", transcript, status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto", error: "Connection closed" },
    running: false,
    remote: false,
    act: async (path: string, body?: Record<string, unknown>) => {
      sent.push([path, body]);
      return {};
    },
  })));
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=turn-retry]")!.click());
  assert.deepEqual(sent, [["/api/prompt", { text: "Bump Electron" }]]);
});

test("a receipt goes above a steered message that still waits, so deleting that message keeps it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const user: PresentedItem = { id: "user-1", type: "user", text: "Run the tests", streaming: false };
  const steered: PresentedItem = { id: "user-2", type: "user", text: "Also lint", streaming: false, delivery: { id: "d-1", state: "waiting" } };
  const permission = { toolCallId: "cmd-1", title: "npm test", name: "Bash", kind: "execute", rawInput: { command: "npm test" }, role: "shell" as const, command: "npm test", options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }] };
  const show = (session: Partial<TranscriptSession>) => act(async () => root.render(createElement(MessageList, {
    session: { id: "steered-receipt", cwd: "/repo", title: "Chat", transcript: [], status: "running", configOptions: [], queue: [], revision: 1, modeId: "default", ...session },
    plain: false,
    drafting: false,
    act: async () => ({}),
  })));
  await show({ transcript: [user, steered], pendingPermission: permission });
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=permission-allow_once]")!.click());
  await show({ transcript: [user], pendingPermission: null });
  assert.equal(container.querySelector("[data-testid=receipt]")?.textContent, "Allowed oncenpm test");
});

test("a plan the session waits on shows as a card in the coding surface too", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MessageList, {
    session: { id: "builder-plan", cwd: "/repo", title: "Chat", transcript: [], status: "running", configOptions: [], queue: [], revision: 1, modeId: "plan", pendingPlan: { toolCallId: "plan-1", plan: "# Add a theme\n\n1. Add the row.", planMissing: false } },
    plain: false,
    drafting: false,
    act: async () => ({}),
  })));
  assert.equal(container.querySelector("[data-testid=plan] h2")?.textContent, "Add a theme");
  assert.deepEqual([...container.querySelectorAll("[data-testid=plan] button")].map((button) => button.textContent), ["Keep planning", "Quit plan", "Approve"]);
});

test("the working line names the chat's agent to screen readers", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const session: TranscriptSession = { id: "s", cwd: "/repo", title: "Chat", transcript: [], status: "running", configOptions: [], queue: [], revision: 1, modeId: "auto" };
  const show = (agentLabel?: string) => act(async () => root.render(createElement(TurnCards, { session, providerLabel: "Grok", agentLabel, running: true, remote: false, act: async () => {} })));
  await show("Claude");
  assert.match(container.querySelector("[data-testid=working]")?.getAttribute("aria-label") ?? "", /^Claude is working\. /);
  await show();
  assert.match(container.querySelector("[data-testid=working]")?.getAttribute("aria-label") ?? "", /^The agent is working\. /);
});

test("an edit with two diffs for the same file shows both", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const diffs = [
    { path: "/repo/log.ts", oldText: "a\n", newText: "b\n", truncated: false },
    { path: "/repo/log.ts", oldText: "c\n", newText: "d\n", truncated: false },
  ];
  const container = await render([tool({ toolCallId: "edit-1", role: "edit", title: "Edit `log.ts`", diffs })]);
  assert.equal(container.querySelectorAll(".edit-block > div").length, 2);
  assert.deepEqual(error.mock.calls.map((call) => String(call.arguments[0])).filter((message) => /same key/.test(message)), []);
});

test("a subagent's steps fold under its row instead of joining the chat", async () => {
  const container = await render([
    { id: "user-1", type: "user", text: "Look at the notes", streaming: false },
    tool({ toolCallId: "agent-1", role: "subagent", title: "Read the notes" }),
    tool({ toolCallId: "read-1", role: "read", title: "Read notes.txt", path: "/repo/notes.txt", parentId: "agent-1" }),
    tool({ toolCallId: "grep-1", role: "search", title: "todo", query: "todo", parentId: "agent-1" }),
    tool({ toolCallId: "read-2", role: "read", title: "Read main.ts", path: "/repo/main.ts" }),
  ]);
  const subagent = container.querySelector("[data-testid=subagent]");
  assert.ok(subagent);
  assert.match(subagent.querySelector("summary")?.textContent ?? "", /Read the notes\s*2 steps/);
  assert.deepEqual([...subagent.querySelectorAll("[data-testid=subagent-steps] li")].map((li) => li.textContent), ["Read notes.txt", "todo"]);
  // The main agent's own read stays in the chat; the subagent's does not.
  assert.doesNotMatch(container.querySelector("[data-testid=activity]")?.textContent?.replace(subagent.textContent ?? "", "") ?? "", /notes\.txt/);
});

test("a subagent in the background is a live card until its task ends", async () => {
  const stopped: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const transcript = [
    tool({ toolCallId: "agent-1", role: "subagent", title: "Port the AI", label: "Port the AI", agent: "general-purpose", background: true }),
    ...["a", "b", "c", "d"].map((name) => tool({ toolCallId: `step-${name}`, role: "shell", title: `step ${name}`, parentId: "agent-1" })),
  ];
  const show = (status: string) =>
    act(async () =>
      root.render(
        createElement(MessageList, {
          session: { id: "s", cwd: "/repo", title: "Chat", transcript, status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto", backgroundTasks: [{ id: "task-9", kind: "local_agent", status, label: "Porting", toolCallId: "agent-1" }] },
          plain: false,
          drafting: false,
          onStopTask: (taskId: string) => stopped.push(taskId),
        }),
      ),
    );
  await show("running");
  const card = () => container.querySelector(".subagent-card");
  const steps = () => [...container.querySelectorAll("[data-testid=subagent-steps] li")].map((li) => li.textContent);
  assert.match(card()?.querySelector(".subagent-head")?.textContent ?? "", /Port the AI\s*general-purpose\s*4 steps/);
  assert.deepEqual(steps(), ["Run step b", "Run step c", "Run step d"]);
  const more = [...(card()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Show all");
  await act(async () => more?.click());
  assert.deepEqual(steps(), ["Run step a", "Run step b", "Run step c", "Run step d"]);
  const stop = [...(card()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Stop");
  await act(async () => stop?.click());
  assert.deepEqual(stopped, ["task-9"]);
  await show("stopped");
  assert.equal(card(), null);
  assert.match(container.querySelector("[data-testid=subagent] summary")?.textContent ?? "", /Port the AI\s*4 steps · stopped/);
});

test("a subagent shows its card before its first step, and a background command keeps its row", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const transcript = [
    tool({ toolCallId: "agent-1", role: "subagent", title: "Port the AI", status: "in_progress" }),
    tool({ toolCallId: "dev-1", role: "shell", title: "npm run dev", command: "npm run dev", background: true }),
  ];
  await act(async () =>
    root.render(
      createElement(MessageList, {
        session: { id: "s", cwd: "/repo", title: "Chat", transcript, status: "running", configOptions: [], queue: [], revision: 1, modeId: "auto", backgroundTasks: [{ id: "bash-1", kind: "local_bash", status: "running", label: "npm run dev", toolCallId: "dev-1" }] },
        plain: false,
        drafting: false,
      }),
    ),
  );
  const cards = [...container.querySelectorAll(".subagent-card")];
  assert.deepEqual(cards.map((card) => card.getAttribute("data-subagent")), ["tool:agent-1"]);
  assert.match(container.textContent ?? "", /npm run dev/);
});

test("a step whose subagent is not in the transcript stays in the chat", async () => {
  const container = await render([tool({ toolCallId: "read-1", role: "read", title: "Read notes.txt", path: "/repo/notes.txt", parentId: "gone" })]);
  assert.equal(container.querySelector("[data-testid=subagent]"), null);
  assert.match(container.textContent ?? "", /Read 1 file/);
});

test("thinking shows its newest sentences, starting at a sentence", async () => {
  const thought = "First I list the desks. Ana must sit at an end. " + "Ben is two right of Vim, so Vim is at desk one, two or three. ".repeat(4) + "So Ben sits at desk four or five.";
  const container = await render([
    { id: "user-1", type: "user", text: "Solve it", streaming: false },
    { id: "thought-1", type: "thought", text: thought, streaming: true },
  ]);
  const shown = container.querySelector("[data-testid=thinking-preview]")?.textContent ?? "";
  assert.ok(shown.endsWith("So Ben sits at desk four or five."), shown);
  assert.ok(shown.length <= 240, `${shown.length} characters`);
  assert.match(shown, /^[A-Z]/);
});

test("a streamed reply comes out at a steady pace, and what was there on load shows at once", async () => {
  const first = "The hands overlap eleven times in twelve hours.";
  const more = " They meet every 12/11 of an hour, so after 12:00 at about 1:05, 2:11, 3:16 and so on.".repeat(2);
  const { container, update } = await renderLive([{ id: "assistant-1", type: "assistant", text: first, streaming: true }]);
  const bubble = () => container.querySelector(".bubble.assistant")?.textContent ?? "";
  // Already there when it mounted, as after a page reload: shown at once.
  assert.equal(bubble(), first);
  await update([{ id: "assistant-1", type: "assistant", text: first + more, streaming: true }]);
  await act(() => wait(200));
  assert.ok(bubble().length > first.length && bubble().length < (first + more).length, `shown ${bubble().length} of ${(first + more).length}`);
  await act(() => wait(1400));
  assert.equal(bubble(), (first + more).trim());
});

test("a nested subagent's steps fold under the outermost subagent", async () => {
  const container = await render([
    tool({ toolCallId: "outer", role: "subagent", title: "Review the app" }),
    tool({ toolCallId: "inner", role: "subagent", title: "Read the tests", parentId: "outer" }),
    tool({ toolCallId: "read-1", role: "read", title: "Read a.test.ts", path: "/repo/a.test.ts", parentId: "inner" }),
  ]);
  const rows = [...container.querySelectorAll("[data-testid=subagent]")];
  assert.equal(rows.length, 1);
  assert.match(rows[0]?.querySelector("summary")?.textContent ?? "", /Review the app\s*2 steps/);
});

test("a steered message says it waits, with copy, delete and Send now, then that it was read", async () => {
  const sent: string[] = [];
  const removed: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const show = (state: "waiting" | "read") =>
    act(async () =>
      root.render(
        createElement(MessageList, {
          session: {
            id: "s",
            cwd: "/repo",
            title: "Chat",
            status: "running",
            configOptions: [],
            queue: [],
            revision: 1,
            modeId: "auto",
            transcript: [
              { id: "user-1", type: "user", text: "Fix it", streaming: false },
              { id: "user-2", type: "user", text: "Also the tests", streaming: false, delivery: { id: "d1", state } },
            ],
          },
          plain: false,
          drafting: false,
          onSendNow: (id) => sent.push(id),
          onRemoveSteer: (id) => removed.push(id),
        }),
      ),
    );
  const status = () => [...container.querySelectorAll("[data-testid=delivery-status]")].map((node) => node.textContent);
  const click = (testId: string) => act(async () => (container.querySelector(`[data-testid=${testId}]`) as HTMLButtonElement).click());

  const tools = (index: number) =>
    [...(container.querySelectorAll(".message")[index]?.querySelectorAll(".message-tools button") ?? [])].map((button) => button.getAttribute("aria-label") ?? button.textContent);

  await show("waiting");
  assert.deepEqual(status(), ["Waiting"]);
  // Every message can be copied. Only the waiting one has Delete and Send now.
  assert.deepEqual(tools(0), ["Copy message"]);
  assert.deepEqual(tools(1), ["Copy message", "Delete message", "Send now"]);
  await click("delivery-send-now");
  await click("delivery-remove");
  assert.deepEqual([sent, removed], [["d1"], ["d1"]]);

  // Read shows for a moment after it turns read, then only on hover.
  await show("read");
  assert.deepEqual(status(), ["Read"]);
  assert.equal(container.querySelector("[data-testid=delivery-status]")?.classList.contains("is-quiet"), false);
  assert.deepEqual(tools(1), ["Copy message"]);
});

test("a message that was read before it showed keeps Read for hover", async () => {
  const container = await render([{ id: "user-1", type: "user", text: "Also the tests", streaming: false, delivery: { id: "d1", state: "read" } }]);
  assert.equal(container.querySelector("[data-testid=delivery-status]")?.classList.contains("is-quiet"), true);
});

test("Read goes quiet three seconds after the message turns read", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const show = (state: "waiting" | "read") =>
    act(async () =>
      root.render(
        createElement(MessageList, {
          session: { id: "s", cwd: "/repo", title: "Chat", status: "running", configOptions: [], queue: [], revision: 1, modeId: "auto", transcript: [{ id: "user-1", type: "user", text: "Also the tests", streaming: false, delivery: { id: "d1", state } }] },
          plain: false,
          drafting: false,
        }),
      ),
    );
  const quiet = () => container.querySelector("[data-testid=delivery-status]")?.classList.contains("is-quiet");
  await show("waiting");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await show("read");
  assert.equal(quiet(), false);
  await act(async () => t.mock.timers.tick(3000));
  assert.equal(quiet(), true);
});

test("a loading chat shows stand-in rows, or its stored copy as it will look once loaded", async () => {
  const base: TranscriptSession = { id: "s", cwd: "/repo", title: "Chat", transcript: [], status: "idle", configOptions: [], queue: [], revision: 0, modeId: "", loading: true };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MessageList, { session: base, plain: false, drafting: false })));
  assert.ok(container.querySelector(".loading-thread"), "no stand-in rows");
  assert.equal(container.querySelector(".empty"), null);
  const stored = { ...base, transcript: [{ id: "u1", type: "user" as const, text: "Make it faster", streaming: false }] };
  await act(async () => root.render(createElement(MessageList, { session: stored, plain: false, drafting: false })));
  assert.equal(container.querySelector(".loading-thread"), null);
  const shown = container.innerHTML;
  await act(async () => root.render(createElement(MessageList, { session: { ...stored, loading: false }, plain: false, drafting: false })));
  assert.equal(container.innerHTML, shown);
});

test("an opening chat rises in once, again for the next chat, and never for what streams in, a first message just sent, or with the rise off", async (t) => {
  const rose: Element[] = [];
  t.mock.method(dom.Element.prototype, "getBoundingClientRect", () => ({ top: 0, bottom: 100 }));
  Object.defineProperty(dom.Element.prototype, "animate", { configurable: true, value(this: Element) { rose.push(this); } });
  t.after(() => Reflect.deleteProperty(dom.Element.prototype, "animate"));
  const asked: PresentedItem = { id: "u1", type: "user", text: "Fix it", streaming: false };
  const answered: PresentedItem = { id: "a1", type: "assistant", text: "Fixed", streaming: false };
  const session = (id: string, transcript: PresentedItem[]): TranscriptSession => ({ id, cwd: "/repo", title: "Chat", transcript, status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const show = (next: TranscriptSession) => act(async () => root.render(createElement(MessageList, { session: next, plain: false, drafting: false })));

  await show(session("a", [asked, answered]));
  assert.deepEqual(rose, [...container.querySelector(".thread")!.children]);
  await show(session("a", [asked, answered, { id: "a2", type: "assistant", text: "More", streaming: true }]));
  assert.equal(rose.length, 2);
  await show(session("b", [asked, answered]));
  assert.equal(rose.length, 4);
  await show(session("c", [asked]));
  await show(session("c", [asked, answered]));
  assert.equal(rose.length, 4);
  localStorage.setItem("x-bench-chat-rise", "off");
  t.after(() => localStorage.removeItem("x-bench-chat-rise"));
  await show(session("d", [asked, answered]));
  assert.equal(rose.length, 4, "Settings turned the rise off");
});

// A transcript 2000 pixels tall in a 500 pixel window, scrolled to the end.
function scrollable(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>("[data-testid=transcript]")!;
  let top = 1500;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(value, 1500);
    },
  });
  return {
    get top() {
      return top;
    },
    scrollTo: (value: number) =>
      act(async () => {
        top = value;
        el.dispatchEvent(new Event("scroll"));
      }),
  };
}

async function renderFollowing(transcript: PresentedItem[]) {
  const session = (items: PresentedItem[]): TranscriptSession => ({ id: "s", cwd: "/repo", title: "Chat", transcript: items, status: "running", configOptions: [], queue: [], revision: 1, modeId: "auto" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const draw = (items: PresentedItem[], followTick: number, extra: Partial<TranscriptSession> = {}) =>
    act(async () => root.render(createElement(MessageList, { session: { ...session(items), ...extra }, plain: false, drafting: false, followTick, act: async () => ({}) })));
  await draw(transcript, 0);
  return { container, draw };
}

test("scrolled up, the list stays put, offers the way back, and says when something new arrived", async () => {
  const first: PresentedItem[] = [{ id: "user-1", type: "user", text: "Fix it", streaming: false }];
  const { container, draw } = await renderFollowing(first);
  const view = scrollable(container);
  const jump = () => container.querySelector<HTMLButtonElement>("[data-testid=jump-latest]")!;
  await view.scrollTo(1500);
  assert.equal(jump().classList.contains("shown"), false);

  await view.scrollTo(600);
  assert.equal(jump().classList.contains("shown"), true);
  assert.equal(jump().classList.contains("fresh"), false);
  assert.equal(jump().getAttribute("aria-label"), "Jump to the latest message");

  await draw([...first, { id: "assistant-1", type: "assistant", text: "On it", streaming: true }], 0);
  assert.equal(view.top, 600);
  assert.equal(jump().classList.contains("fresh"), true);
  assert.equal(jump().getAttribute("aria-label"), null);

  await act(async () => jump().click());
  assert.equal(jump().classList.contains("shown"), false);
  assert.ok(view.top >= 1000 && view.top < 1500, "the glide starts one window above the end");
  await act(() => wait(GLIDE_MS + 100));
  assert.equal(view.top, 1500);
});

test("a card that arrives while the reader is scrolled up says so, and the list stays put", async () => {
  const first: PresentedItem[] = [{ id: "user-1", type: "user", text: "Open the docs", streaming: false }];
  const { container, draw } = await renderFollowing(first);
  const view = scrollable(container);
  await view.scrollTo(1500);
  await view.scrollTo(600);
  const prompt = { toolCallId: null, title: "Open docs.xbench.dev in the browser", name: "browser", kind: "browser", rawInput: "https://docs.xbench.dev", role: "other" as const, options: [{ optionId: "host:once:1", name: "Allow once", kind: "allow_once" }] };
  await draw(first, 0, { pendingPermission: prompt });
  assert.equal(view.top, 600);
  assert.equal(container.querySelector("[data-testid=jump-latest]")?.classList.contains("fresh"), true);
});

test("sending a message glides the list back to the end", async () => {
  const first: PresentedItem[] = [{ id: "user-1", type: "user", text: "Fix it", streaming: false }];
  const { container, draw } = await renderFollowing(first);
  const view = scrollable(container);
  await view.scrollTo(1500);
  await view.scrollTo(200);
  assert.ok(container.querySelector("[data-testid=jump-latest].shown"));

  await draw(first, 1);
  await act(() => wait(GLIDE_MS + 100));
  assert.equal(view.top, 1500);
  assert.equal(container.querySelector("[data-testid=jump-latest].shown"), null);
});

test("scrolling up during the glide stops it", async () => {
  const first: PresentedItem[] = [{ id: "user-1", type: "user", text: "Fix it", streaming: false }];
  const { container, draw } = await renderFollowing(first);
  const view = scrollable(container);
  await view.scrollTo(1500);
  await view.scrollTo(200);
  await draw(first, 1);
  await view.scrollTo(400);
  await act(() => wait(GLIDE_MS + 100));
  assert.equal(view.top, 400);
  assert.ok(container.querySelector("[data-testid=jump-latest].shown"));
});

test("a link to a local board opens that board with the ticket selected", async () => {
  const opened: unknown[] = [];
  const session: TranscriptSession = { id: "s", cwd: "/repo", title: "Chat", status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto", transcript: [{ id: "assistant-1", type: "assistant", text: "See [ticket 120](http://127.0.0.1:8797/?cwd=/repo&task=120).", streaming: false }] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MessageList, { session, plain: false, drafting: false, onOpenBoard: (cwd, taskId) => opened.push([cwd, taskId]) })));
  const link = container.querySelector("a[href]") as HTMLAnchorElement;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => link.dispatchEvent(event));
  assert.deepEqual(opened, [["/repo", 120]]);
  assert.equal(event.defaultPrevented, true);
});

test("a short ticket link opens the ticket on the board of the chat's folder", async () => {
  const opened: unknown[] = [];
  const session: TranscriptSession = { id: "s", cwd: "/repo", title: "Chat", status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto", transcript: [{ id: "assistant-1", type: "assistant", text: "Waits on [#436](?task=436).", streaming: false }] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MessageList, { session, plain: false, drafting: false, onOpenBoard: (cwd, taskId) => opened.push([cwd, taskId]) })));
  const link = container.querySelector("a[href]") as HTMLAnchorElement;
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  assert.deepEqual(opened, [["/repo", 436]]);
});
