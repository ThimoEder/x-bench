import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { MarkdownView } = await import("../chat/markdown/MarkdownView.tsx");

const realFetch = globalThis.fetch;
const mounted: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
});

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const BOARD = {
  columns: [{ value: "ideas", title: "Ideas" }, { value: "qa", title: "QA", color: "#b07cff" }, { value: "shipped", title: "Shipped" }],
  tasks: [
    { id: 365, title: "Move host logic behind the provider contract", description: "The host reads session files itself.", attributes: { status: "qa" }, labels: [{ id: "p1", title: "P1" }], relations: [{ task_id: 366, kind: "blocked_by" }], subtaskCount: { done: 2, total: 5 } },
    { id: 366, title: "Publish neutral tool roles", attributes: { status: "ideas" }, labels: [] },
    { id: "6aeb8756b33144ca56dcc521", reference: 42, title: "Add a privacy policy", attributes: { status: "ideas" }, labels: [] },
  ],
};

async function render(text: string) {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    if (path === "/api/board/board") return new Response(JSON.stringify(BOARD));
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(MarkdownView, { text }));
  });
  await act(() => wait(10));
  return container;
}

const link = (task: number | string) => `http://127.0.0.1:8797/?cwd=%2Fwork%2Fapp&task=${task}`;

test("a board link carries its column's color, a column without one a dotted ring, and other links stay plain", async () => {
  const view = await render(`[365](${link(365)}), [366](${link(366)}), [404](${link(404)}) and [docs](https://example.com)`);
  const [colored, plain, gone] = [...view.querySelectorAll("a.ticket-link")];
  assert.equal(colored?.textContent, "365");
  assert.equal(colored?.querySelector<SVGElement>(".ticket-ring")?.style.color, "#b07cff");
  assert.ok(plain?.querySelector(".ticket-ring.is-plain circle[stroke-dasharray]"));
  assert.ok(gone?.classList.contains("is-gone"));
  assert.equal(view.querySelector('a[href="https://example.com"]')?.classList.contains("ticket-link"), false);
});

test("hovering a board link shows the ticket with its column, and Esc hides it", async () => {
  const view = await render(`See [365](${link(365)}).`);
  const anchor = view.querySelector("a.ticket-link");
  assert.ok(anchor);
  await act(async () => {
    anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    await wait(320);
  });
  const card = document.querySelector('[data-testid="ticket-hover"]');
  assert.ok(card, "the card opens after the hover delay");
  assert.match(card.textContent ?? "", /Move host logic behind the provider contract/);
  assert.match(card.textContent ?? "", /QA · 2 of 3/);
  assert.match(card.textContent ?? "", /P1/);
  assert.match(card.textContent ?? "", /2 of 5 done/);
  assert.match(card.textContent ?? "", /blocked by#366 Publish neutral tool roles/);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    document.body.dispatchEvent(escape);
  });
  assert.equal(document.querySelector('[data-testid="ticket-hover"]'), null);
  assert.equal(escape.defaultPrevented, true, "the board's Esc leaves an open ticket alone");
});

test("a ticket link written as a bare address reads as the ticket's id", async () => {
  const view = await render("It's in QA: http://127.0.0.1:8797/?cwd=/work/app&task=365");
  const anchor = view.querySelector("a.ticket-link");
  assert.equal(anchor?.textContent, "#365");
  assert.equal(anchor?.getAttribute("href"), "http://127.0.0.1:8797/?cwd=/work/app&task=365");
  assert.ok(anchor?.querySelector(".ticket-ring"));
});

test("a ticket link written as its long id reads as the number the board shows", async () => {
  const view = await render(`Created [#6aeb8756b33144ca56dcc521](${link("6aeb8756b33144ca56dcc521")}).`);
  assert.equal(view.querySelector("a.ticket-link")?.textContent, "#42");
});
