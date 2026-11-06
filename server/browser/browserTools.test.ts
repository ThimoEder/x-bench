import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROMPT_OPTIONS, createBrowser, type Browser } from "./browser.ts";
import { NAVIGATE_TOOL, PAGE_MARK, browserTools, hideUrlSecrets, keyPress, modifierMask, normalizeUrl, pageMarkOf, viewportOf } from "./browserTools.ts";
import type { McpTool, ToolResult } from "../mcp/mcp.ts";
import { choose, fakeLink } from "../testing/fakeBrowserLink.ts";

const TAB = { id: 1, owner: "s1", url: "https://example.com/", title: "Example Domain", loading: false, canGoBack: false, canGoForward: false };
const OTHER = { ...TAB, id: 9, owner: "s2", url: "https://other.test/", title: "Other chat" };

// An accessibility tree: a heading, a sentence split over one text node per word, and a link.
const TREE = {
  nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example Domain" }, childIds: ["2"] },
    { nodeId: "2", ignored: true, role: { value: "none" }, childIds: ["3", "4", "8"] },
    { nodeId: "3", role: { value: "heading" }, name: { value: "Example Domain" }, properties: [{ name: "level", value: { value: 1 } }], backendDOMNodeId: 30, childIds: [] },
    { nodeId: "4", role: { value: "paragraph" }, childIds: ["5", "6", "7"] },
    { nodeId: "5", role: { value: "StaticText" }, name: { value: "This " } },
    { nodeId: "6", role: { value: "StaticText" }, name: { value: "domain " } },
    { nodeId: "7", role: { value: "StaticText" }, name: { value: "is for examples." } },
    { nodeId: "8", role: { value: "link" }, name: { value: "Learn more" }, backendDOMNodeId: 80, childIds: [] },
  ],
};

interface Setup {
  browser: Browser;
  tools: Record<string, McpTool>;
  sent: { op: string; args: Record<string, unknown> }[];
  // Moves the chat's current tab to another page, as a click or redirect would.
  moveTo(url: string): void;
  scroll(by: number): void;
}

