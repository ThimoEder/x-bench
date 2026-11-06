import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { PresentedQueueEntry } from "../../server/present.ts";
import { installDom } from "../testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { Queue } = await import("./Queue.tsx");

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

async function mount(queue: PresentedQueueEntry[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(Queue, { queue, act: async () => ({}) }));
  });
  return container;
}

test("a queued image-only message shows the picture", async () => {
  const preview = "data:image/png;base64,iVBORw0KGgo";
  const container = await mount([
    { id: "q1", version: 0, text: "", position: 0, attachments: [{ name: "shot.png", kind: "image", mimeType: "image/png", preview }] },
    { id: "q2", version: 0, text: "notes", position: 1, attachments: [{ name: "notes.txt", kind: "file", mimeType: "text/plain" }] },
  ]);
  const rows = [...container.querySelectorAll("[data-testid=queue-row]")];
  assert.equal(rows.length, 2);
  const image = rows[0]?.querySelector("img");
  assert.equal(image?.getAttribute("src"), preview);
  assert.equal(image?.getAttribute("alt"), "shot.png");
  assert.equal(rows[0]?.querySelector(".queue-text"), null);
  assert.equal(rows[1]?.querySelector(".queue-text")?.textContent, "notes");
  assert.equal(rows[1]?.querySelector("[data-testid=queue-file]")?.textContent, "TXTnotes.txt");
});
