// The PlatformDriver for Android devices and emulators, on adb. Touches, keys and text go through a control-only
// scrcpy session (scrcpy.ts); screenshots, the screen's tree and the display's size come from X Bench's Android
// helper (androidHelper.ts). adb's input, screencap and uiautomator stand in when those cannot start. The live
// view streams an emulator over its gRPC endpoint (emulatorStream.ts) and other devices through scrcpy's mirror.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { toJpeg } from "../../../bridge/jpeg.ts";
import { ANDROID_KEYCODES, line, parseAdbDevices, pngSize, type Button, type Point, type Size } from "../deviceMath.ts";
import { defaultAdb } from "../devices.ts";
import { messageOf } from "../../http.ts";
import { runProcess, type RunCommand } from "../../runProcess.ts";
import { parseUiautomator } from "../screenTree.ts";
import type { AppLog, Launched, PathPoint, PlatformDriver, Shot, SimDevice } from "../simulator.ts";
import type { WebSocketConnection } from "../../websocket.ts";
import { createAndroidHelpers, type AndroidHelper, type AndroidHelpers } from "./androidHelper.ts";
import { createEmulatorStream } from "./emulatorStream.ts";
import { createMirror, createScrcpyControls, defaultScrcpyJar, type ScrcpyControl, type ScrcpyControls } from "./scrcpy.ts";
import { encodeText, encodeTouch, keyEvent, textRuns } from "./scrcpyFormat.ts";

// The control sessions' fingers, apart from the ones the Device tab's live view uses.
const AGENT_FINGER = 1n;
const AGENT_FINGER_2 = 2n;

export interface AndroidDriverOptions {
  run?: RunCommand;
  adb?: string;
  emulator?: string;
  helpers?: AndroidHelpers;
  controls?: ScrcpyControls;
}

