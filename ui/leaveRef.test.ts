import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "./testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { leaveRef } = await import("./leaveRef.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

test("a closed menu leaves a copy out of reach until its animation ends, or until a menu opens again", async () => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const prototype = HTMLElement.prototype as unknown as { getAnimations?: () => unknown[] };
  const before = prototype.getAnimations;
  prototype.getAnimations = () => [{ finished }];
  try {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (open: boolean, ref = leaveRef) => root.render(createElement("div", null, open ? createElement("ul", { ref, id: "menu", className: "option-list" }) : null, createElement("span")));

    await act(async () => render(true));
    await act(async () => render(true, (node) => leaveRef(node)));
    assert.equal(host.querySelectorAll(".option-list").length, 1);

    await act(async () => render(false));
    const copy = host.querySelector(".option-list.is-leaving") as HTMLElement | null;
    assert.ok(copy);
    assert.equal(copy.inert, true);
    assert.equal(copy.id, "");
    assert.equal(copy.nextElementSibling?.tagName, "SPAN");

    await act(async () => render(true));
    assert.equal(host.querySelectorAll(".option-list").length, 1);
    assert.equal(host.querySelector(".is-leaving"), null);

    await act(async () => render(false));
    assert.ok(host.querySelector(".option-list.is-leaving"));
    await act(async () => {
      finish();
      await finished;
    });
    assert.equal(host.querySelector(".option-list"), null);
    await act(async () => root.unmount());
  } finally {
    prototype.getAnimations = before;
  }
});
