// The browser pane for the page: its buttons and address bar, links from the transcript, the opened-page
// thumbnails, and the Electron app's link (server/browser/browser.ts).

import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { hideUrlSecrets, normalizeUrl } from "./browserTools.ts";
import { sendJson } from "../http.ts";
import { acceptWebSocket } from "../websocket.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { SessionId, Text } from "../bodies.ts";

const THUMB_PATH = /^\/api\/browser\/thumb\/([a-f0-9]{12})$/;

const TAB_OPS = new Set(["back", "forward", "reload", "stop", "switch", "close"]);

export function browserRoutes(host: Host): Route[] {
  const { browser } = host;
  return [
    route({
      // A page for a chat's tabs: from the address bar, a link in the transcript, or a page card. A card names
      // the tab it opened, which comes back up while it is still open.
      method: "POST",
      path: "/api/browser/open",
      body: z.object({ sessionId: SessionId.optional(), url: Text, tab: z.number().optional(), newTab: z.boolean().optional() }),
      async handle({ res, body }) {
        const owner = body.sessionId ?? "";
        const url = normalizeUrl(body.url);
        if (!owner || !url) {
          sendJson(res, 400, { error: owner ? "Give an http or https address" : "Choose a chat" });
          return;
        }
        const tab = body.tab === undefined ? undefined : cardTab(host, owner, body.tab, url);
        if (tab) {
          await browser.call("switch", { tab: tab.id });
          browser.focus(owner);
          sendJson(res, 200, { ok: true, result: { tab: tab.id, created: false } });
          return;
        }
        const result = await browser.call<{ created?: boolean }>("open", { url, owner, newTab: body.newTab === true || body.tab !== undefined, wait: false });
        if (result.created) browser.focus(owner);
        sendJson(res, 200, { ok: true, result });
      },
    }),
    route({
      method: "POST",
      path: "/api/browser/tab",
      body: z.object({ op: Text, tab: z.number().optional() }),
      async handle({ res, body }) {
        const { op } = body;
        if (!TAB_OPS.has(op)) {
          sendJson(res, 400, { error: "Unknown browser action" });
          return;
        }
        const tab = Number(body.tab);
        if (!browser.view().tabs.some((item) => item.id === tab)) {
          sendJson(res, 404, { error: "That tab is closed" });
          return;
        }
        await browser.call(op, { tab });
        sendJson(res, 200, { ok: true });
      },
    }),
    {
      method: "GET",
      path: THUMB_PATH,
      handle({ res, match }) {
        const file = browser.thumbFile(match[1] ?? "");
        if (!file) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
        fs.createReadStream(file).pipe(res);
      },
    },
  ];
}

export function openBrowserLink(host: Host, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const link = acceptWebSocket(req, socket, head);
  if (link) host.browser.attach(link);
}

// A card's tab, while it still shows the card's page.
function cardTab(host: Host, owner: string, tab: number, url: string) {
  const page = (value: string) => hideUrlSecrets(value).split("#")[0];
  return host.browser.view().tabs.find((item) => item.id === tab && item.owner === owner && page(item.url) === page(url));
}
