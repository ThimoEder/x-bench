import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installDom } from "../testing/dom.ts";
import { dropTapsOnRoot } from "./sheetTaps.ts";

const dom = installDom();
after(async () => {
  await dom.happyDOM.abort();
});

function tap(press: Element, release: Element): boolean {
  press.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  let reached = false;
  release.addEventListener("click", () => (reached = true), { once: true });
  release.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return reached;
}

test("a tap pressed on the root element, as under an open sheet, reaches nothing", () => {
  const row = document.createElement("button");
  document.body.append(row);
  const stop = dropTapsOnRoot();
  assert.equal(tap(document.documentElement, row), false);
  assert.equal(tap(row, row), true);
  stop();
  row.remove();
});

test("a press on the root that turns into a scroll leaves the next tap alone", () => {
  const row = document.createElement("button");
  document.body.append(row);
  const stop = dropTapsOnRoot();
  document.documentElement.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  document.dispatchEvent(new window.Event("pointercancel"));
  let reached = false;
  row.addEventListener("click", () => (reached = true), { once: true });
  row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(reached, true);
  stop();
  row.remove();
});
