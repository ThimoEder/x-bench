import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpTool, ToolResult } from "../../mcp/mcp.ts";
import { PROMPT_OPTIONS, createPrompts, type HostPrompt } from "../../chat/prompts.ts";
import type { RunCommand } from "../../runProcess.ts";
import type { SimHelper, SimHelpers } from "./simHelper.ts";
import { createSimulator } from "../simulator.ts";
import { APP_MARK, appMarkOf, simulatorTools, type SettleOptions } from "./simulatorTools.ts";
import { createBuilds } from "./xcodeBuild.ts";

const PHONE = "16CCC597-962C-4BF1-902E-8C412D8C45C2";
const PAD = "6C98A02A-A41D-496A-8AB7-8D91D1785993";

const TREE = [
  {
    type: "Application",
    AXLabel: "Sample",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [{ type: "Button", AXLabel: "Continue", AXUniqueId: "continueButton", frame: { x: 16, y: 295, width: 370, height: 52 }, children: [] }],
  },
];

// A PNG header for a 1206×2622 screen, enough for pngSize.
function png(): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(1206, 16);
  buffer.writeUInt32BE(2622, 20);
  return buffer;
}

interface Setup {
  tools: Record<string, McpTool>;
  ran: string[];
  inputs: string[];
  simulator: ReturnType<typeof createSimulator>;
  helped: { op: string; args: Record<string, unknown> }[];
  focused: string[];
  prompts: ReturnType<typeof createPrompts>;
}

// A tree with one button, labelled as given.
function treeWith(label: string) {
  return [{ ...TREE[0], children: [{ type: "Button", AXLabel: label, frame: { x: 16, y: 400, width: 370, height: 52 }, children: [] }] }];
}

interface Extra {
  describe?: () => Promise<unknown>;
  // Sees each helper request before it answers.
  onCall?: (op: string, args: Record<string, unknown>) => void;
  settle?: Partial<SettleOptions>;
  stepsMs?: number;
  pasteboard?: () => string;
}

function setup(mode: string | null = "auto", booted = [PHONE], extra: Extra = {}): Setup {
  const ran: string[] = [];
  const inputs: string[] = [];
  const helped: Setup["helped"] = [];
  const focused: string[] = [];
  const list = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
        { udid: PHONE, name: "iPhone 17 Pro", state: booted.includes(PHONE) ? "Booted" : "Shutdown", isAvailable: true, deviceTypeIdentifier: "phone" },
        { udid: PAD, name: "iPad Pro 13-inch (M5)", state: booted.includes(PAD) ? "Booted" : "Shutdown", isAvailable: true, deviceTypeIdentifier: "pad" },
      ],
    },
  };
  const run: RunCommand = async (command, args, options) => {
    const line = [path.basename(command), ...args].join(" ");
    ran.push(line);
    if (options?.input !== undefined) inputs.push(options.input);
    const out = (text: string) => ({ stdout: Buffer.from(text) });
    if (line.startsWith("xcrun simctl list devices")) return out(JSON.stringify(list));
    if (line.startsWith("xcrun simctl list devicetypes")) return out(JSON.stringify({ devicetypes: [{ identifier: "phone", bundlePath: "/types/phone.simdevicetype" }] }));
    if (line.startsWith("plutil -extract mainScreenScale")) return out("3\n");
    if (line.startsWith("xcrun simctl io")) writeFileSync(args[args.length - 1] ?? "", png());
    if (line.startsWith("sips")) writeFileSync(args[args.length - 1] ?? "", "jpeg");
    if (line.startsWith("xcrun simctl launch")) return out("com.example.sample: 4242\n");
    if (line.startsWith("xcrun simctl appinfo")) return out("{\n    CFBundleDisplayName = Sample;\n    CFBundleExecutable = Sample;\n}\n");
    if (line.startsWith("adb devices")) return out("List of devices attached\n\n");
    if (line.startsWith("xcrun simctl pbpaste")) return out(extra.pasteboard?.() ?? "");
    return out("");
  };
  const helper: SimHelper = {
    info: { width: 402, height: 874, widthPixels: 1206, heightPixels: 2622 },
    async call<T>(op: string, args: Record<string, unknown> = {}) {
      helped.push({ op, args });
      extra.onCall?.(op, args);
      if (op === "describe") return (await (extra.describe?.() ?? TREE)) as T;
      return {} as T;
    },
    post(op, args = {}) {
      helped.push({ op, args });
    },
    onFrame: () => () => {},
    onExit: () => () => {},
    alive: () => true,
  };
  const helpers: SimHelpers = { path: () => "/fake/xbench-sim", get: async () => helper };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-sim-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const simulator = createSimulator({ run, helpers, android: { emulator: "/missing/emulator" }, logDir: dir });
  const prompts = createPrompts(() => {});
  const group = simulatorTools(simulator, createBuilds({ dir }), prompts, {
    modeOf: () => mode,
    cwdOf: () => dir,
    saveThumb: () => "0123456789ab",
    focus: (owner, device) => focused.push(`${owner} ${device}`),
    settleMs: 0,
    settle: { delayMs: 0, intervalMs: 0, capMs: 1000, ...extra.settle },
    stepsMs: extra.stepsMs,
  });
  return { tools: Object.fromEntries(group.tools.map((tool) => [tool.spec.name, tool])), ran, inputs, simulator, helped, focused, prompts };
}

