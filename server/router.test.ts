import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { z } from "zod";
import { dispatch, route, type Route } from "./router.ts";
import { sendJson } from "./http.ts";
import { remoteRoutes } from "./remote/routes.ts";
import type { Host } from "./app.ts";
import type { Remote } from "./remote/remote.ts";

class Recorder extends ServerResponse {
  text = "";

  override end(chunk?: unknown): this {
    if (typeof chunk === "string") this.text += chunk;
    return this;
  }
}

async function send(routes: readonly Route[], url: string, body: unknown) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(body));
  req.push(null);
  const res = new Recorder(req);
  await dispatch(routes, req, res, new URL(url, "http://127.0.0.1"));
  return { status: res.statusCode, body: JSON.parse(res.text) as unknown };
}

test("a handler gets the body as its route's schema reads it, and a body that fails gets 400 with the first issue", async () => {
  const seen: unknown[] = [];
  const routes = [
    route({
      path: "/api/echo",
      body: z.object({ name: z.string(), count: z.number().default(1) }),
      handle({ res, body }) {
        seen.push(body);
        sendJson(res, 200, { ok: true });
      },
    }),
  ];
  assert.deepEqual(await send(routes, "/api/echo", { name: "a", extra: true }), { status: 200, body: { ok: true } });
  assert.deepEqual(seen, [{ name: "a", count: 1 }]);
  assert.deepEqual(await send(routes, "/api/echo", { name: 1, count: "2" }), { status: 400, body: { error: "name: Invalid input: expected string, received number" } });
  assert.deepEqual(await send(routes, "/api/echo", "a"), { status: 400, body: { error: "Invalid input: expected object, received string" } });
  assert.equal(seen.length, 1);
});

test("the remote routes answer a body their schema refuses with 400", async () => {
  const asked: unknown[] = [];
  const remote = { setEnabled: (...args: unknown[]) => asked.push(args) } as unknown as Remote;
  const routes = remoteRoutes({ remote } as unknown as Host);
  assert.deepEqual(await send(routes, "/api/remote/enabled", { kind: "local", enabled: "yes" }), {
    status: 400,
    body: { error: "enabled: Invalid input: expected boolean, received string" },
  });
  assert.deepEqual(asked, []);
});
