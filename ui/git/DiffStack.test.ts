import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
type Report = (entries: { target: Element; isIntersecting: boolean }[]) => void;
const observers: { report: Report; targets: Element[] }[] = [];
// happy-dom cannot tell what is near the view, so the test says it through these observers.
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: class {
    watch: { report: Report; targets: Element[] };
    constructor(report: Report) {
      this.watch = { report, targets: [] };
      observers.push(this.watch);
    }
    observe(target: Element) {
      this.watch.targets.push(target);
    }
    disconnect() {
      observers.splice(observers.indexOf(this.watch), 1);
    }
  },
  configurable: true,
  writable: true,
});
const { createRoot } = await import("react-dom/client");
const { DiffStack } = await import("./DiffStack.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function near(path: string, isIntersecting: boolean) {
  for (const { report, targets } of observers) {
    const target = targets.find((node) => node.getAttribute("data-diff-path") === path);
    if (target) report([{ target, isIntersecting }]);
  }
}

test("a file's rows are built once it nears the view, and stay when it leaves", async () => {
  const files = ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, type: "edit", additions: 1, deletions: 0 }));
  const patches = Object.fromEntries(files.map((file) => [file.path, `@@ -1 +1 @@\n+${file.path}\n`]));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const built = () => [...container.querySelectorAll(".diff-line.add")].map((row) => row.textContent);
  try {
    await act(async () => {
      root.render(createElement(DiffStack, { files, patches, focus: null }));
      await wait(10);
    });
    assert.equal(container.querySelectorAll("[data-diff-path]").length, 3);
    assert.deepEqual(built(), []);
    await act(async () => near("b.ts", true));
    assert.deepEqual(built(), ["1+b.ts\n"]);
    await act(async () => {
      near("b.ts", false);
      near("c.ts", true);
    });
    assert.deepEqual(built(), ["1+b.ts\n", "1+c.ts\n"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("the user scrolling right after picking a file keeps their scroll", async () => {
  const files = ["a.ts", "b.ts"].map((path) => ({ path, type: "edit", additions: 1, deletions: 0 }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(DiffStack, { files, patches: {}, focus: { path: "b.ts", nonce: 1 } })));
    const scroller = container.querySelector<HTMLElement>("[data-testid=diff-scroll]");
    assert.ok(scroller, "no scroller");
    scroller.dispatchEvent(new Event("wheel"));
    scroller.scrollTop = 150;
    await act(() => wait(100));
    assert.equal(scroller.scrollTop, 150);
  } finally {
    await act(async () => root.unmount());
  }
});