function setup(mode: string | null = null): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-tools-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = createBrowser(dir);
  let tabs = [TAB, OTHER];
  // How far the page has scrolled the elements, as a person scrolling while a card waits would.
  let shift = 0;
  const state = () => push({ type: "state", tabs, active: Object.fromEntries(tabs.map((tab) => [tab.owner, tab.id])) });
  const { link, sent, push } = fakeLink((op, args) => {
    if (op === "open") {
      const created = args.newTab === true;
      const id = created ? 2 : 1;
      tabs = [...tabs.filter((tab) => tab.id !== id), { ...TAB, id, url: String(args.url) }];
      state();
      return { tab: id, created };
    }
    if (op === "capture") return Number(args.maxWidth) >= 1280 ? { data: Buffer.from("jpeg").toString("base64"), width: 1280, height: 800, pageWidth: 1440, pageHeight: 900 } : { data: Buffer.from("jpeg").toString("base64"), width: 640, height: 400 };
    if (op === "cdp" && args.method === "Accessibility.getFullAXTree") return TREE;
    if (op === "cdp" && args.method === "DOM.getContentQuads") return { quads: [[10, 20 + shift, 50, 20 + shift, 50, 40 + shift, 10, 40 + shift]] };
    if (op === "cdp" && args.method === "Runtime.evaluate") {
      const expression = String((args.params as { expression?: string }).expression);
      if (expression.includes(".includes(")) return { result: { value: expression.includes('"examples"') } };
      if (expression === "throw") return { exceptionDetails: { exception: { description: "Error: boom" } }, result: {} };
      if (expression === "document.title") return { result: { type: "string", value: "Example Domain" } };
      return { result: { value: "Example Domain\nThis domain is for examples." } };
    }
    if (op === "cdp" && args.method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
    if (op === "cdp" && args.method === "Runtime.callFunctionOn") return { result: { value: "Germany" } };
    if (op === "cdp" && args.method === "Network.getResponseBody") {
      if (["r1", "gone"].includes((args.params as { requestId: string }).requestId)) throw new Error("No resource with given identifier found");
      return { body: Buffer.from('{"ok":true}').toString("base64"), base64Encoded: true };
    }
    if (op === "cdp" && args.method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (op === "cdp" && args.method === "Page.getResourceContent") return { content: "<!doctype html><title>Example</title>", base64Encoded: false };
    if (op === "console") return { messages: [{ level: "info", text: "ready", source: "app.js", line: 3 }, { level: "error", text: "Uncaught TypeError: x is undefined", source: "app.js", line: 9 }] };
    if (op === "request") {
      if (args.id === "r2") return { request: { id: "r2", method: "POST", url: "https://example.com/api/save", type: "Fetch", status: 500, statusText: "Internal Server Error", failed: "", requestHeaders: { "Content-Type": "application/json", Cookie: "sid=abc", Authorization: "Bearer xyz", "X-CSRF-Token": "t" }, postData: '{"name":"Ada"}', hasPostData: true, responseHeaders: { "content-type": "application/json", "set-cookie": "sid=new" } } };
      if (args.id === "r4") return { request: { id: "r4", method: "POST", url: "https://example.com/login", type: "Document", status: 302, failed: "", requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" }, postData: "user%5Bemail%5D=ada&user%5Bpassword%5D=hunter2&csrf_token=t1&remember=1", hasPostData: true, responseHeaders: {} } };
      if (args.id === "r5") return { request: { id: "r5", method: "POST", url: "https://example.com/api/login", type: "Fetch", status: 200, failed: "", requestHeaders: { "content-type": "application/json" }, postData: '{"id":9007199254740993,"email":"ada@example.com","password":"hunter2","device":{"name":"Mac","apiKey":"k1"}}', hasPostData: true, responseHeaders: {} } };
      if (args.id === "r6") return { request: { id: "r6", method: "POST", url: "https://example.com/api/upload", type: "Fetch", status: 200, failed: "", requestHeaders: { "content-type": "application/json" }, postData: '{"password":"hunter2","photo":"aaaa', hasPostData: true, responseHeaders: {} } };
      if (args.id === "r3") return { request: { id: "r3", method: "GET", url: "https://example.com/app.js", type: "Script", status: 302, failed: "", requestHeaders: { Referer: "https://example.com/reset?token=abc&lang=en" }, postData: null, hasPostData: false, responseHeaders: { Location: "https://example.com/next?code=xyz" } } };
      return { request: { id: String(args.id), method: "GET", url: "https://example.com/", type: "Document", status: 200, failed: "", requestHeaders: {}, postData: null, hasPostData: false, responseHeaders: {} } };
    }
    if (op === "network") return { requests: [{ id: "r1", method: "GET", url: "https://example.com/", type: "Document", status: 200, mimeType: "text/html", failed: "" }, { id: "r2", method: "POST", url: "https://example.com/api/save", type: "Fetch", status: 500, mimeType: "application/json", failed: "" }] };
    return {};
  });
  browser.attach(link);
  state();
  const group = browserTools(browser, { modeOf: () => mode });
  const moveTo = (url: string) => {
    tabs = tabs.map((tab) => (tab.id === 1 ? { ...tab, url } : tab));
    state();
  };
  const scroll = (by: number) => {
    shift += by;
  };
  return { browser, tools: Object.fromEntries(group.tools.map((tool) => [tool.spec.name, tool])), sent, moveTo, scroll };
}

function run(tool: McpTool | undefined, args: unknown, sessionId: string | null = "s1"): Promise<ToolResult> {
  assert.ok(tool);
  return Promise.resolve(tool.call(args, { sessionId, signal: new AbortController().signal }));
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

// The prompt the tool raises, once it is up.
async function asked(browser: Browser) {
  for (let tries = 0; tries < 50 && !browser.prompt("s1"); tries += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(browser.prompt("s1"), "the tool did not ask");
  return browser.prompt("s1");
}

test("opening a site in a new tab asks first, and the result carries the page's mark for the card", async () => {
  const { browser, tools, sent } = setup();
  const pending = run(tools.browser_navigate, { url: "example.org/path", new_tab: true });
  const prompt = await asked(browser);
  assert.equal(prompt?.title, "Open example.org in the browser");
  assert.equal(prompt?.detail, "https://example.org/path");
  choose(browser, "site");
  const result = await pending;
  assert.equal(result.isError, false);
  assert.match(text(result), /^Opened "Example Domain" at https:\/\/example\.org\/path in tab 2\./);
  const mark = pageMarkOf(result.content);
  assert.equal(mark?.url, "https://example.org/path");
  assert.equal(mark?.tab, 2);
  assert.match(mark?.thumb ?? "", /^[a-f0-9]{12}$/);
  assert.ok(browser.thumbFile(mark?.thumb ?? ""));
  assert.deepEqual(browser.view().focus, { count: 1, owner: "s1" }, "a new tab brings the chat's Browser tab up");
  assert.deepEqual(sent.find((call) => call.op === "open")?.args, { url: "https://example.org/path", owner: "s1", newTab: true });

  // The site is allowed now. A page in the chat's current tab opens without asking, and without a card.
  const again = await run(tools.browser_navigate, { url: "https://example.org/other" });
  assert.equal(text(again), 'Opened "Example Domain" at https://example.org/other in tab 1.');
  assert.equal(pageMarkOf(again.content), null);
  assert.equal(browser.view().focus.count, 1, "the dock stays where the person has it");
  const back = await run(tools.browser_navigate, { url: "back" });
  assert.equal(pageMarkOf(back.content), null);
});

test("a declined or unbound request does nothing in the browser", async () => {
  const { browser, tools, sent } = setup();
  const pending = run(tools.browser_navigate, { url: "https://example.org" });
  await asked(browser);
  choose(browser, "deny");
  const declined = await pending;
  assert.equal(declined.isError, true);
  assert.match(text(declined), /declined/);
  assert.equal(sent.some((call) => call.op === "open"), false);

  await assert.rejects(run(tools.browser_navigate, { url: "https://example.org" }, null), /still opening/);
  assert.equal((await run(tools.browser_navigate, { url: "file:///etc/passwd" })).isError, true);
});

test("reading needs no permission, and merges a sentence split over many text nodes", async () => {
  const { browser, tools } = setup();
  const tree = text(await run(tools.browser_read_page, {}));
  assert.equal(browser.prompt("s1"), null);
  assert.equal(
    tree,
    [
      "Example Domain (https://example.com/), tab 1",
      "",
      '- heading "Example Domain" level=1 [ref_1]',
      '- text "This domain is for examples."',
      '- link "Learn more" [ref_2]',
    ].join("\n"),
  );
  const controls = text(await run(tools.browser_read_page, { filter: "interactive" }));
  assert.match(controls, /- link "Learn more" \[ref_2\]$/, "an element keeps its ref across reads");
  assert.doesNotMatch(controls, /text|heading/);
  assert.match(text(await run(tools.browser_read_page, { mode: "text" })), /This domain is for examples\./);
  assert.equal(text(await run(tools.browser_find, { query: "learn" })), '- link "Learn more" [ref_2]');
});

test("a click asks unless the site is allowed, and lands in the middle of the element", async () => {
  const { browser, tools, sent } = setup();
  await run(tools.browser_read_page, {});
  await assert.rejects(run(tools.browser_click, { ref: "ref_9" }), /ref_9 is not on this page/);

  const pending = run(tools.browser_click, { ref: "ref_2" });
  const prompt = await asked(browser);
  assert.equal(prompt?.title, 'Click link "Learn more" [ref_2]');
  choose(browser, "once");
  assert.equal(text(await pending), 'Clicked link "Learn more" [ref_2].');
  const presses = sent.filter((call) => call.op === "cdp" && call.args.method === "Input.dispatchMouseEvent").map((call) => call.args.params as { type: string; x: number; y: number });
  assert.deepEqual(presses.map((press) => [press.type, press.x, press.y]), [
    ["mouseMoved", 30, 30],
    ["mousePressed", 30, 30],
    ["mouseReleased", 30, 30],
  ]);

  // Allow once does not allow the site, so the next action asks again.
  const next = run(tools.browser_press_key, { keys: "Enter" });
  await asked(browser);
  choose(browser, "site");
  assert.equal(text(await next), "Pressed Enter.");
  assert.equal(text(await run(tools.browser_type, { text: "hello", ref: "ref_2" })), 'Typed into link "Learn more" [ref_2].', "an allowed site does not ask");
  assert.ok(sent.some((call) => call.args.method === "Input.insertText" && (call.args.params as { text: string }).text === "hello"));
});

test("in Auto and Always approve, opening and acting go ahead without the card", async () => {
  for (const mode of ["auto", "full"]) {
    const { browser, tools } = setup(mode);
    assert.equal((await run(tools.browser_navigate, { url: "https://example.org", new_tab: true })).isError, false);
    assert.equal(text(await run(tools.browser_press_key, { keys: "Enter" })), "Pressed Enter.");
    assert.equal(browser.prompt("s1"), null, mode);
  }
  const { browser, tools } = setup("acceptEdits");
  const pending = run(tools.browser_press_key, { keys: "Enter" });
  assert.equal((await asked(browser))?.title, "Press Enter");
  choose(browser, "deny");
  assert.equal((await pending).isError, true);
});

test("clicks take a button, a count and held keys", async () => {
  const { tools, sent } = setup("full");
  await run(tools.browser_read_page, {});
  assert.equal(text(await run(tools.browser_click, { ref: "ref_2", clicks: 3 })), 'Triple-clicked link "Learn more" [ref_2].');
  const presses = sent.filter((call) => call.args.method === "Input.dispatchMouseEvent" && (call.args.params as { type: string }).type === "mousePressed").map((call) => (call.args.params as { clickCount: number }).clickCount);
  assert.deepEqual(presses, [1, 2, 3]);
  assert.equal(text(await run(tools.browser_click, { x: 5, y: 5, button: "right", modifiers: "cmd+shift" })), "Right-clicked the point (5, 5) with cmd+shift.");
  const right = sent.filter((call) => call.args.method === "Input.dispatchMouseEvent").at(-1)?.args.params as { button: string; modifiers: number };
  assert.deepEqual([right.button, right.modifiers], ["right", 12]);
  assert.equal((await run(tools.browser_click, { x: 5, y: 5, modifiers: "hyper" })).isError, true);
});

test("mouse input follows a viewport shrunk to fit the pane", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-tools-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = createBrowser(dir);
  const { link, sent, push } = fakeLink(() => ({}));
  browser.attach(link);
  push({ type: "state", tabs: [{ ...TAB, inputScale: 0.5 }], active: { s1: 1 } });
  const click = browserTools(browser, { modeOf: () => "full" }).tools.find((tool) => tool.spec.name === "browser_click");
  await run(click, { x: 100, y: 60 });
  const press = sent.find((call) => (call.args.params as { type?: string } | undefined)?.type === "mousePressed")?.args.params as { x: number; y: number };
  assert.deepEqual([press.x, press.y], [50, 30]);
});

test("forms, drags and JavaScript ask like other actions, and do their work once allowed", async () => {
  const { browser, tools, sent } = setup();
  await run(tools.browser_read_page, {});
  const setting = run(tools.browser_form_input, { ref: "ref_2", value: "Germany" });
  assert.equal((await asked(browser))?.title, 'Set link "Learn more" [ref_2] to "Germany"');
  choose(browser, "site");
  assert.equal(text(await setting), 'Set link "Learn more" [ref_2] to "Germany".');
  const setCall = sent.find((call) => call.args.method === "Runtime.callFunctionOn");
  assert.equal((setCall?.args.params as { objectId?: string } | undefined)?.objectId, "obj-1");

  assert.equal(text(await run(tools.browser_drag, { from_ref: "ref_1", to_x: 100, to_y: 200 })), 'Dragged heading "Example Domain" [ref_1] to the point (100, 200).');
  const moves = sent.filter((call) => call.args.method === "Input.dispatchMouseEvent").map((call) => (call.args.params as { type: string }).type);
  assert.deepEqual([moves[0], moves[1], moves.at(-1)], ["mouseMoved", "mousePressed", "mouseReleased"]);

  assert.equal(text(await run(tools.browser_evaluate, { expression: "document.title" })), '"Example Domain"');
  const thrown = await run(tools.browser_evaluate, { expression: "throw" });
  assert.equal(thrown.isError, true);
  assert.equal(text(thrown), "Error: boom");
});

test("console, network, waiting, hovering and scrolling to an element never ask", async () => {
  const { browser, tools, sent } = setup();
  assert.equal(text(await run(tools.browser_console, { only_errors: true })), "[error] Uncaught TypeError: x is undefined (app.js:9)");
  assert.match(text(await run(tools.browser_console, { pattern: "nothing" })), /No console messages matching "nothing"/);
  assert.equal(text(await run(tools.browser_network, { only_failed: true })), "r2 POST 500 Fetch https://example.com/api/save");
  assert.equal(
    text(await run(tools.browser_network, { request_id: "r2" })),
    [
      "POST 500 Internal Server Error Fetch https://example.com/api/save",
      "Request headers:\n  Content-Type: application/json\n  Cookie: [hidden]\n  Authorization: [hidden]\n  X-CSRF-Token: [hidden]",
      'Payload:\n{"name":"Ada"}',
      "Response headers:\n  content-type: application/json\n  set-cookie: [hidden]",
      'Response body:\n{"ok":true}',
    ].join("\n\n"),
  );
  assert.match(text(await run(tools.browser_network, { request_id: "r1" })), /Response body:\n<!doctype html><title>Example<\/title>$/, "a first page's body comes from its frame");
  assert.match(text(await run(tools.browser_network, { request_id: "gone" })), /Response body: none \(No resource with given identifier found\)$/);
  assert.doesNotMatch(text(await run(tools.browser_network, { request_id: "r2", body: false })), /Response body/);

  assert.ok(sent.some((call) => call.op === "console") && sent.some((call) => call.op === "network"));

  assert.equal(text(await run(tools.browser_wait, { text: "examples", seconds: 1 })), 'The page shows "examples".');
  assert.equal((await run(tools.browser_wait, { text: "missing", seconds: 0.3 })).isError, true);
  await run(tools.browser_read_page, {});
  assert.equal(text(await run(tools.browser_hover, { ref: "ref_2" })), 'The mouse is over link "Learn more" [ref_2].');
  assert.equal(text(await run(tools.browser_scroll_to, { ref: "ref_1" })), 'Scrolled heading "Example Domain" [ref_1] into view.');
  assert.equal(browser.prompt("s1"), null);
});

test("revealing hidden headers asks in every mode, and shows them only once allowed", async () => {
  const { browser, tools } = setup("full");
  const denied = run(tools.browser_network, { request_id: "r2", reveal: true, body: false });
  const prompt = await asked(browser);
  assert.equal(prompt?.title, "Show the agent the hidden values of POST example.com");
  assert.equal(prompt?.detail, "Cookie, Authorization, X-CSRF-Token, set-cookie\nhttps://example.com/api/save");
  assert.deepEqual(prompt?.options.map((option) => option.optionId.slice(0, option.optionId.lastIndexOf(":"))), [PROMPT_OPTIONS.once, PROMPT_OPTIONS.deny], "no always-allow for secrets");
  choose(browser, "deny");
  assert.match(text(await denied), /kept the values hidden/);

  const allowed = run(tools.browser_network, { request_id: "r2", reveal: true, body: false });
  await asked(browser);
  choose(browser, "once");
  const shown = text(await allowed);
  assert.match(shown, /Cookie: sid=abc\n  Authorization: Bearer xyz/);
  assert.match(shown, /set-cookie: sid=new/);
  assert.match(text(await run(tools.browser_network, { request_id: "r2", body: false })), /Cookie: \[hidden\]/, "the next look is hidden again");
  assert.equal(text(await run(tools.browser_network, { request_id: "r1", reveal: true, body: false })).includes("[hidden]"), false, "nothing to reveal asks nothing");
  assert.equal(browser.prompt("s1"), null);
});

test("resizing lays the page out at a preset or a custom size, and sets its color scheme", async () => {
  const { tools, sent } = setup();
  assert.equal(text(await run(tools.browser_resize, { preset: "mobile", color_scheme: "dark" })), "The page lays out at 375×812, and it prefers the dark color scheme.");
  assert.deepEqual(sent.find((call) => call.op === "viewport")?.args, { tab: 1, width: 375, height: 812, mobile: true });
  assert.equal(text(await run(tools.browser_resize, { preset: "desktop" })), "The page lays out at 1280×800.");
  assert.equal(text(await run(tools.browser_resize, { preset: "pane", color_scheme: "auto" })), "The page uses the pane's own size again, and it follows the system's color scheme.");
  assert.deepEqual(sent.filter((call) => call.op === "viewport").at(-1)?.args, { tab: 1, width: null });
  assert.equal((await run(tools.browser_resize, {})).isError, true);
  assert.deepEqual(viewportOf({ width: 1440, height: 900 }), { width: 1440, height: 900 });
  assert.deepEqual(viewportOf({ preset: "tablet" }), { width: 768, height: 1024 });
  assert.deepEqual(viewportOf({ width: 50 }), { width: 200, height: 800 });
  assert.equal(viewportOf({}), null);
  assert.equal(modifierMask("cmd+alt"), 5);
  assert.equal(modifierMask(""), 0);
});

test("an approved action is dropped when the page changed while the person was asked", async () => {
  const { browser, tools, sent, moveTo } = setup();
  const pending = run(tools.browser_evaluate, { expression: "document.title" });
  await asked(browser);
  moveTo("https://bank.test/transfer");
  choose(browser, "once");
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /The page changed while the person was asked \(it is now at https:\/\/bank\.test\/transfer\)/);
  assert.equal(sent.some((call) => call.args.method === "Runtime.evaluate"), false, "nothing ran on the new page");
  moveTo("https://example.com/#section");
  const same = run(tools.browser_press_key, { keys: "Enter" });
  await asked(browser);
  choose(browser, "once");
  assert.equal(text(await same), "Pressed Enter.", "a move within the page is the same page");
});

test("an approved click finds its element again, after the page scrolled while the card waited", async () => {
  const { browser, tools, sent, scroll } = setup();
  await run(tools.browser_read_page, {});
  const pending = run(tools.browser_click, { ref: "ref_2" });
  await asked(browser);
  scroll(300);
  choose(browser, "once");
  assert.equal(text(await pending), 'Clicked link "Learn more" [ref_2].');
  const press = sent.find((call) => (call.args.params as { type?: string } | undefined)?.type === "mousePressed")?.args.params as { y: number };
  assert.equal(press.y, 330);
});

test("an approval waiting while another app links never acts on another chat's tab", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-tools-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = createBrowser(dir);
  const first = fakeLink();
  browser.attach(first.link);
  first.push({ type: "state", tabs: [TAB], active: { s1: 1 } });
  const evaluate = browserTools(browser).tools.find((tool) => tool.spec.name === "browser_evaluate");
  const pending = run(evaluate, { expression: "document.title" });
  await asked(browser);
  first.link.close();
  const second = fakeLink(() => ({ result: { value: "stolen" } }));
  browser.attach(second.link);
  second.push({ type: "state", tabs: [{ ...TAB, owner: "s2" }], active: { s2: 1 } });
  choose(browser, "once");
  assert.match(text(await pending), /The page changed while the person was asked/);
  assert.equal(second.sent.some((call) => call.args.method === "Runtime.evaluate"), false);
});

test("refs belong to the page they were read on", async () => {
  const { tools, moveTo } = setup("full");
  await run(tools.browser_read_page, {});
  moveTo("https://other-site.test/");
  await assert.rejects(run(tools.browser_click, { ref: "ref_2" }), /ref_2 is not on this page/);
});

test("URL secrets stay hidden in Referer and Location, and in the URL every tool shows", async () => {
  const { browser, tools, moveTo } = setup("full");
  const shown = text(await run(tools.browser_network, { request_id: "r3", body: false }));
  assert.match(shown, /Referer: https:\/\/example\.com\/reset\?token=%5Bhidden%5D&lang=en/);
  assert.match(shown, /Location: https:\/\/example\.com\/next\?code=%5Bhidden%5D/);
  const revealing = run(tools.browser_network, { request_id: "r3", body: false, reveal: true });
  assert.equal((await asked(browser))?.detail.split("\n")[0], "Referer, Location");
  choose(browser, "once");
  assert.match(text(await revealing), /token=abc/);
  moveTo("https://example.com/cb?access_token=t");
  assert.match(text(await run(tools.browser_read_page, { mode: "text" })), /^Example Domain \(https:\/\/example\.com\/cb\?access_token=%5Bhidden%5D\), tab 1/);
});

test("passwords, tokens and keys in a form or JSON login stay hidden until revealed", async () => {
  const { browser, tools } = setup("full");
  assert.match(text(await run(tools.browser_network, { request_id: "r4", body: false })), /Payload:\nuser%5Bemail%5D=ada&user%5Bpassword%5D=%5Bhidden%5D&csrf_token=%5Bhidden%5D&remember=1\n/);
  const json = text(await run(tools.browser_network, { request_id: "r5", body: false }));
  assert.match(json, /Payload:\n\{"id":9007199254740993,"email":"ada@example\.com","password":"\[hidden\]","device":\{"name":"Mac","apiKey":"\[hidden\]"\}\}/, "other numbers keep their digits");
  assert.doesNotMatch(json, /hunter2|k1/);
  assert.match(text(await run(tools.browser_network, { request_id: "r6", body: false })), /Payload:\n\[hidden: JSON that does not parse\]\n/, "a payload cut off at the desktop's limit");

  const revealing = run(tools.browser_network, { request_id: "r4", body: false, reveal: true });
  assert.equal((await asked(browser))?.detail.split("\n")[0], "user[password], csrf_token");
  choose(browser, "once");
  assert.match(text(await revealing), /Payload:\nuser%5Bemail%5D=ada&user%5Bpassword%5D=hunter2&csrf_token=t1&remember=1\n/);
  const cutOff = run(tools.browser_network, { request_id: "r6", body: false, reveal: true });
  assert.equal((await asked(browser))?.detail.split("\n")[0], "payload");
  choose(browser, "once");
  assert.match(text(await cutOff), /"password":"hunter2"/);
  assert.equal(browser.prompt("s1"), null);
});

test("secrets in URL parameters stay hidden", () => {
  assert.equal(hideUrlSecrets("https://a.test/cb?code=xyz&state=1&access_token=t"), "https://a.test/cb?code=%5Bhidden%5D&state=1&access_token=%5Bhidden%5D");
  assert.equal(hideUrlSecrets("https://a.test/search?q=1"), "https://a.test/search?q=1");
  assert.equal(hideUrlSecrets("https://a.test/login?user[password]=x&user[name]=ada"), "https://a.test/login?user%5Bpassword%5D=%5Bhidden%5D&user%5Bname%5D=ada");
});

test("screenshots and tab lists need no permission", async () => {
  const { browser, tools } = setup();
  const shot = await run(tools.browser_screenshot, {});
  assert.equal(shot.content[0]?.type, "image");
  assert.equal(shot.content[0]?.mimeType, "image/jpeg");
  assert.match(text(shot), /the page is 1440×900, shown shrunk to 1280×800/);
  // x and y read from the shrunk picture land where the person sees them on the page.
  const { tools: clicking, sent } = setup("full");
  await run(clicking.browser_screenshot, {});
  await run(clicking.browser_click, { x: 640, y: 400 });
  const press = sent.find((call) => call.args.method === "Input.dispatchMouseEvent" && (call.args.params as { type: string }).type === "mousePressed")?.args.params as { x: number; y: number };
  assert.deepEqual([press.x, press.y], [720, 450]);
  assert.equal(text(await run(tools.browser_tabs, {})), "1 (current): Example Domain — https://example.com/", "a chat lists only its own tabs");
  assert.match(text(await run(tools.browser_tabs, { action: "switch", tab: 9 })), /This chat has no tab 9/, "another chat's tab is out of reach");
  assert.match(text(await run(tools.browser_read_page, {}, "s2")), /^Other chat \(https:\/\/other\.test\/\), tab 9/, "each chat reads its own current tab");
  assert.equal(browser.prompt("s1"), null);
});

test("without the app, the tools say the browser runs in it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-tools-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tools = browserTools(createBrowser(dir)).tools;
  const read = tools.find((tool) => tool.spec.name === "browser_read_page");
  await assert.rejects(Promise.resolve(read?.call({}, { sessionId: "s1", signal: new AbortController().signal })), /runs in the X Bench app/);
});

test("URLs get a scheme, and only http and https open", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("localhost:5173/app"), "http://localhost:5173/app");
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.equal(normalizeUrl("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000/x");
  assert.equal(normalizeUrl("javascript:alert(1)"), "");
  assert.equal(normalizeUrl("file:///etc/passwd"), "");
  assert.equal(normalizeUrl("  "), "");
  assert.equal(normalizeUrl("example.com:8080/app"), "https://example.com:8080/app", "host:port is not a scheme");
});

