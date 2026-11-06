import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { refusePage } from "./apiGuard.ts";

function page(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/";
  Object.assign(req.headers, headers);
  return req;
}

test("the page answers only its own Host, and no other origin can read it", () => {
  assert.equal(refusePage(page({ host: "127.0.0.1:8787" }), 8787), null);
  assert.equal(refusePage(page({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }), 8787), null);
  assert.equal(refusePage(page({ host: "localhost:8787", origin: "http://localhost:8787" }), 8787), null);
  const foreign = { status: 403, error: "Foreign origin" };
  assert.deepEqual(refusePage(page({ host: "127.0.0.1:8787", origin: "http://localhost:3000" }), 8787), foreign);
  assert.deepEqual(refusePage(page({ host: "127.0.0.1:8787", origin: "http://evil.localhost:8787" }), 8787), foreign);
  assert.deepEqual(refusePage(page({ host: "127.0.0.1:8787", origin: "null" }), 8787), foreign);
  assert.deepEqual(refusePage(page({ host: "evil.example:8787" }), 8787), { status: 403, error: "Unknown host" });
});
