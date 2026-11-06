import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Device } from "../../server/devices/deviceMath.ts";
import { click, installDom, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { DevicePicker, sortStartable } = await import("./DevicePicker.tsx");
type StartableDevice = import("./DevicePicker.tsx").StartableDevice;

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const RUNNING: Device[] = [
  { id: "sim-1", platform: "ios", name: "iPhone 17 Pro · iOS 26.2", state: "booted" },
  { id: "emulator-5554", platform: "android", name: "Medium Phone API 36.1", state: "device" },
];

const STARTABLE: StartableDevice[] = [
  { id: "sim-old", platform: "ios", name: "iPhone 15", os: "iOS 18.6" },
  { id: "avd:Pixel_9", platform: "android", name: "Pixel 9", os: "Android" },
  { id: "sim-new", platform: "ios", name: "iPad Air", os: "iOS 26.2" },
  { id: "sim-new-2", platform: "ios", name: "iPhone 17", os: "iOS 26.2" },
];

async function render(onSelect: (id: string) => void, onStart: (device: StartableDevice) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(DevicePicker, { devices: RUNNING, selectedId: "sim-1", starting: null, onSelect, onStart, loadStartable: async () => sortStartable(STARTABLE) }));
  });
  return {
    container,
    names: (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent?.trim() ?? ""),
    unmount: () => act(async () => root.unmount()),
  };
}

test("iOS simulators sort newest system first, then by name, before the emulators", () => {
  assert.deepEqual(
    sortStartable(STARTABLE).map((device) => device.id),
    ["sim-new", "sim-new-2", "sim-old", "avd:Pixel_9"],
  );
});

test("the menu lists the running devices, then a Start submenu per platform", async () => {
  const picked: string[] = [];
  const started: string[] = [];
  const view = await render(
    (id) => picked.push(id),
    (device) => started.push(device.id),
  );
  const trigger = view.container.querySelector<HTMLElement>(".device-picker")!;
  assert.equal(trigger.textContent?.trim(), "iPhone 17 Pro · iOS 26.2");
  await act(async () => click(trigger));
  await act(async () => wait(10));
  assert.deepEqual(view.names('[role="menuitemradio"]'), ["iPhone 17 Pro · iOS 26.2", "Medium Phone API 36.1"]);
  assert.ok(view.container.querySelector(".device-menu-line"), "no line between running and Start");
  assert.deepEqual(view.names('.device-menu-start > [role="menuitem"]'), ["Start iOS Simulator", "Start Android Emulator"]);

  await act(async () => click(view.container.querySelector<HTMLElement>('.device-menu-start > [role="menuitem"]')!));
  // The submenu is drawn on the page's body, outside the dock.
  const submenu = () => [...document.querySelectorAll<HTMLElement>(".device-submenu button")];
  assert.deepEqual(submenu().map((node) => node.textContent?.trim()), ["iPad AiriOS 26.2", "iPhone 17iOS 26.2", "iPhone 15iOS 18.6"]);
  await act(async () => click(submenu()[1]!));
  assert.deepEqual(started, ["sim-new-2"]);
  assert.equal(view.container.querySelector(".device-menu-list"), null);
  assert.equal(document.querySelector(".device-submenu"), null);

  await act(async () => click(trigger));
  await act(async () => wait(10));
  await act(async () => click(view.container.querySelector<HTMLElement>('[role="menuitemradio"][data-device="emulator-5554"]')!));
  assert.deepEqual(picked, ["emulator-5554"]);
  await view.unmount();
});
