import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROMPT_OPTIONS, createBrowser, originOf } from "./browser.ts";
import { choose, fakeLink } from "../testing/fakeBrowserLink.ts";

function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-browser-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("calls go over the link and come back with the app's answer, and the tabs follow its state", async () => {
  const browser = createBrowser(scratchDir());
  let changes = 0;
  browser.onChange(() => (changes += 1));
  await assert.rejects(browser.call("open"), /not connected/);
  assert.equal(browser.view().available, false);

  const { link, sent, push } = fakeLink((op) => {
    if (op === "fail") throw new Error("No page is open.");
    return { tab: 3 };
  });
  browser.attach(link);
  assert.equal(browser.view().available, true);
  assert.deepEqual(await browser.call("open", { url: "https://example.com/" }), { tab: 3 });
  assert.deepEqual(sent, [{ op: "open", args: { url: "https://example.com/" } }]);
  await assert.rejects(browser.call("fail"), /No page is open/);

  const tab = (id: number, owner: string) => ({ id, owner, url: "https://example.com/", title: "Example", loading: false, canGoBack: true, canGoForward: false });
  push({ type: "state", tabs: [tab(3, "s1"), tab(4, "s1"), tab(5, "s2"), { id: 6, url: "no owner" }], active: { s1: 4, s2: 5 } });
  assert.deepEqual(browser.view().tabs.map((item) => item.id), [3, 4, 5], "a tab without an owner is dropped");
  assert.equal(browser.current("s1")?.id, 4);
  assert.equal(browser.current("s2")?.id, 5);
  assert.equal(browser.current("s3"), null);

  browser.focus("s2");
  assert.deepEqual(browser.view().focus, { count: 1, owner: "s2" });

  link.close();
  assert.deepEqual(browser.view(), { available: false, tabs: [], active: {}, focus: { count: 1, owner: "s2" } });
  assert.ok(changes >= 4);
});

test("a second app is turned away while one is linked, and a call waiting on a closed link fails at once", async () => {
  const browser = createBrowser(scratchDir());
  const silent = fakeLink();
  silent.link.sendText = () => true;
  assert.equal(browser.attach(silent.link), true);
  const second = fakeLink();
  let secondClosed = false;
  second.link.onClose(() => (secondClosed = true));
  assert.equal(browser.attach(second.link), false);
  assert.equal(secondClosed, true, "the second app hears no and links again later");
  const waiting = browser.call("open");
  silent.link.close();
  await assert.rejects(waiting, /closed/);
  assert.equal(browser.view().available, false);
  const next = fakeLink();
  assert.equal(browser.attach(next.link), true);
  assert.equal(browser.generation(), 2);
});

test("a prompt waits for the person, and always-allow remembers the site for that session only", async () => {
  const browser = createBrowser(scratchDir());
  const origin = originOf("https://example.com/a?b");
  assert.equal(origin, "https://example.com");
  assert.equal(browser.allowed("s1", origin), false);

  const asked = browser.ask("s1", { title: "Open example.com", detail: "https://example.com/", origin });
  const prompt = browser.prompt("s1");
  assert.ok(prompt);
  assert.deepEqual(prompt.options.map((option) => option.name), ["Allow once", "Always allow on example.com", "Deny"]);
  assert.equal(browser.prompt("s2"), null);
  assert.equal(browser.answer("s1", "nope"), false);
  assert.equal(choose(browser, "site"), true);
  assert.equal(await asked, "site");
  assert.equal(browser.prompt("s1"), null);
  assert.equal(browser.allowed("s1", origin), true);
  assert.equal(browser.allowed("s2", origin), false);

  const once = browser.ask("s1", { title: "Click", detail: "", origin: "https://other.test" });
  choose(browser, "once");
  assert.equal(await once, "once");
  assert.equal(browser.allowed("s1", "https://other.test"), false);

  browser.forget("s1");
  assert.equal(browser.allowed("s1", origin), false);
});

test("an old card's answer never approves the next prompt", async () => {
  const browser = createBrowser(scratchDir());
  const first = browser.ask("s1", { title: "Click A", detail: "", origin: "" });
  const stale = browser.prompt("s1")?.options[0]?.optionId ?? "";
  choose(browser, "deny");
  assert.equal(await first, "deny");
  const second = browser.ask("s1", { title: "Click B", detail: "", origin: "" });
  assert.equal(browser.answer("s1", stale), false, "a late click on the first card does nothing");
  assert.equal(browser.prompt("s1")?.title, "Click B");
  choose(browser, "once");
  assert.equal(await second, "once");
});

test("a deleted chat's tabs close", async () => {
  const browser = createBrowser(scratchDir());
  const tab = (id: number, owner: string) => ({ id, owner, url: "https://example.com/", title: "", loading: false, canGoBack: false, canGoForward: false });
  const { link, sent, push } = fakeLink();
  browser.attach(link);
  push({ type: "state", tabs: [tab(1, "gone"), tab(2, "kept")], active: { gone: 1, kept: 2 } });
  browser.forget("gone");
  browser.forget("never-had-tabs");
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(sent.filter((call) => call.op === "closeOwner").map((call) => call.args), [{ owner: "gone" }]);
});

test("stopping the turn, a dropped request and forgetting the session each deny what waits", async () => {
  const browser = createBrowser(scratchDir());
  const stopped = browser.ask("s1", { title: "Click", detail: "", origin: "" });
  assert.deepEqual(browser.prompt("s1")?.options.map((option) => option.optionId.slice(0, option.optionId.lastIndexOf(":"))), [PROMPT_OPTIONS.once, PROMPT_OPTIONS.deny], "no always-allow without a site");
  browser.cancel("s1");
  assert.equal(await stopped, "deny");

  const dropped = new AbortController();
  const gone = browser.ask("s1", { title: "Type", detail: "", origin: "" }, dropped.signal);
  dropped.abort();
  assert.equal(await gone, "deny");
  assert.equal(browser.prompt("s1"), null);

  const forgotten = browser.ask("s2", { title: "Press", detail: "", origin: "" });
  browser.forget("s2");
  assert.equal(await forgotten, "deny");
});

test("thumbnails are kept under ids the page can ask for, and nothing else is served", () => {
  const dir = scratchDir();
  const browser = createBrowser(dir);
  const id = browser.saveThumb(Buffer.from("jpeg").toString("base64"));
  assert.match(id ?? "", /^[a-f0-9]{12}$/);
  assert.equal(fs.readFileSync(browser.thumbFile(id ?? "") ?? "", "utf8"), "jpeg");
  assert.equal(browser.thumbFile("../../etc/passwd"), null);
  assert.equal(browser.thumbFile("000000000000"), null);
});
