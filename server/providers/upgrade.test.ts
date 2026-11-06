import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";
import { createUpgradeRouter, type UpgradeRoutes } from "./upgrade.ts";

interface Handshake {
  path?: string;
  host?: string;
  origin?: string;
  protocol?: string;
}

// Sends a WebSocket handshake and returns the status line the host answers with.
function handshake(port: number, { path = "/", host = `127.0.0.1:${port}`, origin, protocol }: Handshake): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk;
      if (!answer.includes("\r\n")) return;
      socket.destroy();
      resolve(answer.slice(0, answer.indexOf("\r\n")));
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(answer));
  });
}

// A host whose routes answer with a status line naming which route took the socket.
async function host(t: test.TestContext, routes: Partial<UpgradeRoutes> = {}) {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const took = (name: string) => (_req: unknown, socket: Duplex) => {
    socket.end(`HTTP/1.1 101 ${name}\r\n\r\n`);
  };
  server.on(
    "upgrade",
    createUpgradeRouter({
      port,
      deviceStream: async (_address, req, socket) => took("device stream")(req, socket),
      terminalStream: async (_address, req, socket) => took("terminal stream")(req, socket),
      hotReload: took("hot reload"),
      ...routes,
    }),
  );
  return port;
}

test("the device stream and Vite's socket each get their own upgrades, and nothing else is left open", async (t) => {
  const port = await host(t);
  const own = `http://127.0.0.1:${port}`;
  assert.equal(await handshake(port, { path: "/api/devices/stream?token=x", origin: own }), "HTTP/1.1 101 device stream");
  assert.equal(await handshake(port, { path: "/api/terminal/stream?token=x&shellId=a", origin: own }), "HTTP/1.1 101 terminal stream");
  assert.equal(await handshake(port, { origin: own, protocol: "vite-hmr" }), "HTTP/1.1 101 hot reload");
  assert.equal(await handshake(port, { protocol: "vite-ping" }), "HTTP/1.1 101 hot reload");
  assert.equal(await handshake(port, { host: `localhost:${port}`, origin: `http://localhost:${port}`, protocol: "vite-hmr" }), "HTTP/1.1 101 hot reload");
  assert.equal(await handshake(port, { origin: own }), "HTTP/1.1 404 Not Found");
  assert.equal(await handshake(port, { origin: own, protocol: "chat" }), "HTTP/1.1 404 Not Found");
  assert.equal(await handshake(port, { path: "/elsewhere", origin: own, protocol: "vite-hmr" }), "HTTP/1.1 404 Not Found");
  assert.equal(await handshake(port, { path: "/api/events", origin: own }), "HTTP/1.1 404 Not Found");
});

test("no other origin and no rebound name opens a socket, Vite's included", async (t) => {
  const port = await host(t);
  for (const origin of ["http://evil.example", `http://127.0.0.1:${port + 1}`, "null"]) {
    assert.equal(await handshake(port, { origin, protocol: "vite-hmr" }), "HTTP/1.1 403 Forbidden");
    assert.equal(await handshake(port, { origin, protocol: "vite-ping" }), "HTTP/1.1 403 Forbidden");
    assert.equal(await handshake(port, { path: "/api/devices/stream?token=x", origin }), "HTTP/1.1 403 Forbidden");
    assert.equal(await handshake(port, { path: "/api/terminal/stream?token=x", origin }), "HTTP/1.1 403 Forbidden");
  }
  assert.equal(await handshake(port, { host: `evil.example:${port}`, protocol: "vite-hmr" }), "HTTP/1.1 403 Forbidden");
  assert.equal(await handshake(port, { host: "127.0.0.1:1", protocol: "vite-hmr" }), "HTTP/1.1 403 Forbidden");
});

test("a request-target that is not a plain path is answered and does not end the host", async (t) => {
  const port = await host(t);
  assert.equal(await handshake(port, { path: "//", protocol: "vite-hmr" }), "HTTP/1.1 404 Not Found");
  assert.equal(await handshake(port, { path: "//foo", protocol: "vite-hmr" }), "HTTP/1.1 404 Not Found");
  assert.equal(await handshake(port, { protocol: "vite-hmr" }), "HTTP/1.1 101 hot reload");
});

test("a failing device stream is answered with a 500", async (t) => {
  const port = await host(t, { deviceStream: () => Promise.reject(new Error("no device")) });
  assert.equal(await handshake(port, { path: "/api/devices/stream" }), "HTTP/1.1 500 Internal Server Error");
});

test("the built page has no hot reload, so Vite's upgrade is refused", async (t) => {
  const port = await host(t, { hotReload: undefined });
  assert.equal(await handshake(port, { protocol: "vite-hmr" }), "HTTP/1.1 404 Not Found");
});

test("Vite in middleware mode takes its socket from the server named in ws.server", async (t) => {
  const { createServer } = await import("vite");
  const hotReload = http.createServer();
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: { server: hotReload } },
  });
  t.after(() => vite.close());
  const port = await host(t, { hotReload: (req, socket, head) => hotReload.emit("upgrade", req, socket, head) });
  assert.equal(await handshake(port, { protocol: "vite-hmr" }), "HTTP/1.1 101 Switching Protocols");
  assert.equal(await handshake(port, { origin: "http://evil.example", protocol: "vite-hmr" }), "HTTP/1.1 403 Forbidden");
});
