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

async function mount(cwd: string, url = board.url, call: (path: string) => Promise<unknown> = async () => ({ ...board, url })) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { cwd, chats: [], call, onOpenSession: noop, onPick: noop, onWorktree: noop } as unknown as ProjectBoardProps;
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

test("a board draws the host's saved board while it loads in full, and when opened again draws at once and asks only whether it changed", async () => {
  localStorage.clear();
  const asked: string[] = [];
  let answer: (value: unknown) => void = noop;
  const call = (path: string) => {
    asked.push(path);
    if (path.includes("saved=1")) return Promise.resolve({ ...board, tasks: board.tasks.slice(0, 1), activity: "" });
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const first = await mount("/kept", board.url, call);
  assert.deepEqual(titles(first.container), ["Mine"]);
  assert.doesNotMatch(asked.at(-1) ?? "", /activity=|saved=/);
  await act(async () => {
    answer({ ...board, activity: "new" });
    await wait(10);
  });
  assert.equal(titles(first.container).length, 4);
  act(() => first.root.unmount());

  asked.length = 0;
  const again = await mount("/kept", board.url, call);
  assert.equal(titles(again.container).length, 4);
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? "", /activity=new/);
  act(() => again.root.unmount());
});

test("a kept board stays on screen when its refresh fails", async () => {
  localStorage.clear();
  const seed = await mount("/refused", board.url, async () => ({ ...board, activity: "same" }));
  act(() => seed.root.unmount());

  let refuse = true;
  const call = async () => {
    if (refuse) throw new Error("Jira is not reachable");
    return { unchanged: true, activity: "same" };
  };
  const again = await mount("/refused", board.url, call);
  assert.equal(titles(again.container).length, 4);
  assert.doesNotMatch(again.container.textContent ?? "", /Jira is not reachable/);
  refuse = false;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await wait(10);
  });
  assert.equal(titles(again.container).length, 4);
  act(() => again.root.unmount());
});

test("a load that ends after the board was left is the board it opens on next", async () => {
  localStorage.clear();
  let answer: (value: unknown) => void = noop;
  const slow = (path: string) => (path.includes("saved=1") ? Promise.resolve({}) : new Promise((resolve) => {
    answer = resolve;
  }));
  const first = await mount("/left", board.url, slow);
  act(() => first.root.unmount());
  answer({ ...board, activity: "late" });
  await wait(10);

  const asked: string[] = [];
  const again = await mount("/left", board.url, async (path) => {
    asked.push(path);
    return { unchanged: true, activity: "late" };
  });
  assert.equal(titles(again.container).length, 4);
  assert.match(asked[0] ?? "", /activity=late/);
  act(() => again.root.unmount());
});

test("the reload button loads the whole board and tells when it was last checked", async () => {
  localStorage.clear();
  const asked: string[] = [];
  const mounted = await mount("/reload", board.url, async (path) => {
    asked.push(path);
    return path.includes("activity=") ? { unchanged: true, activity: "stamp" } : { ...board, activity: "stamp" };
  });
  const reload = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Reload the board"]')!;
  assert.match(reload.title, /^Checked at \d\d:\d\d · Reload$/);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await wait(10);
  });
  assert.match(asked.at(-1) ?? "", /activity=stamp/);
  await act(async () => {
    click(reload);
    await wait(10);
  });
  assert.doesNotMatch(asked.at(-1) ?? "", /activity=/);
  assert.equal(reload.classList.contains("is-busy"), false);
  act(() => mounted.root.unmount());
});

test("a board that fails to load shows the error, and the address the host names for it", async () => {
  localStorage.clear();
  const failed = await mount("/unreachable", board.url, async (path) => {
    if (path.includes("saved=1")) return {};
    throw Object.assign(new Error("The local board is not reachable"), { reply: { address: "http://127.0.0.1:4345" } });
  });
  assert.equal(failed.container.querySelector(".board-missing p")?.textContent, "The local board is not reachable");
  assert.equal(failed.container.querySelector(".board-address")?.textContent, "http://127.0.0.1:4345");
  act(() => failed.root.unmount());
});

test("an older load that ends after a newer one leaves the newer board kept", async () => {
  localStorage.clear();
  const answers: ((value: unknown) => void)[] = [];
  const slow = (path: string) => (path.includes("saved=1") ? Promise.resolve({}) : new Promise((resolve) => {
    answers.push(resolve);
  }));
  const first = await mount("/order", board.url, slow);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await wait(10);
  });
  assert.equal(answers.length, 2);
  act(() => first.root.unmount());
  answers[1]?.({ ...board, activity: "newer" });
  await wait(5);
  answers[0]?.({ ...board, activity: "older" });
  await wait(5);

  const asked: string[] = [];
  const again = await mount("/order", board.url, async (path) => {
    asked.push(path);
    return { unchanged: true, activity: "newer" };
  });
  assert.match(asked[0] ?? "", /activity=newer/);
  act(() => again.root.unmount());
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