function run(tool: McpTool | undefined, args: unknown, sessionId: string | null = "s1"): Promise<ToolResult> {
  assert.ok(tool, "no such tool");
  return Promise.resolve(tool.call(args, { sessionId, signal: new AbortController().signal }));
}

// A prompt's own id for one of its options.
function optionOf(prompt: HostPrompt | null, kind: string): string {
  return prompt?.options.find((option) => option.optionId.startsWith(`${kind}:`))?.optionId ?? "";
}

function text(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

test("the screen's tree hands out refs that a tap goes to", async () => {
  const { tools, helped } = setup();
  const tree = text(await run(tools.simulator_read_screen, {}));
  assert.match(tree, /- Button "Continue" id=continueButton \(16,295 370×52\) \[e2\]/);
  const tapped = await run(tools.simulator_tap, { ref: "e2", read_after: false });
  assert.equal(text(tapped), 'Tapped Button "Continue" [e2] on iPhone 17 Pro.');
  assert.deepEqual(helped.at(-1), { op: "tap", args: { x: 201, y: 321, hold: 0 } });
  const missing = run(tools.simulator_tap, { ref: "e9" });
  await assert.rejects(missing, /e9 is not on the latest read/);
});

test("a screenshot comes back at one pixel per point", async () => {
  const { tools, ran } = setup();
  const result = await run(tools.simulator_screenshot, {});
  assert.equal(result.content[0]?.type, "image");
  assert.equal(result.content[1]?.text, "iPhone 17 Pro (iOS 26.2), 402×874 points. Give x and y as read from this picture.");
  assert.ok(ran.some((line) => line.startsWith("sips") && line.includes("-Z 874")));
});

test("acting tools ask in modes other than Auto, and always holds for the device", async () => {
  const { tools, prompts, helped } = setup("ask");
  const first = run(tools.simulator_press, { button: "home", read_after: false });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const prompt = prompts.prompt("s1");
  assert.equal(prompt?.title, "Press the home button on iPhone 17 Pro");
  assert.deepEqual(prompt?.options.map((option) => option.name), ["Allow once", "Always allow on iPhone 17 Pro", "Deny"]);
  prompts.answer("s1", optionOf(prompt, PROMPT_OPTIONS.site));
  assert.equal(text(await first), "Pressed the home button on iPhone 17 Pro.");
  assert.equal(text(await run(tools.simulator_type, { text: "Ada", submit: true, read_after: false })), 'Typed "Ada" and pressed Return on iPhone 17 Pro.');
  assert.deepEqual(helped.slice(-2), [{ op: "type", args: { text: "Ada" } }, { op: "key", args: { code: 40, hold: 0.02 } }]);
  assert.equal(prompts.prompt("s1"), null);
});

test("a declined action tells the agent to ask the person", async () => {
  const { tools, prompts, helped } = setup(null);
  const tap = run(tools.simulator_tap, { x: 10, y: 20 });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  prompts.answer("s1", optionOf(prompts.prompt("s1"), PROMPT_OPTIONS.deny));
  const result = await tap;
  assert.equal(result.isError, true);
  assert.match(text(result), /declined/);
  assert.equal(helped.length, 0);
});

test("reading never asks", async () => {
  const { tools, prompts } = setup(null);
  await run(tools.simulator_read_screen, {});
  await run(tools.simulator_screenshot, {});
  assert.equal(prompts.prompt("s1"), null);
});

test("launching an app shows its card and brings the Device tab up for the chat", async () => {
  const { tools, focused } = setup();
  const result = text(await run(tools.simulator_launch, { app_id: "com.example.sample" }));
  assert.match(result, /^Launched Sample \(com.example.sample\) on iPhone 17 Pro \(iOS 26.2\), pid 4242\./);
  assert.deepEqual(appMarkOf(result), { device: PHONE, deviceName: "iPhone 17 Pro", appId: "com.example.sample", name: "Sample", thumb: "0123456789ab" });
  assert.deepEqual(focused, [`s1 ${PHONE}`]);
  assert.equal(appMarkOf("no card here"), null);
  assert.equal(appMarkOf(`${APP_MARK} {"device":"x"}`), null);
});

test("with several devices running, a call names one", async () => {
  const { tools } = setup("auto", [PHONE, PAD]);
  await assert.rejects(run(tools.simulator_screenshot, {}), /Several devices are running/);
  const named = await run(tools.simulator_screenshot, { device: "iPad" });
  assert.match(named.content[1]?.text ?? "", /^iPad Pro 13-inch \(M5\)/);
});

test("two fingers move together along a path", async () => {
  const { tools, helped } = setup();
  const result = await run(tools.simulator_touch_path, { points: [{ x: 150, y: 400 }, { x: 100, y: 350, dt_ms: 50 }], points2: [{ x: 250, y: 500 }, { x: 300, y: 550 }], read_after: false });
  assert.equal(text(result), "Dragged two fingers along a 2-point path from (150, 400) to (100, 350) on iPhone 17 Pro.");
  assert.deepEqual(helped.at(-1), {
    op: "path",
    args: {
      points: [
        { x: 150, y: 400, dt: 0 },
        { x: 100, y: 350, dt: 50 },
      ],
      points2: [
        { x: 250, y: 500, dt: 0 },
        { x: 300, y: 550, dt: 50 },
      ],
    },
  });
  const uneven = await run(tools.simulator_touch_path, { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], points2: [{ x: 1, y: 1 }] });
  assert.equal(uneven.isError, true);
  const slow = await run(tools.simulator_touch_path, { points: [{ x: 1, y: 1 }, ...Array.from({ length: 7 }, () => ({ x: 2, y: 2, dt_ms: 5000 }))] });
  assert.equal(text(slow), "Keep a path under 30 seconds in all.");
});

