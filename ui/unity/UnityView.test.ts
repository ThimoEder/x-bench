import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { UnityView } = await import("./UnityView.tsx");

// happy-dom lays nothing out, so the slot gets a box, and whatever covers it is set here.
let cover: Element | null = null;
HTMLElement.prototype.getBoundingClientRect = function () {
  return this.classList.contains("unity-slot") ? new window.DOMRect(0, 0, 800, 600) : new window.DOMRect(0, 0, 0, 0);
};
document.elementFromPoint = () => cover ?? document.querySelector(".unity-slot");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const STATS = { connected: true, fps: 120, frames: 1, width: 800, height: 600, inputMs: 0, project: "/work/game" };

// The desktop app's side, recording the keys and touches the view sends to Unity.
function installBridge(stats: object = STATS) {
  const keys: string[] = [];
  Reflect.set(window, "xBenchDesktop", {
    unityBounds() {},
    unityFolder() {},
    onUnityStats: (listener: (value: object) => void) => {
      listener(stats);
      return () => {};
    },
    unityPointer: (_x: number, _y: number, action: string) => keys.push(`touch ${action}`),
    unityKey: (key: string, action: string) => keys.push(`${key} ${action}`),
    unityFullScreen: () => () => {},
  });
  return keys;
}

async function render(visible = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (next: boolean) => act(async () => root.render(createElement(UnityView, { visible: next, cwd: "/work" })));
  await show(visible);
  return {
    slot: () => document.querySelector<HTMLElement>(".unity-slot")!,
    button: (label: string) => document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!,
    show,
    unmount: () => act(async () => root.unmount()),
  };
}

function key(target: Element, type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...init }));
}

test("a key held when the view closes or hides is let go in the game", async () => {
  const keys = installBridge();
  const view = await render();
  await act(async () => key(view.slot(), "keydown", "KeyW"));
  await view.show(false);
  assert.deepEqual(keys, ["W down", "W up"]);

  await view.show(true);
  await act(async () => key(view.slot(), "keydown", "KeyD"));
  await view.unmount();
  assert.deepEqual(keys, ["W down", "W up", "D down", "D up"]);
});

test("a key let go while Command is down still ends in the game, and Command shortcuts stay out of it", async () => {
  const keys = installBridge();
  const view = await render();
  await act(async () => key(view.slot(), "keydown", "KeyW"));
  await act(async () => key(view.slot(), "keyup", "KeyW", { metaKey: true }));
  await act(async () => key(view.slot(), "keydown", "KeyC", { metaKey: true }));
  await act(async () => key(view.slot(), "keydown", "KeyW"));
  assert.deepEqual(keys, ["W down", "W up", "W down"]);
  await view.unmount();
});

test("Esc leaves fill window without reaching the game, and keys held there are let go", async () => {
  const keys = installBridge();
  const view = await render();
  await act(async () => click(view.button("Fill the window")));
  assert.ok(document.querySelector(".unity-view.is-window"));
  await act(async () => key(view.slot(), "keydown", "KeyA"));
  await act(async () => key(view.slot(), "keydown", "Escape"));
  assert.equal(document.querySelector(".unity-view.is-window"), null);
  await act(async () => key(document.body, "keyup", "Escape"));
  assert.deepEqual(keys, ["A down", "A up"]);
  await view.unmount();
});

function pointer(target: Element, type: string) {
  target.dispatchEvent(new window.PointerEvent(type, { pointerId: 1, clientX: 10, clientY: 10, bubbles: true }));
}

test("a finger held when the view leaves fill window or hides is lifted in the game", async () => {
  const keys = installBridge();
  const view = await render();
  await act(async () => click(view.button("Fill the window")));
  await act(async () => pointer(view.slot(), "pointerdown"));
  await act(async () => key(view.slot(), "keydown", "Escape"));
  assert.deepEqual(keys, ["touch down", "touch up"]);

  await act(async () => pointer(view.slot(), "pointerdown"));
  await view.show(false);
  assert.deepEqual(keys, ["touch down", "touch up", "touch down", "touch up"]);
  await view.unmount();
});

test("switching to another app lets go of the game's keys and finger", async () => {
  const keys = installBridge();
  const view = await render();
  await act(async () => pointer(view.slot(), "pointerdown"));
  await act(async () => key(view.slot(), "keydown", "KeyW"));
  await act(async () => window.dispatchEvent(new Event("blur")));
  assert.deepEqual(keys, ["touch down", "W down", "W up", "touch up"]);
  await view.unmount();
});

test("without the desktop app's addon the tab says how to build it", async () => {
  installBridge({ missing: true });
  const view = await render();
  assert.match(document.querySelector(".unity-status")?.textContent ?? "", /desktop\/unity\/unity-view\/build\.sh/);
  await view.unmount();
});

test("a covered view lets go of the game's keys and finger, and takes no input until it shows again", async () => {
  const keys = installBridge();
  const view = await render();
  await act(async () => pointer(view.slot(), "pointerdown"));
  await act(async () => key(view.slot(), "keydown", "KeyW"));
  cover = document.body;
  await act(async () => wait(50));
  await act(async () => key(view.slot(), "keydown", "KeyD"));
  await act(async () => pointer(view.slot(), "pointerdown"));
  assert.deepEqual(keys, ["touch down", "W down", "W up", "touch up"]);

  cover = null;
  await act(async () => wait(50));
  await act(async () => key(view.slot(), "keydown", "KeyD"));
  assert.deepEqual(keys.slice(4), ["D down"]);
  await view.unmount();
});
