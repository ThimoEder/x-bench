import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom } from "../testing/dom.ts";
import type { UpdateBridge, UpdateState } from "./UpdateCard.tsx";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { UpdateCard } = await import("./UpdateCard.tsx");

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

const RELEASE = { version: "0.0.2", size: 182_000_000, notes: ["The review panel remembers its width for each chat."] };

// A stand-in for the desktop app's updater: it records the page's calls, and send() plays its state changes.
function fakeBridge() {
  const calls: string[] = [];
  let listener: ((state: UpdateState) => void) | null = null;
  const bridge: UpdateBridge = {
    updateCheck: () => calls.push("check"),
    updateInstall: () => calls.push("install"),
    updateRestart: () => calls.push("restart"),
    onUpdate(next) {
      listener = next;
      next({ phase: "idle", version: "0.0.1" });
      return () => {
        listener = null;
      };
    },
  };
  const send = (state: Partial<UpdateState>) => act(async () => listener?.({ version: "0.0.1", release: RELEASE, ...state } as UpdateState));
  return { bridge, calls, send };
}

async function mount(bridge: UpdateBridge, running: number) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const render = (count: number) => act(async () => root.render(createElement(UpdateCard, { bridge, running: count, onClose: () => {} })));
  await render(running);
  const card = () => container.querySelector<HTMLElement>("[data-testid=update-card]");
  const press = (testId: string) => act(async () => container.querySelector<HTMLElement>(`[data-testid=${testId}]`)?.click());
  return { card, press, render };
}

test("opening the card checks, and with no chat running Update and restart installs and restarts once it is ready", async () => {
  const { bridge, calls, send } = fakeBridge();
  const { card, press } = await mount(bridge, 0);
  assert.deepEqual(calls, ["check"]);
  assert.match(card()?.textContent ?? "", /Checking for updates/);

  await send({ phase: "available" });
  assert.match(card()?.textContent ?? "", /X Bench 0\.0\.2 is available/);
  assert.match(card()?.textContent ?? "", /182 MB/);
  assert.match(card()?.textContent ?? "", /remembers its width/);
  await press("update-install");
  assert.deepEqual(calls, ["check", "install"]);

  await send({ phase: "downloading", progress: 40 });
  assert.equal(card()?.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"), "40");
  assert.equal(card()?.querySelector(".update-close"), null);
  await send({ phase: "ready" });
  assert.deepEqual(calls, ["check", "install", "restart"]);
});

test("with chats running it asks first, and When they finish restarts only after they are done", async () => {
  const { bridge, calls, send } = fakeBridge();
  const { card, press, render } = await mount(bridge, 2);
  await send({ phase: "available" });
  await press("update-install");
  assert.deepEqual(calls, ["check"]);
  assert.match(card()?.textContent ?? "", /2 chats are running/);

  await press("update-later");
  assert.deepEqual(calls, ["check", "install"]);
  await send({ phase: "ready" });
  assert.match(card()?.textContent ?? "", /restarts when the 2 running chats finish/);
  assert.deepEqual(calls, ["check", "install"]);

  await render(0);
  assert.deepEqual(calls, ["check", "install", "restart"]);
});

test("Restart anyway asks the app to restart once, however the running chats change after", async () => {
  const { bridge, calls, send } = fakeBridge();
  const { press, render } = await mount(bridge, 2);
  await send({ phase: "available" });
  await press("update-install");
  await press("update-anyway");
  await send({ phase: "ready" });
  await render(1);
  await render(0);
  assert.deepEqual(calls, ["check", "install", "restart"]);
});

test("a chat that starts during the download holds the restart until it finishes", async () => {
  const { bridge, calls, send } = fakeBridge();
  const { card, press, render } = await mount(bridge, 0);
  await send({ phase: "available" });
  await press("update-install");
  await render(1);
  await send({ phase: "ready" });
  assert.deepEqual(calls, ["check", "install"]);
  assert.match(card()?.textContent ?? "", /restarts when the running chat finishes/);
  await render(0);
  assert.deepEqual(calls, ["check", "install", "restart"]);
});

test("the card names the version it found current, and an error offers to try again", async () => {
  const { bridge, calls, send } = fakeBridge();
  const { card } = await mount(bridge, 0);
  await send({ phase: "current" });
  assert.match(card()?.textContent ?? "", /up to date/);
  assert.match(card()?.textContent ?? "", /0\.0\.1/);
  assert.doesNotMatch(card()?.textContent ?? "", /thimo-eder/);

  await send({ phase: "error", error: "Couldn't check for updates. Check your connection and try again." });
  assert.match(card()?.textContent ?? "", /Couldn't check/);
  await act(async () => [...(card()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Try again")?.click());
  assert.deepEqual(calls, ["check", "check"]);
});
