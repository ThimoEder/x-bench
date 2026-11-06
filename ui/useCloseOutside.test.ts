import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { installDom, press } from "./testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { useCloseOutside } = await import("./useCloseOutside.ts");

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

async function mount(open: boolean) {
  let closed = 0;
  function Menu() {
    const root = useRef<HTMLDivElement | null>(null);
    useCloseOutside(open, root, () => closed++);
    return createElement("div", { ref: root }, createElement("button", { id: "inside" }));
  }
  const outside = document.createElement("p");
  const container = document.createElement("div");
  document.body.append(outside, container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Menu)));
  const pointerDown = (target: Element) => target.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  return { outside, inside: document.getElementById("inside")!, pointerDown, closed: () => closed };
}

test("an open menu closes on a pointer down outside it or on Esc, and stays open for one inside it", async () => {
  const menu = await mount(true);
  menu.pointerDown(menu.inside);
  assert.equal(menu.closed(), 0);
  menu.pointerDown(menu.outside);
  assert.equal(menu.closed(), 1);
  press(menu.inside, "Escape");
  assert.equal(menu.closed(), 2);
  press(menu.inside, "Enter");
  assert.equal(menu.closed(), 2);
});

test("a closed menu ignores pointer downs and Esc", async () => {
  const menu = await mount(false);
  menu.pointerDown(menu.outside);
  press(menu.outside, "Escape");
  assert.equal(menu.closed(), 0);
});
