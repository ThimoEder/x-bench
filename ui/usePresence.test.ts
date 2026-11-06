import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "./testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { usePresence } = await import("./usePresence.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const wait = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

test("a pane stays mounted while it slides out, and mounts closed before it slides in", async () => {
  const seen: { mounted: boolean; shown: boolean }[] = [];
  function Probe({ show }: { show: boolean }) {
    seen.push(usePresence(show, 30));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { show: true })));
  assert.deepEqual(seen.at(-1), { mounted: true, shown: true });

  await act(async () => root.render(createElement(Probe, { show: false })));
  assert.deepEqual(seen.at(-1), { mounted: true, shown: false });
  await act(() => wait(60));
  assert.deepEqual(seen.at(-1), { mounted: false, shown: false });

  await act(async () => root.render(createElement(Probe, { show: true })));
  assert.equal(seen.some((state) => state.mounted && !state.shown), true);
  await act(() => wait(60));
  assert.deepEqual(seen.at(-1), { mounted: true, shown: true });
  await act(async () => root.unmount());
});

test("with no time to slide a pane leaves in the same render", async () => {
  const seen: { mounted: boolean; shown: boolean }[] = [];
  function Probe({ show, ms }: { show: boolean; ms: number }) {
    seen.push(usePresence(show, ms));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { show: true, ms: 30 })));
  const shownRenders = seen.length;
  await act(async () => root.render(createElement(Probe, { show: false, ms: 0 })));
  assert.equal(seen.slice(shownRenders).some((state) => state.mounted), false);

  await act(async () => root.render(createElement(Probe, { show: true, ms: 30 })));
  await act(() => wait(60));
  assert.deepEqual(seen.at(-1), { mounted: true, shown: true });
  await act(async () => root.unmount());
});
