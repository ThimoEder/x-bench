import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef } from "react";
import { installDom } from "./testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { nearestStop, slideThumb, useThumb } = await import("./useThumb.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

test("a released thumb lands on the nearest stop", () => {
  assert.equal(nearestStop([3, 43], 10), 0);
  assert.equal(nearestStop([3, 43], 30), 1);
  assert.equal(nearestStop([8, 50, 92], 92), 2);
});

test("a render while the thumb is dragged leaves it under the pointer", async () => {
  const picks: string[] = [];
  function Switch({ picked }: { picked: string; tick: number }) {
    const track = useRef<HTMLDivElement>(null);
    useThumb(track, "x", `[data-side="${picked}"]`);
    return createElement(
      "div",
      { ref: track, onPointerDown: (event: React.PointerEvent<HTMLElement>) => slideThumb(event, "x", ":scope > button", (button) => picks.push(button.dataset.side ?? "")) },
      createElement("button", { "data-side": "a" }),
      createElement("button", { "data-side": "b" }),
      createElement("span", { "data-thumb": true }),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const place = (button: Element, left: number) => {
    for (const [key, value] of Object.entries({ offsetLeft: left, offsetTop: 3, offsetWidth: 40, offsetHeight: 28 })) Object.defineProperty(button, key, { value });
  };
  try {
    await act(async () => root.render(createElement(Switch, { picked: "b", tick: 0 })));
    const [a, b] = [...container.querySelectorAll("button")];
    place(a!, 3);
    place(b!, 43);
    await act(async () => root.render(createElement(Switch, { picked: "b", tick: 1 })));
    const thumb = container.querySelector<HTMLElement>("[data-thumb]")!;
    assert.equal(thumb.style.getPropertyValue("--x"), "43px");
    thumb.getBoundingClientRect = () => ({ left: 43, right: 83, top: 3, bottom: 31 }) as DOMRect;
    const track = container.firstElementChild!;
    track.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 60, clientY: 16 }));
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 30, clientY: 16 }));
    assert.equal(thumb.style.getPropertyValue("--x"), "13px");
    await act(async () => root.render(createElement(Switch, { picked: "b", tick: 2 })));
    assert.equal(thumb.style.getPropertyValue("--x"), "13px");
    window.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 30, clientY: 16 }));
    assert.deepEqual(picks, ["a"]);
    assert.equal(thumb.style.getPropertyValue("--x"), "3px");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a new thumb waits hidden over its button and lands there without sliding", async () => {
  function Rail({ shown }: { shown: boolean }) {
    const track = useRef<HTMLDivElement>(null);
    useThumb(track, "y", '[data-tab="files"]', shown);
    return createElement(
      "div",
      { ref: track },
      createElement("button", { "data-tab": "changes", "data-top": "8" }),
      createElement("button", { "data-tab": "files", "data-top": "54" }),
      createElement("span", { "data-thumb": true }),
    );
  }
  const offsetTop = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetTop");
  Object.defineProperty(window.HTMLElement.prototype, "offsetTop", { configurable: true, get(this: HTMLElement) { return Number(this.dataset.top ?? 0); } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let styles: string[] = [];
  const watch = new window.MutationObserver((records) => styles.push(...records.map((record) => record.oldValue ?? "")));
  watch.observe(container, { subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  try {
    await act(async () => root.render(createElement(Rail, { shown: false })));
    const thumb = container.querySelector<HTMLElement>("[data-thumb]")!;
    assert.equal(thumb.dataset.thumb, "off");
    assert.equal(thumb.style.getPropertyValue("--y"), "54px");
    assert.equal(thumb.style.transition, "");
    assert.ok(styles.some((style) => style.includes("transition: none")));
    styles = [];
    await act(async () => root.render(createElement(Rail, { shown: true })));
    assert.equal(thumb.dataset.thumb, "on");
    assert.ok(styles.every((style) => !style.includes("transition: none")));
  } finally {
    watch.disconnect();
    await act(async () => root.unmount());
    container.remove();
    if (offsetTop) Object.defineProperty(window.HTMLElement.prototype, "offsetTop", offsetTop);
  }
});
