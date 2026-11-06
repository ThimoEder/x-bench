import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, typeInto, wait } from "../testing/dom.ts";
import type { BoardLabel, BoardView } from "./boardData.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { LabelSheet } = await import("./LabelSheet.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const noop = () => {};

async function mount(capabilities: Record<string, unknown>, taskId: unknown = null) {
  const calls: [string, unknown, string | undefined][] = [];
  const added: BoardLabel[] = [];
  const saved: unknown[] = [];
  const deleted: BoardLabel[] = [];
  const board: BoardView = { provider: "sak", source: "SAK", capabilities: { labels: true, ...capabilities }, columns: [], tasks: [], labels: [{ id: 1, title: "bug", color: null }] };
  const call = async (path: string, body?: unknown, method?: string) => {
    calls.push([path, body, method]);
    if (method !== "POST") return { ok: true };
    return { label: { id: 3, title: "ui", color: "#0079bf" }, task: taskId === null ? null : { id: taskId, title: "Ship it", labels: [{ id: 3, title: "ui" }] } };
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(LabelSheet, {
        board,
        cwd: "/repo",
        call,
        taskId,
        onAdded: (label: BoardLabel, task: unknown) => {
          added.push(label);
          saved.push(task);
        },
        onDeleted: (label: BoardLabel) => deleted.push(label),
        onClose: noop,
      }),
    ),
  );
  const submit = async (name: string) => {
    act(() => typeInto(container.querySelector<HTMLInputElement>('input[aria-label="New label"]')!, name));
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
      await wait(0);
    });
  };
  return { container, root, calls, added, saved, deleted, submit };
}

test("a new label goes to the board with the color picked for it, a taken name is refused, and a delete asks first", async () => {
  const { container, root, calls, added, deleted, submit } = await mount({ standaloneLabels: true, labelColors: true, labelDeletes: true });
  try {
    act(() => click(container.querySelector('button[aria-label="Color for the new label"]')!));
    act(() => click(container.querySelector('[role="option"][aria-label="blue"]')!));
    await submit("ui");
    assert.deepEqual(calls, [["/api/board/labels", { cwd: "/repo", title: "ui", color: "#0079bf" }, "POST"]]);
    assert.deepEqual(added.map((label) => label.title), ["ui"]);

    await submit("bug");
    assert.equal(calls.length, 1);
    assert.match(container.querySelector(".sheet-error")?.textContent ?? "", /already a label/);

    act(() => click(container.querySelector('button[aria-label="Delete bug"]')!));
    assert.equal(calls.length, 1, "the trash button only asks");
    await act(async () => {
      click(container.querySelector("button.danger-fill")!);
      await wait(0);
    });
    assert.deepEqual(calls[1], ["/api/board/labels/1", { cwd: "/repo" }, "DELETE"]);
    assert.deepEqual(deleted.map((label) => label.id), [1]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a board that takes no colors and keeps its labels adds a label by name only", async () => {
  const { container, root, calls, submit } = await mount({ standaloneLabels: true });
  try {
    assert.equal(container.querySelector('button[aria-label="Color for the new label"]'), null);
    assert.equal(container.querySelector('button[aria-label="Delete bug"]'), null);
    await submit("ui");
    assert.deepEqual(calls, [["/api/board/labels", { cwd: "/repo", title: "ui", color: null }, "POST"]]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("where a label lives only on tickets, the sheet adds one only from a ticket, and puts it on that ticket", async () => {
  const away = await mount({});
  try {
    assert.equal(away.container.querySelector('input[aria-label="New label"]'), null);
    assert.match(away.container.textContent ?? "", /from a ticket/);
  } finally {
    act(() => away.root.unmount());
    away.container.remove();
  }
  const { container, root, calls, saved, submit } = await mount({}, "APP-1");
  try {
    await submit("ui");
    assert.deepEqual(calls, [["/api/board/labels", { cwd: "/repo", title: "ui", color: null, taskId: "APP-1" }, "POST"]]);
    assert.deepEqual(saved, [{ id: "APP-1", title: "Ship it", labels: [{ id: 3, title: "ui" }] }]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the new label's name and color stay put while the label saves", async () => {
  let answer: (value: unknown) => void = () => {};
  const calls: unknown[] = [];
  const board: BoardView = { provider: "sak", source: "SAK", capabilities: { labels: true, standaloneLabels: true, labelColors: true }, columns: [], tasks: [], labels: [] };
  const call = (_path: string, body?: unknown) => {
    calls.push(body);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(LabelSheet, { board, cwd: "/repo", call, taskId: null, onAdded: noop, onDeleted: noop, onClose: noop })));
  try {
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="New label"]')!;
    const swatch = () => container.querySelector<HTMLButtonElement>('button[aria-label="Color for the new label"]')!;
    act(() => click(swatch()));
    act(() => typeInto(input(), "ui"));
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
      await wait(0);
    });
    assert.equal(calls.length, 1);
    assert.equal(input().readOnly, true, "no new name while the label saves");
    assert.equal(swatch().disabled, true, "no new color while the label saves");
    assert.equal(container.querySelector(".label-palette"), null, "the swatches close as the save starts");
    await act(async () => {
      answer({ label: { id: 3, title: "ui", color: null }, task: null });
      await wait(0);
    });
    assert.equal(input().readOnly, false);
    assert.equal(input().value, "");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