export function createAndroidDriver(options: AndroidDriverOptions = {}) {
  const run = options.run ?? runProcess;
  const adb = options.adb ?? defaultAdb();
  const emulator = options.emulator ?? path.join(os.homedir(), "Library/Android/sdk/emulator/emulator");
  const helpers = options.helpers ?? createAndroidHelpers({ adb, run });
  const jar = defaultScrcpyJar();
  const controls = options.controls ?? createScrcpyControls({ adb, jar });
  const mirror = createMirror({ adb, jar });
  const emulatorStream = createEmulatorStream();
  const scales = new Map<string, number>();
  const input = createInput(shell, controls, scaleOf, helperFor);
  const apps = createApps(run, adb, shell);
  const { list, boot } = createListing(run, adb, emulator, shell, warm);

  async function status() {
    const version = await run(adb, ["version"], { timeoutMs: 10_000 }).then(({ stdout }) => stdout.toString("utf8").trim().split("\n")[0]?.trim() ?? "", () => "");
    return {
      adb: { found: Boolean(version), version },
      emulator: { found: existsSync(emulator), path: emulator },
      androidHelper: { found: Boolean(helpers.path()) },
    };
  }

  // Starts a device's helper and control session in the background, since each takes seconds to start on a
  // busy emulator.
  function warm(serial: string) {
    if (helpers.path()) helpers.get(serial).catch(() => {});
    controls.get(serial).catch(() => {});
  }

  // Pixels per dp.
  async function scaleOf(device: SimDevice): Promise<number> {
    const known = scales.get(device.id);
    if (known) return known;
    const scale = await readScale(device);
    scales.set(device.id, scale);
    return scale;
  }

  async function readScale(device: SimDevice): Promise<number> {
    const helper = await helperFor(device);
    const shown = helper ? (await helper.display().catch(() => null))?.density : 0;
    if (shown) return shown / 160;
    const text = await shell(device.id, "wm density").catch(() => "");
    const override = /Override density:\s*(\d+)/.exec(text)?.[1];
    const physical = /Physical density:\s*(\d+)/.exec(text)?.[1];
    const density = Number(override ?? physical);
    return density > 0 ? density / 160 : 1;
  }

  async function screenshot(device: SimDevice): Promise<Shot> {
    const scale = await scaleOf(device);
    // The helper fails while instrumentation holds UiAutomation; screencap still works then.
    return (await helperShot(device, scale, 70).catch(() => null)) ?? screencap(device, scale);
  }

  async function frame(device: SimDevice): Promise<Shot> {
    const scale = await scaleOf(device);
    const shot = await helperShot(device, 1, 85).catch(() => null);
    return shot ? { ...shot, width: Math.round(shot.width / scale), height: Math.round(shot.height / scale) } : screencap(device, scale);
  }

  // A JPEG from the helper, scale screen pixels to one picture pixel, or null when it cannot start.
  async function helperShot(device: SimDevice, scale: number, quality: number): Promise<Shot | null> {
    const helper = await helperFor(device);
    if (!helper) return null;
    const reply = await helper.call("shot", { scale, quality });
    const data = Buffer.from(String(reply.jpeg ?? ""), "base64");
    if (!data.length) throw new Error(`Couldn't read the screen of ${device.name}.`);
    return { data, width: Number(reply.width) || 0, height: Number(reply.height) || 0 };
  }

  async function screencap(device: SimDevice, scale: number): Promise<Shot> {
    const { stdout } = await run(adb, ["-s", device.id, "exec-out", "screencap", "-p"]);
    const size = pngSize(stdout);
    if (!size) throw new Error(`Couldn't read the screen of ${device.name}.`);
    const width = Math.max(1, Math.round(size.width / scale));
    const height = Math.max(1, Math.round(size.height / scale));
    return { data: await toJpeg(stdout, { extension: "png", quality: 70, longest: Math.max(width, height), run }), width, height };
  }

  async function stream(device: SimDevice) {
    return (viewer: WebSocketConnection) => (emulatorStream.available(device.id) ? emulatorStream.watch(device.id, viewer) : mirror.watch(device.id, viewer));
  }

  async function helperFor(device: SimDevice): Promise<AndroidHelper | null> {
    if (!helpers.path()) return null;
    try {
      return await helpers.get(device.id);
    } catch {
      return null;
    }
  }

  function shell(serial: string, command: string, timeoutMs = 20_000): Promise<string> {
    return run(adb, ["-s", serial, "shell", command], { timeoutMs }).then(({ stdout }) => stdout.toString("utf8"));
  }

  // timeoutMs bounds the whole read, so a dump that runs past it is stopped.
  async function tree(device: SimDevice, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    const scale = await scaleOf(device);
    const helper = await helperFor(device);
    // The helper's idle wait leaves half the read's time for the read and the dump fallback.
    const xml = helper ? await helper.call("tree", { idleMs: Math.min(3000, Math.floor(timeoutMs / 2)) }, 30_000).then((reply) => String(reply.xml ?? ""), () => "") : "";
    if (xml.includes("<hierarchy")) return parseUiautomator(xml, scale);
    // uiautomator gives up while the screen still animates, so a failed dump gets one more try.
    let failure = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await sleep(1000);
      const left = Math.min(30_000, end - Date.now());
      if (left <= 0) break;
      const out = await shell(device.id, "uiautomator dump /sdcard/x-bench-ui.xml >/dev/null 2>&1; cat /sdcard/x-bench-ui.xml; rm -f /sdcard/x-bench-ui.xml", left).catch((error: unknown) => messageOf(error));
      if (out.includes("<hierarchy")) return parseUiautomator(out, scale);
      failure = out.trim().split("\n")[0] ?? "";
    }
    throw new Error(`Couldn't read the screen of ${device.name}${failure ? `: ${failure}` : ""}.`);
  }

  async function openUrl(device: SimDevice, url: string) {
    await shell(device.id, `am start -a android.intent.action.VIEW -d ${quote(url)}`);
  }

  async function appearanceOf(device: SimDevice): Promise<"light" | "dark"> {
    return /yes/i.test(await shell(device.id, "cmd uimode night")) ? "dark" : "light";
  }

  async function appearance(device: SimDevice, mode: "light" | "dark") {
    await shell(device.id, `cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
  }

  // Emulators always report a hardware keyboard, so the on-screen one shows only with this setting. The keyboard
  // app restarts to take the change.
  async function softKeyboard(device: SimDevice, show?: boolean): Promise<boolean> {
    const next = show ?? !(await softKeyboardShown(device));
    const ime = (await shell(device.id, "settings get secure default_input_method")).trim().split("/")[0] ?? "";
    const restart = /^[\w.]+$/.test(ime) ? `; am force-stop ${ime}` : "";
    await shell(device.id, `settings put secure show_ime_with_hard_keyboard ${next ? 1 : 0}${restart}`);
    return next;
  }

  async function softKeyboardShown(device: SimDevice): Promise<boolean> {
    return (await shell(device.id, "settings get secure show_ime_with_hard_keyboard")).trim() === "1";
  }

  function iosOnly(what: string) {
    return async () => {
      throw new Error(`${what} works on iOS simulators only.`);
    };
  }

  return {
    title: "Android",
    unit: "dp",
    // Both the helper's read and uiautomator dump wait for the screen to idle.
    settles: true,
    builds: false,
    missing: () => "",
    status,
    list,
    boot,
    screenshot,
    frame,
    stream,
    tree,
    ...input,
    ...apps,
    openUrl,
    appearanceOf,
    appearance,
    softKeyboard,
    softKeyboardShown,
    shake: iosOnly("Shaking"),
    paste: iosOnly("Pasting"),
    copy: iosOnly("Copying"),
    close() {
      helpers.close();
      controls.close();
      mirror.close();
      emulatorStream.close();
    },
  } satisfies PlatformDriver;
}

type Shell = (serial: string, command: string, timeoutMs?: number) => Promise<string>;

// Touches, keys and text, through the device's scrcpy control session, or adb's input when that cannot start.
function createInput(shell: Shell, controls: ScrcpyControls, scaleOf: (device: SimDevice) => Promise<number>, helperFor: (device: SimDevice) => Promise<AndroidHelper | null>) {
  // Why a device's scrcpy control session could not start, for the errors of what needs it.
  const controlErrors = new Map<string, string>();

  // The device's scrcpy control session and the screen's size in pixels as input sees it, or null for adb.
  async function controlFor(device: SimDevice): Promise<{ control: ScrcpyControl; size: Size } | null> {
    try {
      const [control, size] = await Promise.all([controls.get(device.id), inputSize(device)]);
      controlErrors.delete(device.id);
      return { control, size };
    } catch (error) {
      controlErrors.set(device.id, messageOf(error));
      return null;
    }
  }

  function controlReason(device: SimDevice): string {
    const reason = controlErrors.get(device.id);
    return reason ? `: ${reason}` : "";
  }

  async function inputSize(device: SimDevice): Promise<Size> {
    const helper = await helperFor(device);
    const display = helper ? await helper.display().catch(() => null) : null;
    if (display?.width && display.height) return { width: display.width, height: display.height };
    // scrcpy drops touches sized for the display turned another way, so this is the current, turned size.
    const size = /\bcur=(\d+)x(\d+)/.exec(await shell(device.id, "dumpsys window displays"));
    if (!size) throw new Error(`Couldn't read the screen size of ${device.name}.`);
    return { width: Number(size[1]), height: Number(size[2]) };
  }

  // One finger, or two, down at the first points, along the rest and up at the last, in pixels.
  async function scrcpyPath(input: { control: ScrcpyControl; size: Size }, fingers: { pointer: bigint; points: PathPoint[] }[]) {
    const { control, size } = input;
    const event = (action: "down" | "move" | "up", pointer: bigint, point: Point) => encodeTouch({ action, x: point.x, y: point.y, width: size.width, height: size.height, pointer });
    const at = (index: number) => Buffer.concat(fingers.map((finger) => event(index === 0 ? "down" : "move", finger.pointer, finger.points[index] as Point)));
    const count = fingers[0]?.points.length ?? 0;
    await control.send(at(0));
    for (let index = 1; index < count; index += 1) {
      await sleep(Math.max(0, fingers[0]?.points[index]?.dt ?? 16));
      await control.send(at(index));
    }
    await control.send(Buffer.concat([...fingers].reverse().map((finger) => event("up", finger.pointer, finger.points[count - 1] as Point))));
  }

  async function pixels(device: SimDevice, points: PathPoint[]): Promise<PathPoint[]> {
    const scale = await scaleOf(device);
    return points.map((point) => ({ x: point.x * scale, y: point.y * scale, dt: point.dt }));
  }

  async function px(device: SimDevice, point: Point): Promise<[number, number]> {
    const scale = await scaleOf(device);
    return [Math.round(point.x * scale), Math.round(point.y * scale)];
  }

  async function tap(device: SimDevice, point: Point, holdSeconds: number) {
    const input = await controlFor(device);
    if (input) {
      const at = await pixels(device, [point]);
      const hold = holdSeconds > 0 ? Math.min(10, holdSeconds) * 1000 : 40;
      await scrcpyPath(input, [{ pointer: AGENT_FINGER, points: [...at, { ...(at[0] as PathPoint), dt: hold }] }]);
      return;
    }
    const [x, y] = await px(device, point);
    if (holdSeconds > 0) await shell(device.id, `input swipe ${x} ${y} ${x} ${y} ${Math.round(Math.min(10, holdSeconds) * 1000)}`);
    else await shell(device.id, `input tap ${x} ${y}`);
  }

  async function swipe(device: SimDevice, from: Point, to: Point, seconds: number) {
    const input = await controlFor(device);
    if (input) {
      await scrcpyPath(input, [{ pointer: AGENT_FINGER, points: await pixels(device, line(from, to, seconds)) }]);
      return;
    }
    const [x1, y1] = await px(device, from);
    const [x2, y2] = await px(device, to);
    await shell(device.id, `input swipe ${x1} ${y1} ${x2} ${y2} ${Math.round(seconds * 1000)}`);
  }

  async function touchPath(device: SimDevice, points: PathPoint[], second?: PathPoint[]) {
    const input = await controlFor(device);
    if (input) {
      const fingers = [{ pointer: AGENT_FINGER, points: await pixels(device, points) }];
      if (second) fingers.push({ pointer: AGENT_FINGER_2, points: await pixels(device, second) });
      await scrcpyPath(input, fingers);
      return;
    }
    if (second) throw new Error(`Two-finger gestures on Android need scrcpy, which could not start${controlReason(device)}.`);
    const steps: string[] = [];
    for (const [index, point] of points.entries()) {
      const [x, y] = await px(device, point);
      if (index > 0 && (point.dt ?? 0) > 0) steps.push(`sleep ${fixed(Math.min(5, (point.dt ?? 0) / 1000))}`);
      steps.push(`input motionevent ${index === 0 ? "DOWN" : index === points.length - 1 ? "UP" : "MOVE"} ${x} ${y}`);
    }
    await shell(device.id, steps.join("; "), 60_000);
  }

  async function type(device: SimDevice, text: string) {
    const input = await controlFor(device);
    if (input) {
      // Each line goes in as typed keys or one paste, and Return goes between lines.
      for (const [index, part] of text.split("\n").entries()) {
        if (index > 0) await input.control.send(Buffer.concat([keyEvent(66, "down"), keyEvent(66, "up")]));
        for (const run of textRuns(part)) {
          if (run.kind === "paste") await input.control.paste(run.text);
          else await input.control.send(encodeText(run.text));
        }
      }
      return;
    }
    if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error(`Typing characters beyond plain ASCII on Android needs scrcpy, which could not start${controlReason(device)}.`);
    for (const [index, line] of text.split("\n").entries()) {
      if (index > 0) await shell(device.id, "input keyevent 66");
      if (line) await shell(device.id, `input text ${quote(line.replaceAll(" ", "%s"))}`);
    }
  }

  async function press(device: SimDevice, button: Button, holdSeconds: number) {
    const code = ANDROID_KEYCODES[button];
    if (code === undefined) throw new Error(`Android has no ${button} button.`);
    if (holdSeconds > 0) {
      // adb's long press carries Android's long-press flag, which an injected down and up do not.
      await shell(device.id, `input keyevent --longpress ${code}`);
      return;
    }
    const input = await controlFor(device);
    if (input) {
      await input.control.send(Buffer.concat([keyEvent(code, "down"), keyEvent(code, "up")]));
      return;
    }
    await shell(device.id, `input keyevent ${code}`);
  }

  return { tap, swipe, touchPath, type, press };
}

