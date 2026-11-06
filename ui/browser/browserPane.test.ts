import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef } from "react";
import { installDom, wait } from "../testing/dom.ts";
import type { PanePicture, PaneRect } from "./browserPane.ts";

const dom = installDom();
// The desktop app's side, recording where the page puts the view and answering captures when told.
const sent: (PaneRect | null)[] = [];
let answer: ((shot: PanePicture) => void) | null = null;
Reflect.set(window, "xBenchDesktop", {
  browserBounds: (bounds: PaneRect | null) => sent.push(bounds),
  browserFreeze: () =>
    new Promise<PanePicture>((resolve) => {
      answer = resolve;
    }),
});
const { createRoot } = await import("react-dom/client");
const { paneRect, usePaneBounds } = await import("./browserPane.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

// happy-dom lays nothing out, so each element gets its box from its data-box.
HTMLElement.prototype.getBoundingClientRect = function () {
  const [x = 0, y = 0, width = 0, height = 0] = (this.dataset.box ?? "").split(" ").map(Number);
  return new window.DOMRect(x, y, width, height);
};
document.elementFromPoint = () => document.querySelector(".slot");
Object.defineProperty(window, "devicePixelRatio", { value: 2 });

const PANE = { x: 0, y: 0, width: 800, height: 600, radius: 0 };
const SHIFTED = { ...PANE, x: 0.4 };

test("a menu that overlaps the pane between its sample points hides it, and one beside it does not", () => {
  document.body.innerHTML = '<div class="slot" data-box="0 0 800 600"></div><div role="menu" data-box="700 500 200 60"></div>';
  const slot = document.querySelector<HTMLElement>(".slot")!;
  assert.equal(paneRect(slot), null);

  document.querySelector<HTMLElement>('[role="menu"]')!.dataset.box = "810 500 200 60";
  assert.deepEqual(paneRect(slot), PANE);
  document.body.innerHTML = "";
});

function Pane() {
  const slot = useRef<HTMLDivElement | null>(null);
  usePaneBounds(slot, "chat", true);
  return createElement("div", { className: "slot", "data-box": "0.4 0 800 600", ref: slot });
}

test("a menu over the pane gets a picture of the page laid under it before the view steps aside", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const slot = () => container.querySelector<HTMLElement>(".slot")!;
  try {
    await act(async () => root.render(createElement(Pane)));
    await wait(40);
    assert.deepEqual(sent.at(-1), SHIFTED);

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.dataset.box = "700 500 200 60";
    document.body.append(menu);
    await wait(40);
    assert.deepEqual(sent.at(-1), SHIFTED, "the view stays up while the capture runs");
    assert.ok(answer);

    answer({ src: "data:image/jpeg;base64,AAAA", x: 0, y: 0, width: 800, height: 600 });
    await wait(40);
    const still = (name: string) => slot().style.getPropertyValue(`--still${name}`);
    assert.match(still(""), /data:image\/jpeg;base64,AAAA/);
    assert.deepEqual([still("-x"), still("-y"), still("-width"), still("-height")], ["-0.5px", "0px", "800px", "600px"], "counted from the corner Chromium paints, rounded to device pixels");
    assert.equal(sent.at(-1), null);

    menu.remove();
    await wait(40);
    assert.deepEqual(sent.at(-1), SHIFTED);
    assert.notEqual(still(""), "", "the picture stays under the view while it comes back");
    await wait(200);
    assert.equal(still(""), "", "then comes off, so a smaller pane shows none of it");

    answer = null;
    document.body.append(menu);
    await wait(40);
    menu.remove();
    await wait(40);
    answer!({ src: "data:image/jpeg;base64,BBBB", x: 0, y: 0, width: 800, height: 600 });
    await wait(40);
    assert.equal(still(""), "", "a capture that lands after the menu closed is dropped");
    assert.deepEqual(sent.at(-1), SHIFTED);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
