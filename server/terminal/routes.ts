// Terminal routes: open and close a shell for a session on the desk, and the stream socket a page reads a
// shell's screen and output from and sends its keys and size over.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { clampSize } from "./terminal.ts";
import { acceptWebSocket } from "../websocket.ts";
import { messageOf, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { deskGuard } from "../routeGuard.ts";
import { SessionBody } from "../bodies.ts";

export function terminalRoutes(host: Host): Route[] {
  const { terminals } = host;
  const { onDesk, withSession, inFolder } = deskGuard(host);

  return [
    route({
      method: "POST",
      path: "/api/terminal/open",
      body: SessionBody.extend({ cols: z.number().optional(), rows: z.number().optional() }),
      handle: withSession(inFolder(({ res, body, sessionId, current }) => {
        try {
          const shell = terminals.open(sessionId, current.cwd, clampSize({ cols: Number(body.cols), rows: Number(body.rows) }));
          sendJson(res, 200, { shell });
        } catch (error) {
          sendJson(res, 400, { error: messageOf(error) || "Couldn't start a shell" });
        }
      })),
    }),
    route({
      method: "POST",
      path: "/api/terminal/close",
      body: SessionBody.extend({ shellId: z.string() }),
      handle: onDesk(({ res, body, sessionId }) => {
        if (!terminals.close(sessionId, body.shellId)) {
          sendJson(res, 404, { error: "That shell has ended" });
          return;
        }
        sendJson(res, 200, { ok: true });
      }),
    }),
  ];
}

// Any shell the host runs, by id. The token check comes first, in app.ts.
export function openTerminalStream({ terminals }: Pick<Host, "terminals">, address: URL, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const viewer = acceptWebSocket(req, socket, head);
  if (!viewer) return;
  const params = address.searchParams;
  const size = params.has("cols") && params.has("rows") ? clampSize({ cols: Number(params.get("cols")), rows: Number(params.get("rows")) }) : null;
  terminals.attach(params.get("shellId") || "", viewer, size);
}