// The devices adb sees and the emulators that are not running, and starting one. warm runs for each running device.
function createListing(run: RunCommand, adb: string, emulator: string, shell: Shell, warm: (serial: string) => void) {
  async function list(): Promise<SimDevice[]> {
    let rows: SimDevice[] = [];
    try {
      const { stdout } = await run(adb, ["devices", "-l"]);
      rows = parseAdbDevices(stdout.toString("utf8")).map((device) => ({ id: device.id, platform: "android" as const, name: device.name, os: "Android", booted: device.state === "device", state: device.state }));
    } catch {
      return [];
    }
    const running = new Set<string>();
    for (const row of rows) if (row.booted) warm(row.id);
    for (const row of rows) {
      if (!row.id.startsWith("emulator-") || row.state !== "device") continue;
      const avd = await avdOf(row.id);
      if (avd) {
        running.add(avd);
        row.name = avd.replaceAll("_", " ");
      }
    }
    if (!existsSync(emulator)) return rows;
    try {
      const { stdout } = await run(emulator, ["-list-avds"], { timeoutMs: 10_000 });
      for (const name of stdout.toString("utf8").split("\n").map((line) => line.trim())) {
        if (!/^[\w.-]+$/.test(name) || running.has(name)) continue;
        rows.push({ id: `avd:${name}`, platform: "android", name: name.replaceAll("_", " "), os: "Android", booted: false, state: "stopped" });
      }
    } catch {
      // The running devices are enough.
    }
    return rows;
  }

  // adb hands an emulator's serial to the next emulator once it stops, so the name is asked every time.
  async function avdOf(serial: string): Promise<string> {
    try {
      const { stdout } = await run(adb, ["-s", serial, "emu", "avd", "name"], { timeoutMs: 5000 });
      const name = stdout.toString("utf8").split("\n")[0]?.trim() ?? "";
      return name === "OK" ? "" : name;
    } catch {
      return "";
    }
  }

  async function boot(device: SimDevice): Promise<SimDevice> {
    const avd = device.id.startsWith("avd:") ? device.id.slice(4) : "";
    if (!avd) throw new Error(`${device.name} is ${device.state}. Connect it over adb first.`);
    if (!existsSync(emulator)) throw new Error("The Android emulator is not installed. Install it with Android Studio.");
    detached(emulator, ["-avd", avd, "-no-boot-anim"]);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const rows = await list();
      const candidates = rows.filter((row) => row.booted && row.id.startsWith("emulator-"));
      const names = await Promise.all(candidates.map((row) => avdOf(row.id)));
      const started = candidates.find((_, index) => names[index] === avd);
      if (!started) continue;
      const booted = await shell(started.id, "getprop sys.boot_completed").catch(() => "");
      if (booted.trim() === "1") return started;
    }
    throw new Error(`${device.name} did not finish booting in 4 minutes.`);
  }

  return { list, boot };
}