test("keys map to Chrome's key events, with editing commands for shortcuts", () => {
  assert.deepEqual(keyPress("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0, commands: [] });
  assert.deepEqual(keyPress("cmd+a"), { key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 4, commands: ["selectAll"] });
  assert.equal(keyPress("shift+Tab")?.modifiers, 8);
  assert.equal(keyPress("shift+b")?.key, "B");
  assert.equal(keyPress("hyper+a"), null);
  assert.equal(keyPress("F13"), null);
});

test("the page mark is read from any output shape, and anything else is no card", () => {
  const line = `Opened "A" at https://a.test/ in tab 2.\n${PAGE_MARK} {"tab":2,"url":"https://a.test/","title":"A","thumb":"0123456789ab"}`;
  const mark = { tab: 2, url: "https://a.test/", title: "A", thumb: "0123456789ab" };
  assert.deepEqual(pageMarkOf(line), mark);
  assert.deepEqual(pageMarkOf({ type: "MCP", output: { OkayOutput: line } }), mark);
  assert.deepEqual(pageMarkOf([{ type: "text", text: line }]), mark);
  assert.equal(pageMarkOf(line.replace("0123456789ab", "../x"))?.thumb, null);
  assert.equal(pageMarkOf(`${PAGE_MARK} not json`), null);
  assert.equal(pageMarkOf("plain output"), null);
  assert.equal(pageMarkOf(line.replaceAll("https://a.test/", "javascript:alert(1)")), null, "a card only opens web pages");
  assert.ok(NAVIGATE_TOOL.test("mcp__x_bench__browser_navigate") && NAVIGATE_TOOL.test("mcp.x_bench.browser_navigate") && NAVIGATE_TOOL.test("x_bench__browser_navigate"));
  assert.equal(NAVIGATE_TOOL.test("mcp__x_bench__browser_read_page"), false, "a page's text cannot fake a card");
  assert.equal(NAVIGATE_TOOL.test("echo x_bench__browser_navigate"), false, "nor a shell command that names the tool");
  assert.deepEqual(pageMarkOf(`Opened "${PAGE_MARK} {}" at https://a.test/ in tab 2.\n${PAGE_MARK} ${JSON.stringify(mark)}`), mark, "a title that holds the mark does not hide the card");
});
