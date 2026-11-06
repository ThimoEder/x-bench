import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { click, installDom, typeInto, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { CreateBoard } = await import("./CreateBoard.tsx");

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

const jiraBoards = [
  { id: 1, title: "Reporting API", project: "REP" },
  { id: 2, title: "vStores - Apps", project: "VS" },
  { id: 3, title: "Zeplin Requests", project: "DT" },
];

async function mount(call: (path: string, body?: unknown) => Promise<unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () =>
    root.render(createElement(CreateBoard, { cwd: "/repo", name: "mobile", call, onClose() {}, onCreated() {}, onSetup() {} })),
  );
  return container;
}

async function mountJira(boards: Promise<unknown>) {
  const container = await mount(async (path) => {
    if (path === "/api/jira/status") return { enabled: true, reachable: true };
    if (path === "/api/jira/boards") return boards;
    return { enabled: false };
  });
  await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent === "Jira")!));
  return container;
}

const titles = (container: HTMLElement) => [...container.querySelectorAll("[role=option] span:first-child")].map((span) => span.textContent);

test("the board list shows loading until it arrives, then filters by title or project key", async () => {
  let arrive: (list: unknown) => void = () => {};
  const container = await mountJira(new Promise((resolve) => {
    arrive = resolve;
  }));
  const list = container.querySelector("[role=listbox]")!;
  assert.equal(list.getAttribute("aria-label"), "Loading Jira boards");
  assert.equal(list.getAttribute("aria-busy"), "true");
  assert.equal(list.querySelectorAll(".sheet-skeleton").length, 5);

  await act(async () => {
    arrive(jiraBoards);
    await wait();
  });
  assert.deepEqual(titles(container), ["Reporting API", "vStores - Apps", "Zeplin Requests"]);
  assert.equal(list.querySelector(".sheet-skeleton"), null);

  const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => typeInto(search, "  apps "));
  assert.deepEqual(titles(container), ["vStores - Apps"]);
  await act(async () => typeInto(search, "dt"));
  assert.deepEqual(titles(container), ["Zeplin Requests"]);
  await act(async () => typeInto(search, "nothing"));
  assert.equal(list.textContent, "No Jira boards match “nothing”.");
});

test("a source whose check hangs leaves the other tabs ready", async () => {
  const container = await mount(async (path) => {
    if (path === "/api/sak/status") return { enabled: true, reachable: true };
    if (path === "/api/sak/projects") return [{ id: 3, title: "x_build" }];
    return new Promise(() => {});
  });
  await act(() => wait());
  assert.deepEqual(titles(container), ["x_build"]);
});

test("a pick the search hides cannot be matched, and comes back when the search shows it again", async () => {
  const bound: unknown[] = [];
  const container = await mount(async (path, body) => {
    if (path === "/api/sak/status") return { enabled: true, reachable: true };
    if (path === "/api/sak/projects") return [{ id: 1, title: "Alpha" }, { id: 2, title: "Beta" }];
    if (path === "/api/board/boards") bound.push(body);
    return { enabled: false };
  });
  const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
  const match = container.querySelector<HTMLButtonElement>("button[type=submit]")!;
  await act(async () => click(container.querySelector("[role=option]")!));
  assert.equal(match.disabled, false);

  await act(async () => typeInto(search, "beta"));
  assert.equal(match.disabled, true);
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.deepEqual(bound, []);

  await act(async () => typeInto(search, "al"));
  assert.equal(match.disabled, false);
});
