import assert from "node:assert/strict";
import test from "node:test";
import { browserLabel } from "./browserLabel.ts";

test("each harness's name for a browser tool gets a plain label", () => {
  assert.equal(browserLabel("mcp__x_bench__browser_navigate", { url: "https://example.com/a" }), "Open example.com");
  assert.equal(browserLabel("x_bench__browser_navigate", { url: "news.ycombinator.com" }), "Open news.ycombinator.com");
  assert.equal(browserLabel("mcp.x_bench.browser_read_page", { mode: "text" }), "Read the page's text");
  assert.equal(browserLabel("mcp__x_bench__browser_navigate", { url: "back" }), "Go back in the browser");
  assert.equal(browserLabel("mcp__x_bench__browser_type", { text: "hello world" }), 'Type "hello world"');
  assert.equal(browserLabel("mcp__x_bench__browser_press_key", { keys: "cmd+a" }), "Press cmd+a");
  assert.equal(browserLabel("mcp__x_bench__browser_tabs", { action: "switch", tab: 2 }), "Switch to tab 2");
  assert.equal(browserLabel("mcp__x_bench__browser_screenshot", {}), "Take a screenshot");
  assert.equal(browserLabel("mcp__x_bench__browser_click", { ref: "ref_1", clicks: 3 }), "Triple-click on the page");
  assert.equal(browserLabel("mcp__x_bench__browser_click", { button: "right" }), "Right-click on the page");
  assert.equal(browserLabel("mcp__x_bench__browser_scroll_to", { ref: "ref_1" }), "Scroll to an element");
  assert.equal(browserLabel("mcp__x_bench__browser_console", { only_errors: true }), "Read console errors");
  assert.equal(browserLabel("mcp__x_bench__browser_resize", { preset: "mobile", color_scheme: "dark" }), "View at mobile in dark mode");
  assert.equal(browserLabel("mcp__x_bench__browser_form_input", { ref: "ref_3", value: "Germany" }), 'Set a field to "Germany"');
});

test("other servers' browser tools and other tools keep their own labels", () => {
  assert.equal(browserLabel("mcp__playwright__browser_click", {}), null);
  assert.equal(browserLabel("mcp__x_bench__suggest_task", {}), null);
  assert.equal(browserLabel("Read", { file_path: "a" }), null);
});
