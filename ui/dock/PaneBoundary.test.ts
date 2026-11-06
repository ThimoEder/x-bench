import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { PaneBoundary } = await import("./PaneBoundary.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

let broken = true;

function Pane({ name }: { name: string }) {
  if (broken && name === "session") throw new Error("Cannot read the transcript");
  return createElement("p", { className: "pane" }, name);
}

function panes(resetKey: string) {
  return [
    createElement(PaneBoundary, { key: "sidebar", label: "The sidebar" }, createElement(Pane, { name: "sidebar" })),
    createElement(PaneBoundary, { key: "session", label: "This session", resetKey }, createElement(Pane, { name: "session" })),
  ];
}

test("a render error stays in its pane and Try again draws it again", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const caught: unknown[] = [];
  const root = createRoot(container, { onCaughtError: (error) => caught.push(error) });

  await act(async () => root.render(panes("one")));
  assert.deepEqual([...container.querySelectorAll(".pane")].map((node) => node.textContent), ["sidebar"]);
  const fallback = container.querySelector("[data-testid=pane-error]");
  assert.equal(fallback?.querySelector(".pane-error-title")?.textContent, "This session could not be shown.");
  assert.equal(fallback?.querySelector(".pane-error-detail")?.textContent, "Cannot read the transcript");
  assert.equal(caught.length, 1);

  broken = false;
  const retry = fallback?.querySelector("button");
  assert.ok(retry);
  await act(async () => click(retry));
  assert.deepEqual([...container.querySelectorAll(".pane")].map((node) => node.textContent), ["sidebar", "session"]);
  assert.equal(container.querySelector("[data-testid=pane-error]"), null);

  await act(async () => root.unmount());
  container.remove();
});

test("a new reset key clears the error without a Try again", async () => {
  broken = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container, { onCaughtError: () => {} });

  await act(async () => root.render(panes("one")));
  assert.ok(container.querySelector("[data-testid=pane-error]"));

  broken = false;
  await act(async () => root.render(panes("two")));
  assert.equal(container.querySelector("[data-testid=pane-error]"), null);
  assert.deepEqual([...container.querySelectorAll(".pane")].map((node) => node.textContent), ["sidebar", "session"]);

  await act(async () => root.unmount());
  container.remove();
});
