import assert from "node:assert/strict";
import test from "node:test";
import { simulatorLabel } from "./simulatorLabel.ts";

test("each harness's name for a simulator tool gets a plain label", () => {
  assert.equal(simulatorLabel("mcp__x_bench__simulator_tap", { ref: "e4" }), "Tap e4");
  assert.equal(simulatorLabel("x_bench__simulator_tap", { ref: "e4" }), "Tap e4");
  assert.equal(simulatorLabel("mcp.x_bench.simulator_tap", { ref: "e4" }), "Tap e4");
});

test("each simulator tool reads as a step built from its arguments", () => {
  const label = (tool: string, input: object) => simulatorLabel(`mcp__x_bench__simulator_${tool}`, input);
  assert.equal(label("list_devices", {}), "List devices");
  assert.equal(label("boot", { device: "iPhone 17 Pro" }), "Start iPhone 17 Pro");
  assert.equal(label("build", { scheme: "Sample", wait_seconds: 60 }), "Build Sample");
  assert.equal(label("build_status", { build_id: "b3" }), "Check build b3");
  assert.equal(label("install", { app_path: "build/Debug-iphonesimulator/Sample.app/" }), "Install Sample.app");
  assert.equal(label("launch", { app_id: "com.example.sample" }), "Launch com.example.sample");
  assert.equal(label("screenshot", {}), "Take a screenshot");
  assert.equal(label("read_screen", {}), "Read the screen");
  assert.equal(label("read_screen", { filter: "interactive" }), "Read the screen's controls");
  assert.equal(label("tap", { x: 205.4, y: 841 }), "Tap (205, 841)");
  assert.equal(label("tap", { ref: "e4", hold_seconds: 1 }), "Long-press e4");
  assert.equal(label("swipe", { from_ref: "e3", to_ref: "e7" }), "Swipe from e3 to e7");
  assert.equal(label("swipe", { from_x: 200, from_y: 700, to_x: 200, to_y: 200 }), "Swipe up");
  assert.equal(label("swipe", { from_x: 300, from_y: 400, to_x: 20, to_y: 410 }), "Swipe left");
  assert.equal(label("swipe", { from_ref: "e3", to_x: 200, to_y: 100 }), "Swipe from e3 to (200, 100)");
  assert.equal(label("touch_path", { points: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }), "Drag along a path");
  assert.equal(label("touch_path", { points: [{ x: 1, y: 1 }, { x: 9, y: 9 }], points2: [{ x: 5, y: 5 }, { x: 2, y: 2 }] }), "Pinch");
  assert.equal(label("type", { text: "Hallo Grüße" }), 'Type "Hallo Grüße"');
  assert.equal(label("type", { text: "Ada", ref: "e3", submit: true }), 'Type "Ada" into e3 and press Return');
  assert.equal(label("press", { button: "home" }), "Press Home");
  assert.equal(label("press", { button: "back" }), "Press Back");
  assert.equal(label("press", { button: "enter" }), "Press Return");
  assert.equal(label("press", { button: "side", hold_seconds: 3 }), "Hold the side button");
  assert.equal(label("open_url", { url: "https://example.com/a?b=1" }), "Open example.com");
  assert.equal(label("open_url", { url: "sample://settings/profile" }), "Open sample://settings/profile");
  assert.equal(label("app_log", { app_id: "com.example.sample" }), "Read com.example.sample's log");
  assert.equal(label("appearance", { mode: "dark" }), "Switch to dark mode");
});

test("other servers' simulator tools and other tools keep their own labels", () => {
  assert.equal(simulatorLabel("mcp__ios__simulator_tap", {}), null);
  assert.equal(simulatorLabel("mcp__x_bench__browser_click", {}), null);
  assert.equal(simulatorLabel("Bash", { command: "ls" }), null);
});
