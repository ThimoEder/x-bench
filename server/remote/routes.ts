// Remote access routes for the settings page on the Mac: the ngrok settings, each tunnel's switch, the local CA,
// pairing and the device list. The remote listener refuses /api/remote, so a paired phone cannot pair others or
// turn a tunnel off.

import QRCode from "qrcode";
import { z } from "zod";
import { revealFile } from "../folder/folder.ts";
import { messageOf, sendJson } from "../http.ts";
import { ensureCa } from "./localTunnel.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";

export function remoteRoutes(host: Host): Route[] {
  const { remote } = host;
  if (!remote) return [];

  return [
    {
      method: "GET",
      path: "/api/remote",
      handle({ res }) {
        sendJson(res, 200, remote.view());
      },
    },
    route({
      method: "POST",
      path: "/api/remote/settings",
      body: z.object({ authtoken: z.string().optional(), domain: z.string().optional() }),
      handle({ res, body }) {
        sendJson(res, 200, remote.saveSettings({
          ...(body.authtoken === undefined ? {} : { authtoken: body.authtoken }),
          ...(body.domain === undefined ? {} : { domain: body.domain }),
        }));
      },
    }),
    {
      method: "POST",
      path: "/api/remote/certificate",
      async handle({ res }) {
        try {
          sendJson(res, 200, { path: await revealFile(await ensureCa(host.paths.remoteCa)) });
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) || "Couldn't make the certificate" });
        }
      },
    },
    route({
      method: "POST",
      path: "/api/remote/enabled",
      body: z.object({ kind: z.enum(["local", "ngrok"]).default("ngrok"), enabled: z.boolean() }),
      async handle({ res, body }) {
        sendJson(res, 200, await remote.setEnabled(body.kind, body.enabled));
      },
    }),
    {
      method: "POST",
      path: "/api/remote/pairing",
      async handle({ res }) {
        const pairing = remote.startPairing();
        if (!pairing) {
          sendJson(res, 409, { error: "Turn on remote access first" });
          return;
        }
        const qrs = await Promise.all(pairing.urls.map((url) => QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })));
        sendJson(res, 200, { ...pairing, qrs });
      },
    },
    {
      method: "DELETE",
      path: "/api/remote/pairing",
      handle({ res }) {
        remote.cancelPairing();
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "DELETE",
      path: /^\/api\/remote\/devices\/([A-Za-z0-9_-]+)$/,
      handle({ res, match }) {
        if (!remote.removeDevice(match[1] ?? "")) {
          sendJson(res, 404, { error: "No such device" });
          return;
        }
        sendJson(res, 200, remote.view());
      },
    },
  ];
}