function createApps(run: RunCommand, adb: string, shell: Shell) {
  async function install(device: SimDevice, appPath: string): Promise<string> {
    const info = await stat(appPath).catch(() => null);
    if (!info) throw new Error(`There is nothing at ${appPath}.`);
    if (!appPath.endsWith(".apk")) throw new Error("Give the path of an .apk.");
    await run(adb, ["-s", device.id, "install", "-r", appPath], { timeoutMs: 240_000 });
    return "";
  }

  async function launch(device: SimDevice, appId: string): Promise<Launched> {
    await shell(device.id, `am force-stop ${quote(appId)}`);
    const out = await shell(device.id, `monkey -p ${quote(appId)} -c android.intent.category.LAUNCHER 1`, 30_000);
    if (/No activities found|Error/i.test(out)) throw new Error(`${appId} has no launcher activity on ${device.name}.`);
    await sleep(500);
    const pid = Number((await shell(device.id, `pidof ${quote(appId)}`).catch(() => "")).trim().split(/\s+/)[0]) || null;
    return { name: appId, pid };
  }

  async function appLog(device: SimDevice, appId: string, seconds: number): Promise<AppLog> {
    const pid = (await shell(device.id, `pidof ${quote(appId)}`).catch(() => "")).trim().split(/\s+/)[0] ?? "";
    const { stdout } = await run(adb, ["-s", device.id, "logcat", "-d", "-v", "time", "-T", sinceTime(Date.now() - seconds * 1000), ...(pid ? [`--pid=${pid}`] : [])], { timeoutMs: 30_000 });
    const lines = stdout.toString("utf8").split("\n").filter((line) => line.trim() && !line.startsWith("-----"));
    return { printed: [], logged: pid ? lines : lines.filter((line) => line.includes(appId)) };
  }

  return { install, launch, appLog };
}

// logcat's -T takes "MM-DD hh:mm:ss.mmm" in the device's local time, which matches the host's for an emulator.
function sinceTime(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.000`;
}

// A word for Android's shell, which adb joins into one command line.
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fixed(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function detached(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
