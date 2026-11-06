import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "../testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { FolderGone } = await import("./FolderGone.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

async function clickLast(archived: boolean): Promise<string[]> {
  const calls: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const gone = { path: "/tmp/wt", home: "/tmp/repo", branch: "" };
    const actCall = async (path: string) => void calls.push(path);
    await act(async () => root.render(createElement(FolderGone, { gone, archived, act: actCall, call: async () => null })));
    const button = [...container.querySelectorAll("button")].at(-1)!;
    assert.equal(button.textContent, archived ? "Unarchive chat" : "Archive chat");
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  return calls;
}

test("an archived chat's banner unarchives it and stays open", async () => {
  assert.deepEqual(await clickLast(true), ["/api/unarchive"]);
});

test("a listed chat's banner archives it and leaves", async () => {
  assert.deepEqual(await clickLast(false), ["/api/archive", "/api/leave"]);
});