test("an action answers with the screen's controls, and their refs replace the chat's", async () => {
  const { tools, helped } = setup();
  await run(tools.simulator_read_screen, {});
  const tapped = text(await run(tools.simulator_tap, { ref: "e2" }));
  assert.equal(
    tapped,
    'Tapped Button "Continue" [e2] on iPhone 17 Pro.\n\nThe screen\'s controls now, with refs (simulator_read_screen shows text and everything else):\n- Button "Continue" id=continueButton (16,295 370×52) [e1]',
  );
  assert.deepEqual(
    helped.slice(-3).map((call) => call.op),
    ["tap", "describe", "describe"],
  );
  await assert.rejects(run(tools.simulator_tap, { ref: "e2" }), /e2 is not on the latest read/);
  assert.match(text(await run(tools.simulator_press, { button: "home" })), /^Pressed the home button on iPhone 17 Pro\.\n\nThe screen's controls now.*\n- Button "Continue".*\[e1\]$/);
  assert.match(text(await run(tools.simulator_swipe, { from_ref: "e1", to_x: 200, to_y: 100 })), /\[e1\]$/);
});

test("read_after false answers with the action alone and keeps the chat's refs", async () => {
  const { tools, helped } = setup();
  await run(tools.simulator_read_screen, {});
  const reads = helped.filter((call) => call.op === "describe").length;
  assert.equal(text(await run(tools.simulator_type, { text: "Ada", ref: "e2", read_after: false })), 'Typed "Ada" into Button "Continue" [e2] on iPhone 17 Pro.');
  assert.equal(helped.filter((call) => call.op === "describe").length, reads);
  assert.match(text(await run(tools.simulator_tap, { ref: "e2", read_after: false })), /^Tapped Button "Continue" \[e2\]/);
});

test("the read after an action waits until two reads agree", async () => {
  const labels = ["Loading", "Hello", "Done", "Done"];
  let reads = 0;
  const { tools } = setup("auto", [PHONE], { describe: async () => treeWith(labels[Math.min(reads++, labels.length - 1)] ?? "") });
  const result = text(await run(tools.simulator_tap, { x: 10, y: 20 }));
  assert.equal(reads, 4);
  assert.match(result, /- Button "Done" \(16,400 370×52\) \[e1\]$/);
  assert.doesNotMatch(result, /still changing/);
});

test("a screen that keeps changing stops the read at its cap", async () => {
  let reads = 0;
  const { tools } = setup("auto", [PHONE], { describe: async () => treeWith(`Frame ${reads++}`), settle: { intervalMs: 20, capMs: 200 } });
  const started = Date.now();
  const result = text(await run(tools.simulator_tap, { x: 10, y: 20 }));
  assert.ok(Date.now() - started < 600, "the read ran past its cap");
  assert.match(result, /- Button "Frame \d+" .*\[e1\]\n\nThe screen was still changing after 0.2 s, so read it again if this looks out of date\.$/);
});

test("a read slower than the cap is left out and keeps the chat's refs", async () => {
  let slow = false;
  const { tools } = setup("auto", [PHONE], { describe: () => (slow ? new Promise(() => {}) : Promise.resolve(TREE)), settle: { capMs: 100 } });
  await run(tools.simulator_read_screen, {});
  slow = true;
  const started = Date.now();
  const result = await run(tools.simulator_tap, { ref: "e2" });
  assert.ok(Date.now() - started < 500, "the read ran past its cap");
  assert.equal(result.isError, false);
  assert.equal(text(result), 'Tapped Button "Continue" [e2] on iPhone 17 Pro.\n\nReading the screen took over 0.1 s, so it is left out. Look with simulator_read_screen, or simulator_screenshot.');
  assert.match(text(await run(tools.simulator_tap, { ref: "e2", read_after: false })), /^Tapped Button "Continue" \[e2\]/);
});

test("a failing read never fails the action", async () => {
  let broken = false;
  const { tools, helped } = setup("auto", [PHONE], {
    describe: async () => {
      if (broken) throw new Error("The helper stopped.");
      return TREE;
    },
  });
  await run(tools.simulator_read_screen, {});
  broken = true;
  const result = await run(tools.simulator_type, { text: "Ada", submit: true });
  assert.equal(result.isError, false);
  assert.equal(text(result), 'Typed "Ada" and pressed Return on iPhone 17 Pro.\n\nX Bench couldn\'t read the screen afterwards (The helper stopped). Look with simulator_read_screen, or simulator_screenshot.');
  assert.ok(helped.some((call) => call.op === "type"));
  assert.match(text(await run(tools.simulator_tap, { ref: "e2", read_after: false })), /^Tapped Button "Continue" \[e2\]/);
});

test("a read that fails after a good one reports the failure and keeps the chat's refs", async () => {
  let reads = 0;
  const { tools } = setup("auto", [PHONE], {
    describe: async () => {
      reads += 1;
      if (reads === 3) throw new Error("The helper stopped.");
      return reads === 1 ? TREE : treeWith("Loading");
    },
  });
  await run(tools.simulator_read_screen, {});
  const result = text(await run(tools.simulator_tap, { ref: "e2" }));
  assert.equal(result, 'Tapped Button "Continue" [e2] on iPhone 17 Pro.\n\nX Bench couldn\'t read the screen afterwards (The helper stopped). Look with simulator_read_screen, or simulator_screenshot.');
  assert.match(text(await run(tools.simulator_tap, { ref: "e2", read_after: false })), /^Tapped Button "Continue" \[e2\]/);
});

test("no read starts once the cap has run out", async () => {
  let reads = 0;
  const { tools } = setup("auto", [PHONE], { describe: async () => treeWith(`Frame ${reads++}`), settle: { delayMs: 60, capMs: 50 } });
  const result = text(await run(tools.simulator_tap, { x: 10, y: 20 }));
  assert.equal(reads, 0);
  assert.match(result, /Reading the screen took over 0.1 s, so it is left out\./);
});

test("an empty tree points to the full read and a screenshot", async () => {
  const { tools } = setup("auto", [PHONE], { describe: async () => [] });
  assert.match(text(await run(tools.simulator_press, { button: "home" })), /No control on the screen exposes accessibility information\. Read all of it with simulator_read_screen, or take a simulator_screenshot\.\)$/);
});

