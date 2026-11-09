import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, press, typeInto, wait } from "../testing/dom.ts";
import { NO_SETTINGS, type BoardSettings } from "../../server/board/boardSettings.ts";
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

const board = {
  provider: "jira",
  capabilities: {},
  columns: [
    { value: "To Do", title: "To Do" },
    { value: "In Progress", title: "In Progress" },
    { value: "Done", title: "Done" },
    { value: "Won't Do", title: "Won't Do" },
  ],
  tasks: [
    { id: "APP-1", title: "Plan", attributes: { status: "To Do" } },
    { id: "APP-2", title: "Build", attributes: { status: "In Progress" } },
    { id: "APP-3", title: "Ship", attributes: { status: "Done" } },
    { id: "APP-4", title: "Drop", attributes: { status: "Won't Do" } },
  ],
};

interface Request {
  path: string;
  body: Record<string, unknown>;
  method: string;
}

// A host that answers the board with these settings, and keeps what a save sends.
// held, when given, keeps each save's answer back until the test calls it. A save is refused while refuse.on is set.
// A load that sends an activity stamp is answered as unchanged.
async function mount(start: BoardSettings, view: object = board, held?: (() => void)[], refuse: { on: boolean } = { on: false }) {
  let settings = start;
  const requests: Request[] = [];
  const call = async (path: string, body: Record<string, unknown> = {}, method = "POST") => {
    requests.push({ path, body, method });
    if (path.startsWith("/api/board/board")) return path.includes("activity=") ? { unchanged: true, settings } : { ...view, settings };
    if (path === "/api/board/settings" && refuse.on) throw new Error("refused");
    if (path === "/api/board/lists") return { column: { value: body.listId, colorName: body.color, color: "#61bd4f" } };
    if (path.startsWith("/api/board/tasks/")) return { task: board.tasks.find((task) => path.endsWith(task.id)) };
    if (path === "/api/board/settings") settings = method === "DELETE" ? NO_SETTINGS : body.settings as BoardSettings;
    const saved = settings;
    if (held && path === "/api/board/settings") await new Promise<void>((resolve) => {
      held.push(resolve);
    });
    return { settings: saved };
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { cwd: "/repo", chats: [], call, onOpenSession: noop, onPick: noop, onWorktree: noop } as unknown as ProjectBoardProps;
  await act(async () => {
    root.render(createElement(ProjectBoard, props));
    await wait(10);
  });
  const open = (taskId: unknown) => act(async () => {
    root.render(createElement(ProjectBoard, { ...props, taskId }));
    await wait(10);
  });
  const saves = () => requests.filter((request) => request.path !== "/api/board/board" && !request.path.startsWith("/api/board/board?"));
  const loads = () => requests.flatMap((request) => (request.path.startsWith("/api/board/board?") && !request.path.includes("saved=") ? [request.path] : []));
  return { container, root, saves, loads, open, settings: () => settings };
}

const columnTitles = (container: Element) => [...container.querySelectorAll(".board-columns > section")].map((item) => item.querySelector("h3, .board-column-strip-title")?.textContent?.replace(/\d+$/, ""));
const button = (container: Element, label: string) => {
  const found = [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
  assert.ok(found, `no button ${label}`);
  return found;
};

test("a hidden column leaves the board, and a column collapses from its header into a strip that opens again and takes a color on a board without its own", async () => {
  const { container, root, saves, settings } = await mount({ ...NO_SETTINGS, columns: { "Won't Do": { hidden: true } } });
  try {
    assert.deepEqual(columnTitles(container), ["To Do", "In Progress", "Done"]);
    assert.equal(button(container, "1 hidden column").getAttribute("title"), "Won't Do");

    await act(async () => click(button(container, "Collapse To Do")));
    assert.equal(container.querySelector('[data-testid="ticket-card"][tabindex="0"] strong')?.textContent, "Build", "the tab stop is a card that shows");
    await act(async () => click(button(container, "Expand To Do, 1 ticket")));

    await act(async () => click(button(container, "Collapse Done")));
    assert.equal(container.querySelector('[data-testid="column-Done"]')?.classList.contains("is-collapsed"), true);
    assert.deepEqual(settings().columns.Done, { collapsed: true });

    await act(async () => click(button(container, "Expand Done, 1 ticket")));
    assert.equal(container.querySelector('[data-testid="column-Done"]')?.classList.contains("is-collapsed"), false);

    await act(async () => click(button(container, "Color for To Do")));
    await act(async () => click(button(container, "green")));
    assert.equal(settings().columns["To Do"]?.color, "green");
    assert.equal(button(container, "green").getAttribute("aria-selected"), "true");
    assert.equal(saves().some((request) => request.path === "/api/board/lists"), false);

    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Search tickets"]')!, "Drop");
      await wait(250);
    });
    assert.deepEqual(columnTitles(container), ["To Do", "In Progress", "Done", "Won't Do"], "a search shows a hidden column with a ticket it found");
  } finally {
    act(() => root.unmount());
  }
});

