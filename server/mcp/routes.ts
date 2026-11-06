// The MCP endpoint each session's harness calls (server/mcp/mcp.ts).

import { isRecord } from "../../bridge/lenient.ts";
import { answerMcp } from "./mcp.ts";
import { readJson, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import type { Route } from "../router.ts";

const MCP_PATH = /^\/api\/mcp\/([A-Za-z0-9_-]+)$/;

export function mcpRoutes(host: Host): Route[] {
  const { hostTools, providers } = host;
  // Calls still running, by key and JSON-RPC id, so a harness's notifications/cancelled can withdraw a card.
  const running = new Map<string, AbortController>();
  return [
    {
      method: "POST",
      path: MCP_PATH,
      raw: true,
      async handle({ req, res, match }) {
        const key = match[1] ?? "";
        if (!hostTools.knowsKey(key)) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        // A browser tool can wait for the person. A harness that gives up drops the request, and the prompt goes.
        const dropped = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) dropped.abort();
        });
        // Looked up per message: a new session's key is bound only once session/new answers.
        const answer = async (message: unknown) => {
          const fields = isRecord(message) ? message : {};
          const params = isRecord(fields.params) ? fields.params : {};
          if (fields.method === "notifications/cancelled") running.get(`${key}:${String(params.requestId)}`)?.abort();
          const call = new AbortController();
          const stop = () => call.abort();
          dropped.signal.addEventListener("abort", stop, { once: true });
          const id = fields.id === undefined || fields.id === null ? "" : `${key}:${String(fields.id)}`;
          if (id) running.set(id, call);
          try {
            // A key is bound to the harness's session, which a switched chat's id is not. Tools file their cards under the chat.
            const owner = hostTools.sessionFor(key);
            return await answerMcp(message, hostTools.toolsFor(key), { sessionId: owner ? providers.ids.toApp(owner) : owner, signal: call.signal });
          } finally {
            if (id && running.get(id) === call) running.delete(id);
            dropped.signal.removeEventListener("abort", stop);
          }
        };
        // An empty batch is answered as one invalid message.
        const batch = Array.isArray(body) && body.length > 0;
        const replies = (await Promise.all((batch ? (body as unknown[]) : [body]).map(answer))).filter(Boolean);
        if (res.destroyed) return;
        if (!replies.length) {
          res.statusCode = 202;
          res.end();
          return;
        }
        sendJson(res, 200, batch ? replies : replies[0]);
      },
    },
    {
      // Every reply comes back on its POST, so GET and DELETE have nothing to serve.
      path: MCP_PATH,
      handle({ res }) {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "Method not allowed" });
      },
    },
  ];
}
