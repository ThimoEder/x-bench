import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { PlanEntry } from "../../bridge/protocol.ts";
import { click, installDom } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { PlanShelf } = await import("./PlanShelf.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const STEPS: PlanEntry[] = [
  { content: "Read the code", status: "completed" },
  { content: "Adding the list", status: "in_progress" },
  { content: "Run the tests", status: "pending" },
];

async function render(sessionId: string, steps: PlanEntry[], running = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (next: PlanEntry[], nextRunning = running) =>
    act(async () => root.render(createElement(PlanShelf, { sessionId, steps: next, running: nextRunning })));
  await show(steps);
  return { container, show, unmount: () => act(() => root.unmount()) };
}

test("the shelf shows the current step and the progress, and the whole list when opened", async () => {
  const shelf = await render("a", STEPS);
  const toggle = shelf.container.querySelector(".shelf-plan-toggle")!;
  assert.match(toggle.textContent ?? "", /Adding the list.*1\/3/);
  assert.equal(toggle.getAttribute("aria-label"), "Adding the list, 1 of 3 steps done");
  const body = shelf.container.querySelector(".shelf-plan-body")!;
  assert.equal(body.hasAttribute("inert"), true);
  await act(async () => click(toggle));
  assert.equal(body.hasAttribute("inert"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(body.querySelectorAll('[data-testid="plan-steps"] li').length, 3);
  await shelf.unmount();
});

const DONE = STEPS.map((step) => ({ ...step, status: "completed" }));

test("a hidden plan stays hidden until the agent changes it, and the hiding ends there", async () => {
  const shelf = await render("b", STEPS);
  await act(async () => click(shelf.container.querySelector('[aria-label="Hide the plan"]')!));
  assert.equal(shelf.container.querySelector('[data-testid="shelf-plan"]'), null);
  await shelf.unmount();
  const again = await render("b", STEPS);
  assert.equal(again.container.querySelector('[data-testid="shelf-plan"]'), null);
  await again.show(DONE);
  assert.match(again.container.textContent ?? "", /All 3 steps done/);
  await again.show(STEPS);
  assert.ok(again.container.querySelector('[data-testid="shelf-plan"]'));
  await again.unmount();
});

test("a finished plan goes when its turn ends, and an unfinished one stays", async () => {
  const shelf = await render("c", DONE);
  assert.ok(shelf.container.querySelector('[data-testid="shelf-plan"]'));
  await shelf.show(DONE, false);
  assert.equal(shelf.container.querySelector('[data-testid="shelf-plan"]'), null);
  await shelf.show(STEPS, false);
  assert.ok(shelf.container.querySelector('[data-testid="shelf-plan"]'));
  await shelf.unmount();
});
