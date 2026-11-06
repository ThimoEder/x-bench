import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installDom } from "../testing/dom.ts";
import { dragOffset, settlesOpen } from "./panelDrag.ts";

test("a closed sidebar follows the finger in from the left, up to its open place", () => {
  assert.equal(dragOffset("left", false, 400, 100), -300);
  assert.equal(dragOffset("left", false, 400, 500), 0);
  assert.equal(dragOffset("left", false, 400, -50), -400);
});

test("an open dock follows the finger out to the right, up to its closed place", () => {
  assert.equal(dragOffset("right", true, 400, 120), 120);
  assert.equal(dragOffset("right", true, 400, 900), 400);
  assert.equal(dragOffset("right", true, 400, -40), 0);
});

test("a panel opens past a quarter of its width, or on a flick", () => {
  assert.equal(settlesOpen("left", false, 400, 120, 0), true);
  assert.equal(settlesOpen("left", false, 400, 60, 0), false);
  assert.equal(settlesOpen("left", false, 400, 40, 0.8), true);
  assert.equal(settlesOpen("right", false, 400, -120, 0), true);
});

test("a panel closes the same way, and a drag back toward open keeps it open", () => {
  assert.equal(settlesOpen("left", true, 400, -150, 0), false);
  assert.equal(settlesOpen("right", true, 400, 30, 0.9), false);
  assert.equal(settlesOpen("right", true, 400, -80, 0), true);
});

test("a flick back wins over the distance already moved", () => {
  assert.equal(settlesOpen("left", false, 400, 150, -0.5), false);
  assert.equal(settlesOpen("right", true, 400, 200, -0.6), true);
});

const dom = installDom();
Reflect.set(window, "matchMedia", () => ({ matches: true }));
const { watchDrags } = await import("./panelDrag.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function touch(type: string, target: Element, xs: number[]) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const list = xs.map((x) => ({ clientX: x, clientY: 400 }));
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
  Object.defineProperty(event, "changedTouches", { value: list });
  target.dispatchEvent(event);
}

test("a second finger puts a dragged panel back where it was", () => {
  const element = document.createElement("aside");
  document.body.append(element);
  const settled: boolean[] = [];
  const stop = watchDrags(() => ({ element, side: "left", open: false, settle: (open) => settled.push(open) }));
  try {
    touch("touchstart", document.body, [200]);
    touch("touchmove", document.body, [320]);
    assert.ok(element.classList.contains("is-dragging"));
    assert.notEqual(element.style.transform, "");
    touch("touchstart", document.body, [320, 100]);
    assert.deepEqual(settled, [false]);
    assert.equal(element.classList.contains("is-dragging"), false);
    assert.equal(element.style.transform, "");
  } finally {
    stop();
  }
});

test("content that can still scroll sideways keeps a swipe away from the edges", () => {
  const scroller = document.createElement("div");
  scroller.style.overflowX = "auto";
  Object.defineProperty(scroller, "scrollWidth", { value: 800 });
  Object.defineProperty(scroller, "clientWidth", { value: 300 });
  scroller.scrollLeft = 100;
  document.body.append(scroller);
  let picked = 0;
  const stop = watchDrags(() => {
    picked += 1;
    return null;
  });
  try {
    touch("touchstart", scroller, [200]);
    touch("touchmove", scroller, [320]);
    assert.equal(picked, 0);
    touch("touchend", scroller, [320]);
    touch("touchstart", document.body, [200]);
    touch("touchmove", document.body, [320]);
    assert.equal(picked, 1);
  } finally {
    stop();
  }
});

test("a control with its own drag, like the Chat/Builder switch, keeps a swipe away from the edges", () => {
  const control = document.createElement("div");
  control.style.touchAction = "none";
  const button = document.createElement("button");
  control.append(button);
  document.body.append(control);
  let picked = 0;
  const stop = watchDrags(() => {
    picked += 1;
    return null;
  });
  try {
    touch("touchstart", button, [200]);
    touch("touchmove", button, [100]);
    assert.equal(picked, 0);
    touch("touchend", button, [100]);
    touch("touchstart", button, [4]);
    touch("touchmove", button, [120]);
    assert.equal(picked, 1);
  } finally {
    stop();
    control.remove();
  }
});
