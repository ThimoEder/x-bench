import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { ComposerCatalog } from "../../server/snapshot.ts";
import { click, installDom, press } from "../testing/dom.ts";
import type { WorktreePlan } from "../folder/draftWorktree.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { ThreadSheet } = await import("./ThreadSheet.tsx");

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

const catalog = { models: [] } as unknown as ComposerCatalog;

// The sheet for ticket 41 on /repo, a checkout on main.
async function mountSheet(worktree: WorktreePlan = { on: false, gitRef: "" }) {
  const requests: [string, unknown][] = [];
  const events: string[] = [];
  const call = async (path: string, body?: unknown) => {
    requests.push([path, body]);
    if (path.startsWith("/api/board/tasks/41/brief")) return { draft: "Implement this ticket.", hidden: 0, title: "Ship it" };
    if (path === "/api/folder/refs") return { branch: "main", root: "/repo", defaultBranch: "main", branches: [{ name: "main", current: true, remote: false }], worktrees: [] };
    if (path === "/api/folder/worktree") return { path: "/repo/.grok/worktrees/ship-it" };
    if (path === "/api/board/threads") return { sessionId: "s1" };
    throw new Error(`Unexpected ${path}`);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () =>
    root.render(
      createElement(ThreadSheet, {
        cwd: "/repo",
        taskId: 41,
        title: "#41 Ship it",
        call,
        catalog,
        picks: {},
        onPick: () => {},
        worktree,
        onWorktree: (on: boolean) => events.push(`worktree ${on}`),
        onStarted: () => events.push("started"),
        onCancel: () => events.push("cancelled"),
      }),
    ),
  );
  return { container, requests, events };
}

function must(element: Element | null): Element {
  assert.ok(element, "the element is missing");
  return element;
}

test("Esc in the branch menu closes only the menu, and the next Esc closes the sheet from wherever focus went", async () => {
  const { container, events } = await mountSheet();
  await act(async () => click(must(container.querySelector("[data-testid=branch-menu]"))));
  const search = must(container.querySelector(".branch-popover input"));
  await act(async () => press(search, "Escape"));
  assert.equal(container.querySelector(".branch-menu.open"), null);
  assert.deepEqual(events, []);
  await act(async () => press(document.body, "Escape"));
  assert.deepEqual(events, ["cancelled"]);
});

test("a ticked worktree box makes the worktree named after the ticket, and the chat starts in it", async () => {
  const { container, requests, events } = await mountSheet({ on: true, gitRef: "" });
  await act(async () => click(must(container.querySelector("button[type=submit]"))));
  const worktree = requests.find(([path]) => path === "/api/folder/worktree");
  assert.deepEqual(worktree?.[1], { cwd: "/repo", name: "Ship it" });
  const thread = requests.find(([path]) => path === "/api/board/threads");
  assert.deepEqual(thread?.[1], { cwd: "/repo/.grok/worktrees/ship-it", taskId: 41, prompt: "Implement this ticket.", session: {} });
  assert.deepEqual(events, ["worktree true", "started"]);
});
