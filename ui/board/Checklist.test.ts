import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Checklist, DetailTask } from "./boardData.ts";
import { click, installDom, typeInto, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { ChecklistSection, saveQueue } = await import("./Checklist.tsx");

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

const launch: Checklist = {
  id: "list1",
  title: "Launch",
  items: [{ id: "item1", title: "Write copy", done: true }, { id: "item2", title: "Translate", done: false }],
};

type Calls = [string, unknown, string | undefined][];

async function mount(reply: (path: string, body: unknown) => Promise<unknown>) {
  const calls: Calls = [];
  const changed: DetailTask[] = [];
  const errors: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const call = async (path: string, body?: unknown, method?: string) => {
    calls.push([path, body, method]);
    return reply(path, body);
  };
  await act(async () => root.render(createElement(ChecklistSection, {
    taskId: "a".repeat(24),
    list: launch,
    call,
    queue: saveQueue(),
    onChanged: (task) => changed.push(task),
    onError: (message) => errors.push(message),
  })));
  const box = (name: string) => [...container.querySelectorAll("[role=checkbox]")].find((item) => item.textContent?.includes(name)) as Element;
  return { container, calls, changed, errors, box };
}

test("a checklist shows its progress, and a ticked item saves and shows at once", async () => {
  let finish: (value: unknown) => void = () => {};
  const view = await mount(() => new Promise((resolve) => { finish = resolve; }));
  assert.match(view.container.querySelector(".ticket-h")?.textContent ?? "", /Launch1 of 2 done/);
  await act(async () => click(view.box("Translate")));
  assert.equal(view.box("Translate").getAttribute("aria-checked"), "true");
  assert.deepEqual(view.calls, [[`/api/board/tasks/${"a".repeat(24)}/check-items/item2`, { done: true }, "PUT"]]);
  await act(async () => click(view.box("Translate")));
  assert.equal(view.calls.length, 1, "a second click waits for the save");
  await act(async () => finish({ task: { id: "a".repeat(24), checkCount: { done: 2, total: 2 } } }));
  await act(async () => wait(10));
  assert.deepEqual(view.changed, [{ id: "a".repeat(24), checkCount: { done: 2, total: 2 } }]);
});

test("a second tick waits for the first save, so the later reply lands last", async () => {
  const replies: ((value: unknown) => void)[] = [];
  const view = await mount(() => new Promise((resolve) => { replies.push(resolve); }));
  const snapshot = (done: number) => ({ task: { id: "a".repeat(24), checkCount: { done, total: 2 } } });
  await act(async () => click(view.box("Translate")));
  await act(async () => click(view.box("Write copy")));
  assert.equal(view.calls.length, 1, "the second save waits");
  assert.equal(view.box("Write copy").getAttribute("aria-checked"), "false", "the second tick still shows at once");
  await act(async () => {
    replies[0]?.(snapshot(2));
    await wait(10);
  });
  assert.equal(view.calls.length, 2);
  assert.deepEqual(view.calls[1], [`/api/board/tasks/${"a".repeat(24)}/check-items/item1`, { done: false }, "PUT"]);
  await act(async () => {
    replies[1]?.(snapshot(1));
    await wait(10);
  });
  assert.deepEqual(view.changed.map((task) => task.checkCount), [{ done: 2, total: 2 }, { done: 1, total: 2 }]);
});

test("a failed tick goes back and says why", async () => {
  const view = await mount(async () => {
    throw new Error("Trello is not reachable");
  });
  await act(async () => click(view.box("Write copy")));
  await act(async () => wait(10));
  assert.equal(view.box("Write copy").getAttribute("aria-checked"), "true");
  assert.deepEqual(view.errors, ["Trello is not reachable"]);
});

test("an item is added to the checklist", async () => {
  const view = await mount(async () => ({ task: { id: "a".repeat(24) } }));
  await act(async () => click(view.container.querySelector(".ticket-check-add") as Element));
  const input = view.container.querySelector("input") as HTMLInputElement;
  await act(async () => typeInto(input, "Announce"));
  await act(async () => {
    input.form?.requestSubmit();
    await wait(10);
  });
  assert.deepEqual(view.calls, [[`/api/board/tasks/${"a".repeat(24)}/checklists/list1/items`, { title: "Announce" }, "POST"]]);
  assert.equal((view.container.querySelector("input") as HTMLInputElement).value, "");
});
