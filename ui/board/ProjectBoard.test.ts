import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, press, typeInto, wait } from "../testing/dom.ts";
import type { ProjectBoardProps } from "./ProjectBoard.tsx";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { ProjectBoard } = await import("./ProjectBoard.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const noop = () => {};
const me = { id: "acc-me", name: "Thimo Eder" };
const lena = { id: "acc-lena", name: "Lena Berg" };

const board = {
  provider: "jira",
  capabilities: { assignees: true },
  columns: [{ value: "To Do", title: "To Do" }],
  tasks: [
    { id: "APP-1", title: "Mine", attributes: { status: "To Do" }, assignees: [me] },
    { id: "APP-2", title: "Lena's", attributes: { status: "To Do" }, assignees: [lena] },
    { id: "APP-3", title: "Ours", attributes: { status: "To Do" }, assignees: [lena, me] },
    { id: "APP-4", title: "Nobody's", attributes: { status: "To Do" }, assignees: [] },
  ],
  me: me.id,
  url: "https://example.atlassian.net/secure/RapidBoard.jspa?rapidView=1",
};

async function mount(cwd: string, url = board.url) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { cwd, chats: [], call: async () => ({ ...board, url }), onOpenSession: noop, onPick: noop, onWorktree: noop } as unknown as ProjectBoardProps;
  await act(async () => {
    root.render(createElement(ProjectBoard, props));
    await wait(10);
  });
  return { container, root };
}

const titles = (container: Element) => [...container.querySelectorAll('[data-testid="ticket-card"] strong')].map((item) => item.textContent);
const personButton = (container: Element) => container.querySelector<HTMLButtonElement>('[data-quick-menu] button[aria-haspopup="menu"]')!;
const option = (container: Element, label: string) =>
  [...container.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent?.includes(label))!;

test("the person filter shows my tickets, the unassigned or one person's, counts each, and finds people by name", async () => {
  localStorage.clear();
  const { container, root } = await mount("/repo");
  try {
    assert.deepEqual(titles(container), ["Mine", "Lena's", "Ours", "Nobody's"]);

    act(() => click(personButton(container)));
    assert.deepEqual(
      [...container.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent),
      ["Everyone4", "TEMeThimo Eder2", "Unassigned1", "LBLena Berg2"],
    );
    act(() => click(option(container, "Me")));
    assert.deepEqual(titles(container), ["Mine", "Ours"]);
    assert.equal(personButton(container).textContent, "TEMe");

    act(() => click(personButton(container)));
    act(() => click(option(container, "Unassigned")));
    assert.deepEqual(titles(container), ["Nobody's"]);

    act(() => click(personButton(container)));
    const find = container.querySelector<HTMLInputElement>('input[aria-label="Find a person"]')!;
    act(() => typeInto(find, "len"));
    assert.deepEqual([...container.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent), ["LBLena Berg2"]);
    act(() => press(find, "Enter"));
    assert.deepEqual(titles(container), ["Lena's", "Ours"]);
  } finally {
    act(() => root.unmount());
  }
});

test("the person picked on a board comes back on that board in any folder, and another board starts on everyone", async () => {
  localStorage.clear();
  const first = await mount("/repo");
  act(() => click(personButton(first.container)));
  act(() => click(option(first.container, "Lena Berg")));
  act(() => first.root.unmount());

  const again = await mount("/repo-worktree");
  assert.deepEqual(titles(again.container), ["Lena's", "Ours"]);
  assert.equal(personButton(again.container).textContent, "LBLena Berg");
  act(() => again.root.unmount());

  const other = await mount("/repo", "https://example.atlassian.net/secure/RapidBoard.jspa?rapidView=2");
  assert.equal(titles(other.container).length, 4);
  act(() => other.root.unmount());
});

test("a ticket opens at once on a skeleton, which its detail replaces once it comes", async () => {
  localStorage.clear();
  let answer: (value: unknown) => void = noop;
  const call = async (path: string) => (path.startsWith("/api/board/tasks/") ? new Promise((resolve) => { answer = resolve; }) : board);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { cwd: "/repo", chats: [], call, onOpenSession: noop, onPick: noop, onWorktree: noop } as unknown as ProjectBoardProps;
  await act(async () => {
    root.render(createElement(ProjectBoard, props));
    await wait(10);
  });
  try {
    await act(async () => click(container.querySelector('[data-testid="ticket-card"]')!));
    assert.ok(container.querySelector('[data-testid="ticket-skeleton"]'));
    assert.equal(container.querySelector('[data-testid="ticket-detail"]'), null);

    await act(async () => {
      answer({ task: board.tasks[0], comments: [], links: [] });
      await wait(10);
    });
    assert.equal(container.querySelector('[data-testid="ticket-skeleton"]'), null);
    assert.equal(container.querySelector(".ticket-title")?.textContent, "Mine");
  } finally {
    act(() => root.unmount());
  }
});

test("labels picked while adding a ticket go with it to the board", async () => {
  const posted: unknown[] = [];
  const sakBoard = {
    provider: "sak",
    capabilities: { labels: true },
    columns: [{ value: "open", title: "open" }],
    labels: [{ id: 1, title: "bug", color: "#eb5a46" }, { id: 2, title: "idea", color: null }],
    tasks: [],
  };
  const call = async (path: string, body?: unknown, method?: string) => {
    if (method === "POST" && path === "/api/board/tasks") {
      posted.push(body);
      return { task: { id: 9, title: "Fix it", attributes: { status: "open" }, labels: [{ id: 1, title: "bug" }] } };
    }
    return sakBoard;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { cwd: "/labels", chats: [], call, onOpenSession: noop, onPick: noop, onWorktree: noop } as unknown as ProjectBoardProps;
  await act(async () => {
    root.render(createElement(ProjectBoard, props));
    await wait(10);
  });
  try {
    act(() => click(container.querySelector("button.board-add")!));
    const title = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New ticket in open"]')!;
    act(() => typeInto(title, "Fix it"));
    act(() => click(container.querySelector('.board-adding button[aria-haspopup="menu"]')!));
    act(() => click([...document.querySelectorAll('[role="menuitemcheckbox"]')].find((item) => item.textContent === "bug")!));
    assert.deepEqual([...container.querySelectorAll(".board-adding .board-pill.is-removable")].map((pill) => pill.textContent), ["bug×"]);
    await act(async () => {
      press(title, "Enter");
      await wait(0);
    });
    assert.deepEqual(posted, [{ cwd: "/labels", title: "Fix it", status: "open", labels: [1] }]);
    assert.equal(container.querySelectorAll(".board-adding .board-pill.is-removable").length, 0, "the next ticket starts without labels");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
