import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installDom } from "../testing/dom.ts";

const dom = installDom();
const { watchGit } = await import("./gitWatch.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

let visibility: "visible" | "hidden" = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

function show(state: "visible" | "hidden") {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

test("on the Mac a git check repeats at its own pace", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let checks = 0;
  const stop = watchGit(() => {
    checks += 1;
  }, 10, null, false);
  t.mock.timers.tick(35);
  stop();
  t.mock.timers.tick(35);
  assert.equal(checks, 3);
});

test("through remote access a check without a pace runs only when the page shows again", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let checks = 0;
  const stop = watchGit(() => {
    checks += 1;
  }, 10, null, true);
  t.mock.timers.tick(50);
  assert.equal(checks, 0);
  show("hidden");
  show("visible");
  assert.equal(checks, 1);
  stop();
  show("hidden");
  show("visible");
  assert.equal(checks, 1);
});

test("through remote access a hidden page skips its checks", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let checks = 0;
  const stop = watchGit(() => {
    checks += 1;
  }, 1000, 10, true);
  show("hidden");
  t.mock.timers.tick(50);
  assert.equal(checks, 0);
  show("visible");
  assert.equal(checks, 1);
  t.mock.timers.tick(35);
  stop();
  assert.equal(checks, 4);
});
