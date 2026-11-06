import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom, wait } from "../testing/dom.ts";
import type { RemoteLinkState, RemoteState } from "../../server/snapshot.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { RemoteDot, remoteLine, remoteTone } = await import("./RemoteDot.tsx");

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

const NGROK: RemoteLinkState = { available: true, enabled: true, state: "on", url: "https://abc.ngrok-free.app", error: "" };
const LOCAL_OFF: RemoteLinkState = { available: true, enabled: false, state: "off", url: "", error: "" };
const LOCAL_ON: RemoteLinkState = { available: true, enabled: true, state: "on", url: "https://mac.local:9797", error: "" };
const ON: RemoteState = { ngrok: NGROK, local: LOCAL_OFF };

async function mount(remote: RemoteState) {
  const calls: [string, unknown][] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(RemoteDot, {
      remote,
      call: async (path: string, body: Record<string, unknown>) => {
        calls.push([path, body]);
        return {};
      },
    }));
  });
  return { container, calls };
}

test("the dot is green for ngrok, yellow for the local network, green with a 2 for both, and its line names each", async () => {
  const off = { ...NGROK, enabled: false, state: "off" as const, url: "" };
  assert.equal(remoteTone(ON), "ngrok");
  assert.equal(remoteLine(ON), "abc.ngrok-free.app");
  assert.equal(remoteTone({ ngrok: off, local: LOCAL_ON }), "local");
  assert.equal(remoteTone({ ngrok: NGROK, local: LOCAL_ON }), "both");
  assert.equal(remoteLine({ ngrok: NGROK, local: LOCAL_ON }), "abc.ngrok-free.app · mac.local:9797");
  const reconnecting = { ...NGROK, state: "starting" as const, error: "Reconnecting to ngrok…" };
  assert.equal(remoteTone({ ngrok: reconnecting, local: LOCAL_OFF }), "starting");
  assert.equal(remoteLine({ ngrok: reconnecting, local: LOCAL_OFF }), "Reconnecting to ngrok…");
  assert.equal(remoteTone({ ngrok: { ...NGROK, state: "failed", error: "bad token" }, local: LOCAL_ON }), "failed");
  assert.equal(remoteTone({ ngrok: off, local: LOCAL_OFF }), "off");
  assert.equal(remoteLine({ ngrok: off, local: LOCAL_OFF }), "Off");
  assert.equal((await mount({ ngrok: NGROK, local: LOCAL_ON })).container.querySelector(".remote-dot-count")?.textContent, "2");
  assert.equal((await mount(ON)).container.querySelector(".remote-dot-count"), null);
});

test("the menu has a switch for each tunnel that is set up", async () => {
  assert.equal((await mount({ ngrok: { ...NGROK, available: false }, local: { ...LOCAL_OFF, available: false } })).container.querySelector('[data-testid="remote-dot"]'), null);
  const bare = await mount({ ngrok: { ...NGROK, available: false, enabled: false, state: "off" }, local: LOCAL_OFF });
  await act(async () => bare.container.querySelector<HTMLElement>('[data-testid="remote-dot"]')?.click());
  assert.equal(bare.container.querySelector('[data-testid="remote-menu-switch-ngrok"]'), null);
  assert.ok(bare.container.querySelector('[data-testid="remote-menu-switch-local"]'));

  const { container, calls } = await mount(ON);
  const dot = container.querySelector<HTMLElement>('[data-testid="remote-dot"]');
  assert.ok(dot);
  assert.equal(dot.dataset.tone, "ngrok");
  await act(async () => dot.click());
  const ngrok = container.querySelector<HTMLInputElement>('[data-testid="remote-menu-switch-ngrok"]');
  const local = container.querySelector<HTMLInputElement>('[data-testid="remote-menu-switch-local"]');
  assert.ok(ngrok?.checked);
  assert.equal(local?.checked, false);
  await act(async () => {
    ngrok.click();
    await wait();
  });
  await act(async () => {
    local.click();
    await wait();
  });
  assert.deepEqual(calls, [["/api/remote/enabled", { kind: "ngrok", enabled: false }], ["/api/remote/enabled", { kind: "local", enabled: true }]]);
});

test("a page through remote access shows no dot", async () => {
  const mark = document.createElement("meta");
  mark.setAttribute("name", "x-bench-remote");
  document.head.append(mark);
  try {
    assert.equal((await mount(ON)).container.querySelector('[data-testid="remote-dot"]'), null);
  } finally {
    mark.remove();
  }
});