// The sample app: a name field and Continue, which opens a screen with a greeting and a "Tap me" button.
function sampleApp(mode: string | null = "auto", extra: Extra = {}) {
  let screen = 1;
  const first = [
    {
      type: "Application",
      AXLabel: "Sample",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        { type: "TextField", AXLabel: "Name", frame: { x: 16, y: 200, width: 370, height: 44 }, children: [] },
        { type: "Button", AXLabel: "Continue", AXUniqueId: "continueButton", frame: { x: 16, y: 295, width: 370, height: 52 }, children: [] },
      ],
    },
  ];
  const second = [
    {
      type: "Application",
      AXLabel: "Sample",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        { type: "StaticText", AXLabel: "Hello, Ada", frame: { x: 16, y: 120, width: 370, height: 30 }, children: [] },
        { type: "Button", AXLabel: "Tap me", frame: { x: 16, y: 400, width: 370, height: 52 }, children: [] },
      ],
    },
  ];
  const app = setup(mode, [PHONE], {
    describe: async () => (screen === 1 ? first : second),
    onCall: (op, args) => {
      if (op === "tap" && args.y === 321) screen = 2;
    },
    ...extra,
  });
  return { ...app, screen: () => screen };
}

test("a list of steps runs in order, reaches the next screen through a target, and answers with the whole screen", async () => {
  const { tools, helped, screen } = sampleApp();
  assert.match(text(await run(tools.simulator_read_screen, {})), /TextField "Name" \(16,200 370×44\) \[e2\]/);
  const result = await run(tools.simulator_steps, {
    steps: [
      { action: "type", text: "Ada", ref: "e2" },
      { action: "tap", ref: "e3" },
      { action: "wait_for", target: "hello, ada" },
      { action: "tap", target: "Tap me" },
      { action: "pause", ms: 5 },
    ],
  });
  assert.equal(result.isError, false);
  assert.equal(screen(), 2);
  assert.match(
    text(result),
    /^Ran 5 of 5 steps on iPhone 17 Pro in [\d.]+ s:\n1\. Typed "Ada" into TextField "Name" \[e2\]\.\n2\. Tapped Button "Continue" \[e3\]\.\n3\. Saw "hello, ada" show after [\d.]+ s\.\n4\. Tapped Button "Tap me"\.\n5\. Paused 5 ms\.\n\nThe screen now, with refs:\n- Application "Sample" \(0,0 402×874\) \[e1\]\n  - StaticText "Hello, Ada" \(16,120 370×30\) \[e2\]\n  - Button "Tap me" \(16,400 370×52\) \[e3\]$/,
  );
  assert.deepEqual(
    helped.filter((call) => call.op !== "describe"),
    [
      { op: "tap", args: { x: 201, y: 222, hold: 0 } },
      { op: "type", args: { text: "Ada" } },
      { op: "tap", args: { x: 201, y: 321, hold: 0 } },
      { op: "tap", args: { x: 201, y: 426, hold: 0 } },
    ],
  );
  assert.match(text(await run(tools.simulator_tap, { ref: "e3", read_after: false })), /^Tapped Button "Tap me" \[e3\]/);
});