test("the settings pane orders and hides columns, picks where agents move tickets, and resets", async () => {
  const { container, root, saves, settings } = await mount(NO_SETTINGS);
  try {
    await act(async () => click(button(container, "Board settings")));
    const pane = container.querySelector(".board-settings")!;
    const rows = () => [...pane.querySelectorAll(".board-settings-name")].map((item) => item.textContent);
    assert.deepEqual(rows(), ["To Do", "In Progress", "Done", "Won't Do"]);

    await act(async () => press(button(pane, "Move Done. Arrow keys move it up or down"), "ArrowUp"));
    assert.deepEqual(settings().order, ["To Do", "Done", "In Progress", "Won't Do"]);
    assert.deepEqual(rows(), ["To Do", "Done", "In Progress", "Won't Do"]);

    await act(async () => click(button(pane, "Hide Won't Do")));
    assert.deepEqual(settings().columns, { "Won't Do": { hidden: true } });
    assert.deepEqual(columnTitles(container), ["To Do", "Done", "In Progress"]);

    const selects = [...pane.querySelectorAll("select")];
    assert.deepEqual(selects.map((select) => select.value), ["", "In Progress", "", "Done"]);
    await act(async () => {
      selects[2]!.value = "Done";
      selects[2]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      selects[1]!.value = "";
      selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(settings().moves, { review: { status: "Done", title: "Done" }, start: null });

    await act(async () => click(button(pane, "Reset")));
    assert.equal(saves().at(-1)?.method, "DELETE");
    assert.deepEqual(columnTitles(container), ["To Do", "In Progress", "Done", "Won't Do"]);
  } finally {
    act(() => root.unmount());
  }
});

test("a column without a status starts with its palette closed and opens it from its swatch", async () => {
  const { container, root } = await mount(NO_SETTINGS, { ...board, columns: [...board.columns, { value: null, title: "unset" }] });
  try {
    assert.equal(container.querySelectorAll(".column-toolbar.is-open").length, 0);
    await act(async () => click(button(container, "Color for unset")));
    assert.equal(container.querySelectorAll(".column-toolbar.is-open").length, 1);
  } finally {
    act(() => root.unmount());
  }
});

test("a change made while earlier saves are still answering keeps them all", async () => {
  const held: (() => void)[] = [];
  const { container, root, saves, settings } = await mount(NO_SETTINGS, board, held);
  try {
    await act(async () => click(button(container, "Collapse To Do")));
    await act(async () => click(button(container, "Collapse In Progress")));
    assert.equal(saves().length, 1, "the second save waits for the first, so they reach the host in order");
    await act(async () => held.shift()?.());
    await act(async () => click(button(container, "Collapse Done")));
    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        held.splice(0).forEach((answer) => answer());
        await wait(5);
      });
    }
    assert.equal(saves().length, 3);
    assert.deepEqual(Object.keys(settings().columns), ["To Do", "In Progress", "Done"]);
    assert.equal(container.querySelectorAll(".board-column.is-collapsed").length, 3);
  } finally {
    act(() => root.unmount());
  }
});

test("a move without a picked column shows the one the board's own order finds first, whatever order the page shows", async () => {
  const columns = [{ value: "In Progress", title: "In Progress" }, { value: "Active", title: "Active" }];
  const { container, root } = await mount({ ...NO_SETTINGS, order: ["Active", "In Progress"] }, { ...board, columns, tasks: [] });
  try {
    assert.deepEqual(columnTitles(container), ["Active", "In Progress"]);
    await act(async () => click(button(container, "Board settings")));
    assert.equal(container.querySelectorAll<HTMLSelectElement>(".board-settings select")[1]?.value, "In Progress");
  } finally {
    act(() => root.unmount());
  }
});

test("the board settings and an open ticket share the dock, and Esc closes the settings", async () => {
  const { container, root, open } = await mount(NO_SETTINGS);
  const docks = () => [...container.querySelectorAll(".board-frame > .ticket-dock:not(.is-leaving)")].map((dock) => dock.classList.contains("is-settings"));
  try {
    await act(async () => click(button(container, "Board settings")));
    assert.deepEqual(docks(), [true]);
    await act(async () => click(container.querySelector('[data-testid="ticket-card"]')!));
    assert.deepEqual(docks(), [false], "a ticket takes the dock");
    await act(async () => click(button(container, "Board settings")));
    assert.deepEqual(docks(), [true], "the settings take it back");
    await act(async () => press(document.body, "Escape"));
    assert.deepEqual(docks(), []);
    await act(async () => click(button(container, "Board settings")));
    await open("APP-2");
    assert.deepEqual(docks(), [false], "a ticket opened from a link takes the dock too");
  } finally {
    act(() => root.unmount());
  }
});

test("a color on a board that keeps its own loads the board in full, past its activity stamp", async () => {
  const { container, root, saves, loads } = await mount(NO_SETTINGS, { ...board, capabilities: { columnColors: true }, activity: "a1" });
  try {
    const before = loads().length;
    await act(async () => click(button(container, "Color for To Do")));
    await act(async () => {
      click(button(container, "green"));
      await wait(20);
    });
    const painted = saves().findIndex((request) => request.path === "/api/board/lists");
    assert.deepEqual(saves()[painted]?.body, { cwd: "/repo", listId: "To Do", color: "green" });
    assert.deepEqual(loads().slice(before), ["/api/board/board?cwd=%2Frepo"], "one load follows the color, without the stamp");
  } finally {
    act(() => root.unmount());
  }
});

test("a refused save takes the board back to the settings the host has, also when the board itself did not change", async () => {
  const refuse = { on: true };
  const { container, root, settings } = await mount(NO_SETTINGS, { ...board, activity: "a1" }, undefined, refuse);
  const collapsed = () => [...container.querySelectorAll(".board-column.is-collapsed")].map((item) => item.getAttribute("data-testid"));
  try {
    await act(async () => {
      click(button(container, "Collapse Done"));
      await wait(20);
    });
    assert.deepEqual(collapsed(), [], "the refused collapse is gone");
    refuse.on = false;
    await act(async () => click(button(container, "Collapse To Do")));
    assert.deepEqual(collapsed(), ["column-To Do"]);
    assert.deepEqual(Object.keys(settings().columns), ["To Do"], "the next save leaves the refused change out");
  } finally {
    act(() => root.unmount());
  }
});
