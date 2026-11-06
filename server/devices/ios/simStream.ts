// The live view of an iOS simulator in the Device tab, over the /api/devices/stream WebSocket. X Bench's
// simulator helper (simHelper.ts) sends the simulator's framebuffer as H.264 at its own frame rate, passed on
// in the scrcpy view's messages (codec, then a key flag byte and the frame). Touches go back live as they
// happen, as do keys typed while the view has focus, and toolbar buttons as presses.

import { z } from "zod";
import { fields } from "../../../bridge/lenient.ts";
import type { SimHelper } from "./simHelper.ts";
import { BUTTONS, type Button } from "../deviceMath.ts";
import type { SimDevice } from "../simulator.ts";
import { createDeviceHubs, type DeviceHub } from "../deviceHubs.ts";
import { createVideoFanout } from "../videoFanout.ts";
import type { WebSocketConnection } from "../../websocket.ts";

const VIDEO_BITRATE = 8_000_000;

const Message = fields({
  type: z.unknown().optional(),
  key: z.unknown().optional(),
  code: z.unknown().optional(),
  action: z.unknown().optional(),
  x: z.unknown().optional(),
  y: z.unknown().optional(),
  pinch: z.unknown().optional(),
  width: z.unknown().optional(),
  height: z.unknown().optional(),
});

export interface SimStream {
  watch(device: SimDevice, viewer: WebSocketConnection, helper: SimHelper): () => void;
  close(): void;
}

export interface Buttons {
  press(device: SimDevice, button: Button): Promise<void>;
}

export function createSimStream(buttons: Buttons): SimStream {
  const hubs = createDeviceHubs<Hub>();

  function watch(device: SimDevice, viewer: WebSocketConnection, helper: SimHelper): () => void {
    const hub = hubs.get(device.id);
    if (hub && hub.helper !== helper) {
      hub.end("The simulator stream changed. Reconnecting.");
      hubs.delete(device.id);
    }
    return hubs.watch(device.id, viewer, (dead) => createHub(device, helper, buttons, dead));
  }

  return { watch, close: hubs.close };
}

interface Hub extends DeviceHub {
  helper: SimHelper;
  // Tells the viewers why, and closes their sockets so the page opens a new stream.
  end(reason: string): void;
}

// The helper's H.264 stream for every viewer of one simulator. A viewer that joins, or falls behind, needs a
// key frame, and the stream starts over to send one.
function createHub(device: SimDevice, helper: SimHelper, buttons: Buttons, onDead: () => void): Hub {
  const fanout = createVideoFanout(() => restartSoon());
  const viewers = fanout.viewers;
  const pixels = { width: helper.info.widthPixels, height: helper.info.heightPixels };
  // Each viewer's finger while it is down, in points.
  const held = new Map<WebSocketConnection, { x: number; y: number; pinch: boolean }>();
  // Each viewer's keys while they are down, as HID usage codes.
  const keysDown = new Map<WebSocketConnection, Set<number>>();
  let stopped = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let dropFrames: (() => void) | null = null;
  let dropExit: (() => void) | null = null;
  const points = { width: helper.info.width, height: helper.info.height };

  async function begin() {
    dropFrames = helper.onFrame((data) => fanout.frame(data, pixels));
    dropExit = helper.onExit(() => fail("The simulator stream stopped."));
    await startStream();
  }

  // Starting the stream, also again, sends the codec and a key frame at once, even while the screen stands still.
  function startStream(): Promise<void> {
    return helper.call("stream", { fps: 60, scale: 1, bitrate: VIDEO_BITRATE }).then(
      () => {},
      (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
    );
  }

  function restartSoon() {
    if (restartTimer || stopped) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped || !viewers.size) return;
      void startStream();
    }, 150);
  }

  function add(viewer: WebSocketConnection) {
    const first = viewers.size === 0 && !dropFrames;
    fanout.add(viewer);
    viewer.onMessage((payload, text) => {
      if (!text) return;
      try {
        act(viewer, JSON.parse(payload.toString("utf8")));
      } catch {
        // Not a message this view sends.
      }
    });
    if (first) void begin();
    else restartSoon();
  }

  // Positions arrive in the page's picture of the screen, width by height, and go to the helper in points.
  function act(viewer: WebSocketConnection, raw: unknown) {
    const message = Message.parse(raw);
    if (message.type === "key") {
      const button = BUTTONS.find((item) => item === message.key);
      if (button) void buttons.press(device, button).catch(() => {});
      return;
    }
    if (message.type === "keyboard") {
      const code = Number(message.code);
      if (!Number.isInteger(code) || code <= 0 || code > 0xffff) return;
      const phase = message.action === "up" ? "up" : "down";
      const down = keysDown.get(viewer) ?? new Set<number>();
      if (phase === "down") down.add(code);
      else down.delete(code);
      keysDown.set(viewer, down);
      helper.post("key", { code, phase });
      return;
    }
    if (message.type !== "touch") return;
    const width = Number(message.width);
    const height = Number(message.height);
    const x = Number(message.x);
    const y = Number(message.y);
    if (!(width > 0) || !(height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const at = { x: (x * points.width) / width, y: (y * points.height) / height };
    const phase = message.action === "up" ? "up" : "down";
    const pinch = message.pinch === true;
    if (phase === "down") held.set(viewer, { ...at, pinch });
    else held.delete(viewer);
    touch(phase, at, pinch);
  }

  function touch(phase: "down" | "up", at: { x: number; y: number }, pinch: boolean) {
    if (pinch) helper.post("touch2", { phase, x1: at.x, y1: at.y, x2: points.width - at.x, y2: points.height - at.y });
    else helper.post("touch", { phase, x: at.x, y: at.y });
  }

  // A viewer that leaves mid-touch lifts its finger and keys, so the simulator is not left pressed.
  function remove(viewer: WebSocketConnection) {
    const finger = held.get(viewer);
    if (finger) touch("up", finger, finger.pinch);
    held.delete(viewer);
    for (const code of keysDown.get(viewer) ?? []) helper.post("key", { code, phase: "up" });
    keysDown.delete(viewer);
    fanout.remove(viewer);
  }

  function fail(reason: string) {
    stop();
    fanout.end(reason);
    onDead();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    dropFrames?.();
    dropExit?.();
    if (helper.alive()) helper.call("stop-stream").catch(() => {});
  }

  return { helper, viewers, add, remove, stop, end: fail };
}