test("later steps take refs from a wait_for's read", async () => {
  const { tools, helped } = sampleApp();
  await run(tools.simulator_read_screen, {});
  const result = await run(tools.simulator_steps, { steps: [{ action: "tap", ref: "e3" }, { action: "wait_for", target: "Tap me" }, { action: "tap", ref: "e1" }], read_after: false });
  assert.match(text(result), /\n3\. Tapped Button "Tap me" \[e1\]\.$/);
  assert.deepEqual(helped.at(-1), { op: "tap", args: { x: 201, y: 426, hold: 0 } });
});

test("a failing step stops the list, says why, and answers with the screen", async () => {
  const { tools, helped } = sampleApp("auto", { settle: { intervalMs: 20 } });
  await run(tools.simulator_read_screen, {});
  const timedOut = await run(tools.simulator_steps, {
    steps: [{ action: "tap", target: "Continue" }, { action: "wait_for", target: "Goodbye", timeout_seconds: 0.5 }, { action: "press", button: "home" }, { action: "pause", ms: 1 }],
  });
  assert.equal(timedOut.isError, true);
  assert.match(
    text(timedOut),
    /^Ran 1 of 4 steps on iPhone 17 Pro in [\d.]+ s:\n1\. Tapped Button "Continue"\.\n/,
  );
  assert.match(text(timedOut), /\n\nStep 2 \(Wait up to 0\.5 s for "Goodbye" to show\) failed: "Goodbye" did not show on the screen for 0\.5 s\.\nSteps 3 to 4 did not run\.\n\nThe screen now, with refs:\n.*\n  - StaticText "Hello, Ada" .*\n  - Button "Tap me" .*\[e3\]$/);
  assert.equal(helped.filter((call) => call.op === "button").length, 0);

  const gone = await run(tools.simulator_steps, { steps: [{ action: "wait_for", target: "Tap me" }, { action: "tap", ref: "e4" }, { action: "pause", ms: 1 }], read_after: false });
  assert.equal(gone.isError, true);
  assert.match(text(gone), /^Ran 1 of 3 steps .*\n1\. Saw "Tap me" show after [\d.]+ s\.\n\nStep 2 \(Tap e4\) failed: e4 is not on the latest read of iPhone 17 Pro's screen\. .*\nStep 3 did not run\.$/s);
});

test("a ref missing before the list starts fails it before anything runs", async () => {
  const { tools, helped, prompts } = sampleApp("ask");
  await run(tools.simulator_read_screen, {});
  const result = await run(tools.simulator_steps, { steps: [{ action: "pause", ms: 1 }, { action: "tap", ref: "e9" }] });
  assert.equal(result.isError, true);
  assert.match(text(result), /^Step 2: e9 is not on the latest read of iPhone 17 Pro's screen\..* No step ran\.$/);
  assert.equal(text(await run(tools.simulator_steps, { steps: [{ action: "jump" }] })), "Step 1: Give the step an action, one of tap, type, press, swipe, wait_for, pause. No step ran.");
  assert.equal(text(await run(tools.simulator_steps, { steps: [] })), "Give steps, a list of actions to run in order.");
  assert.equal(prompts.prompt("s1"), null);
  assert.equal(helped.filter((call) => call.op !== "describe").length, 0);
});

test("a list runs at most 30 steps", async () => {
  const { tools } = sampleApp();
  const result = text(await run(tools.simulator_steps, { steps: Array.from({ length: 32 }, () => ({ action: "pause", ms: 0 })), read_after: false }));
  assert.match(result, /^Ran 30 of 32 steps .*\n30\. Paused 0 ms\.\n\nSteps 31 to 32 did not run: one call runs at most 30 steps\.$/s);
});

test("a list stops at its time limit", async () => {
  const { tools } = sampleApp("auto", { stepsMs: 300, settle: { intervalMs: 20 } });
  const paused = text(await run(tools.simulator_steps, { steps: [{ action: "pause", ms: 200 }, { action: "pause", ms: 200 }, { action: "press", button: "home" }], read_after: false }));
  assert.match(paused, /^Ran 2 of 3 steps .*\n1\. Paused 200 ms\.\n2\. Paused \d+ ms\.\n\nStep 3 did not run: the list reached its 0\.3 s limit\.$/);
  const waited = await run(tools.simulator_steps, { steps: [{ action: "wait_for", target: "Goodbye" }], read_after: false });
  assert.match(text(waited), /failed: "Goodbye" did not show on the screen for 0\.3 s, when the list's 0\.3 s limit ran out\.$/);
});

test("the whole list asks once, with every step in plain words", async () => {
  const { tools, prompts, helped } = sampleApp("ask");
  await run(tools.simulator_read_screen, {});
  const args = {
    steps: [
      { action: "type", text: "Ada", ref: "e2", submit: true },
      { action: "tap", ref: "e3" },
      { action: "wait_for", target: "Tap me" },
      { action: "tap", ref: "e1", hold_seconds: 1 },
      { action: "swipe", from_x: 200, from_y: 600, to_x: 200, to_y: 200 },
      { action: "press", button: "home" },
      { action: "pause", ms: 300 },
    ],
    read_after: false,
  };
  const denied = run(tools.simulator_steps, args);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const prompt = prompts.prompt("s1");
  assert.equal(prompt?.title, "Run 7 steps on iPhone 17 Pro");
  assert.equal(
    prompt?.detail,
    [
      '1. Type "Ada" into TextField "Name" [e2] and press Return',
      '2. Tap Button "Continue" [e3]',
      '3. Wait up to 10 s for "Tap me" to show',
      "4. Long-press e1 for 1 s",
      "5. Swipe from (200, 600) to (200, 200)",
      "6. Press the home button",
      "7. Pause 300 ms",
    ].join("\n"),
  );
  assert.deepEqual(prompt?.options.map((option) => option.name), ["Allow once", "Always allow on iPhone 17 Pro", "Deny"]);
  prompts.answer("s1", optionOf(prompt, PROMPT_OPTIONS.deny));
  assert.match(text(await denied), /declined/);
  assert.equal(helped.filter((call) => call.op !== "describe").length, 0);

  const allowed = run(tools.simulator_steps, args);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  prompts.answer("s1", optionOf(prompts.prompt("s1"), PROMPT_OPTIONS.site));
  const result = await allowed;
  assert.equal(result.isError, false);
  assert.match(text(result), /^Ran 7 of 7 steps/);
  assert.equal(prompts.prompt("s1"), null);
  assert.deepEqual(
    helped.filter((call) => call.op !== "describe").map((call) => call.op),
    ["tap", "type", "key", "tap", "tap", "path", "button"],
  );
  assert.match(text(await run(tools.simulator_steps, { steps: [{ action: "press", button: "home" }], read_after: false })), /^Ran 1 of 1 step /);
  assert.equal(prompts.prompt("s1"), null);
});

test("a turn stopped during a step's read sends nothing more to the device", async () => {
  const stop = new AbortController();
  let reads = 0;
  const { tools, helped } = sampleApp("auto", {
    describe: async () => {
      reads += 1;
      if (reads === 2) stop.abort();
      return TREE;
    },
  });
  const tool = tools.simulator_steps;
  assert.ok(tool);
  const result = await tool.call({ steps: [{ action: "tap", target: "Continue" }, { action: "press", button: "home" }] }, { sessionId: "s1", signal: stop.signal });
  assert.equal(result.isError, false);
  assert.match(text(result), /^Ran 0 of 2 steps on iPhone 17 Pro in [\d.]+ s\.\n\nThe turn was stopped during step 1; step 2 did not run\.$/);
  assert.deepEqual(
    helped.map((call) => call.op),
    ["describe", "describe"],
  );
});

test("a hold or swipe that would end past the list's limit does not start", async () => {
  const { tools, helped } = sampleApp("auto", { stepsMs: 300 });
  const held = await run(tools.simulator_steps, { steps: [{ action: "press", button: "home", hold_seconds: 1 }, { action: "pause", ms: 1 }], read_after: false });
  assert.equal(held.isError, true);
  assert.match(text(held), /\n\nStep 1 \(Press the home button for 1 s\) failed: A 1 s hold does not fit in the 0\.3 s the list has left\.\nStep 2 did not run\.$/);
  const swiped = await run(tools.simulator_steps, { steps: [{ action: "swipe", from_x: 200, from_y: 600, to_x: 200, to_y: 200, duration_seconds: 2 }], read_after: false });
  assert.match(text(swiped), /failed: A 2 s swipe does not fit in the 0\.3 s the list has left\.$/);
  assert.equal(helped.filter((call) => call.op !== "describe").length, 0);
  assert.match(text(await run(tools.simulator_steps, { steps: [{ action: "press", button: "home", hold_seconds: 0.1 }], read_after: false })), /^Ran 1 of 1 step /);
});

test("a paste puts the text on the simulator's pasteboard and presses Command-V", async () => {
  const { simulator, ran, inputs, helped } = setup();
  const [device] = (await simulator.list()).filter((item) => item.id === PHONE);
  assert.ok(device);
  await simulator.paste(device, "Grüße 👋");
  assert.equal(ran.at(-1), `xcrun simctl pbcopy ${PHONE}`);
  assert.deepEqual(inputs, ["Grüße 👋"]);
  assert.deepEqual(helped.slice(-4).map((call) => call.args), [
    { code: 227, phase: "down" },
    { code: 25, phase: "down" },
    { code: 25, phase: "up" },
    { code: 227, phase: "up" },
  ]);
});

test("a copy presses Command-C and answers the simulator's pasteboard once it changed", async () => {
  let board = "old";
  const { simulator, helped } = setup("auto", [PHONE], { pasteboard: () => board, onCall: (op, args) => {
    if (op === "key" && args.code === 6 && args.phase === "up") board = "new";
  } });
  const [device] = (await simulator.list()).filter((item) => item.id === PHONE);
  assert.ok(device);
  assert.equal(await simulator.copy(device), "new");
  assert.equal(await simulator.copy(device), null);
  assert.deepEqual(helped.slice(-4).map((call) => call.args.code), [227, 6, 6, 227]);
});
