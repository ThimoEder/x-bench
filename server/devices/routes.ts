// Device routes: the device list, the devices that can be started and starting one, a screen frame, touch
// input, the tools the Device tab needs, focus for a launched app's card, and the live stream. The simulator's
// drivers do the work for each platform.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { BUTTONS } from "./deviceMath.ts";
import { acceptWebSocket } from "../websocket.ts";
import { messageOf, sendJson, statusOf } from "../http.ts";
import type { SimDevice } from "./simulator.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { SessionId, Text } from "../bodies.ts";

// A touch, key or toolbar action from the page.
const InputBody = z.object({
  id: Text,
  action: z.string().optional(),
  key: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  x2: z.number().optional(),
  y2: z.number().optional(),
  // How long the finger was down, in milliseconds.
  ms: z.number().optional(),
  show: z.boolean().optional(),
  text: z.string().optional(),
});

export function deviceRoutes(host: Host): Route[] {
  const { devices, simulator } = host;

  return [
    {
      method: "GET",
      path: "/api/devices/frame",
      async handle({ res, url }) {
        try {
          const shot = await simulator.frame(await devices.ready(url.searchParams.get("id") || ""));
          // The screen in points, the units touches go in.
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": shot.data.length,
            "Cache-Control": "no-store",
            "X-Screen-Width": String(shot.width),
            "X-Screen-Height": String(shot.height),
          });
          res.end(shot.data);
        } catch (error) {
          sendJson(res, statusOf(error, 500), { error: messageOf(error) || "Couldn't read the screen" });
        }
      },
    },
    {
      method: "POST",
      path: "/api/devices",
      async handle({ res }) {
        sendJson(res, 200, await devices.list());
      },
    },
    {
      // The simulators and emulators on this Mac that are not running, for the Device tab's Start menus.
      method: "GET",
      path: "/api/devices/available",
      async handle({ res }) {
        const devices = (await simulator.list()).filter((device) => device.state === "shutdown" || device.state === "stopped");
        sendJson(res, 200, { devices: devices.map(({ id, platform, name, os }) => ({ id, platform, name, os })) });
      },
    },
    route({
      // Starts a simulator or emulator the person picked, and answers once it has booted.
      method: "POST",
      path: "/api/devices/boot",
      body: z.object({ id: Text }),
      async handle({ res, body }) {
        try {
          const device = await simulator.find(body.id);
          if (!device) throw Object.assign(new Error("That device is not on this Mac anymore"), { status: 404 });
          const started = await simulator.boot(device);
          sendJson(res, 200, { id: started.id });
        } catch (error) {
          sendJson(res, statusOf(error, 500), { error: messageOf(error) || "Couldn't start the device" });
        }
      },
    }),
    {
      method: "GET",
      path: "/api/devices/tools",
      async handle({ res }) {
        sendJson(res, 200, await simulator.status());
      },
    },
    route({
      // A launched app's card in the transcript: the Device tab comes up for the chat with the device shown.
      method: "POST",
      path: "/api/devices/focus",
      body: z.object({ sessionId: SessionId, device: z.string().min(1) }),
      handle({ res, body }) {
        devices.focus(body.sessionId, body.device);
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/devices/input",
      body: InputBody,
      async handle({ res, body }) {
        try {
          const device = await devices.ready(body.id);
          sendJson(res, 200, { ok: true, ...(await deviceInput(device, body)) });
        } catch (error) {
          sendJson(res, statusOf(error, 500), { error: messageOf(error) || "Couldn't send that touch" });
        }
      },
    }),
  ];

  // A touch or button from the Device tab while it shows screenshots, in points, the toolbar's light and dark
  // and on-screen keyboard switches, and copies and pastes on iOS.
  async function deviceInput(device: SimDevice, body: z.output<typeof InputBody>): Promise<Record<string, unknown>> {
    if (body.action === "shake") {
      await simulator.shake(device);
      return {};
    }
    if (body.action === "paste") {
      if (!body.text) throw Object.assign(new Error("Nothing to paste"), { status: 400 });
      await simulator.paste(device, body.text);
      return {};
    }
    if (body.action === "copy" || body.action === "cut") return { text: await simulator.copy(device, body.action === "cut") };
    if (body.action === "keyboard") return { keyboard: await simulator.softKeyboard(device, body.show) };
    if (body.action === "keyboard-state") return { keyboard: await simulator.softKeyboardShown(device) };
    if (body.action === "appearance") {
      const mode = (await simulator.appearanceOf(device)) === "dark" ? "light" : "dark";
      await simulator.appearance(device, mode);
      return { appearance: mode };
    }
    if (body.action === "key") {
      const button = BUTTONS.find((item) => item === body.key);
      if (!button) throw Object.assign(new Error("Unknown key"), { status: 400 });
      await simulator.press(device, button);
      return {};
    }
    const at = { x: Number(body.x), y: Number(body.y) };
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw Object.assign(new Error("Point is off the screen"), { status: 400 });
    const ms = Number(body.ms) || 0;
    if (body.action === "tap") {
      await simulator.tap(device, at, ms >= 500 ? Math.min(5, ms / 1000) : 0);
      return {};
    }
    if (body.action === "swipe") {
      const to = { x: Number(body.x2), y: Number(body.y2) };
      if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) throw Object.assign(new Error("Point is off the screen"), { status: 400 });
      await simulator.swipe(device, at, to, Math.min(3000, Math.max(100, ms || 300)) / 1000);
      return {};
    }
    throw Object.assign(new Error("Unknown action"), { status: 400 });
  }
}

export async function openDeviceStream({ devices, simulator }: Pick<Host, "devices" | "simulator">, address: URL, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const device = await devices.ready(address.searchParams.get("id") || "").catch(() => null);
  const watch = device ? await simulator.stream(device).catch(() => null) : null;
  if (!watch) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  // The page may have gone while the helper started.
  if (socket.destroyed) return;
  const viewer = acceptWebSocket(req, socket, head);
  if (!viewer) return;
  viewer.onClose(watch(viewer));
}
