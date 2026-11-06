import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRemote, DEVICE_COOKIE, REMOTE_HEADER } from "./remote.ts";
import { createDeviceStore } from "../devices/remoteDevices.ts";
import { createRemoteSettings, createTunnel, type Forward } from "./remoteTunnel.ts";

const PUBLIC = "abc.ngrok-free.app";
const LOCAL = "mac.local:9787";
const idle = () => createTunnel(async () => ({ url: () => `https://${LOCAL}`, close: async () => {} }));

// Requests go to the remote listener itself, at the address the tunnel was told to forward to.
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-"));
  const forwarded: string[] = [];
  const forward: Forward = async (config) => {
    forwarded.push(config.addr);
    return { url: () => `https://${PUBLIC}`, close: async () => {} };
  };
  const localForwarded: string[] = [];
  const local: Forward = async (config) => {
    localForwarded.push(config.addr);
    return { url: () => `https://${LOCAL}`, close: async () => {} };
  };
  const seen: IncomingHttpHeaders[] = [];
  const settings = createRemoteSettings(path.join(dir, "remote.json"));
  settings.save({ authtoken: "ngrok-token" });
  const devicesFile = path.join(dir, "devices.json");
  const remote = createRemote({
    port: 8787,
    token: "launch-token",
    devices: createDeviceStore({ file: devicesFile }),
    tunnel: createTunnel(forward),
    local: createTunnel(local),
    settings,
    sweepMs: 20,
    async handle(req, res) {
      seen.push({ ...req.headers });
      if (req.url === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: {}\n\n");
        return;
      }
      res.end("ok");
    },
  });
  await remote.setEnabled("ngrok", true);
  const port = Number((forwarded[0] ?? "").split(":")[1]);
  const close = () => remote.close();
  return { remote, settings, seen, forwarded, localForwarded, port, close, devicesFile };
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(port: number, target: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method, headers: { host: PUBLIC, ...headers } }, (res: IncomingMessage) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function pairPhone(port: number, remote: Awaited<ReturnType<typeof setup>>["remote"], host = PUBLIC): Promise<string> {
  const pairing = remote.startPairing();
  assert.ok(pairing);
  assert.ok(pairing.urls.includes(`https://${host}/pair#${pairing.code}`));
  const answer = await send(port, "/pair", { method: "POST", headers: { host, "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone)" }, body: { code: pairing.code } });
  assert.equal(answer.status, 200);
  const cookie = String(answer.headers["set-cookie"]?.[0] ?? "");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  return cookie.split(";")[0] ?? "";
}

test("the tunnel forwards to the remote listener, and only the tunnel's name and origin get an answer", async () => {
  const { forwarded, port, close } = await setup();
  try {
    assert.match(forwarded[0] ?? "", /^127\.0\.0\.1:\d+$/);
    assert.equal((await send(port, "/", { headers: { host: "127.0.0.1:8787" } })).status, 403);
    assert.equal((await send(port, "/pair", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await send(port, "/pair", { headers: { origin: `https://${PUBLIC}` } })).status, 200);
  } finally {
    await close();
  }
});

test("an unpaired browser gets only the pair page", async () => {
  const { seen, port, close } = await setup();
  try {
    const page = await send(port, "/", { headers: { accept: "text/html" } });
    assert.equal(page.status, 303);
    assert.equal(page.headers.location, "/pair");
    assert.equal((await send(port, "/api/events")).status, 403);
    assert.equal((await send(port, "/api/events", { headers: { cookie: `${DEVICE_COOKIE}=forged.secret` } })).status, 403);
    const pair = await send(port, "/pair");
    assert.match(pair.body, /Pair with X Bench/);
    assert.ok(!pair.body.includes("launch-token"));
    assert.deepEqual(seen, []);
    assert.equal((await send(port, "/manifest.webmanifest")).status, 200);
    assert.equal((await send(port, "/apple-touch-icon.png")).status, 200);
    assert.equal(seen.length, 2);
  } finally {
    await close();
  }
});

test("a paired phone reaches the host as a local request, and the Mac-only routes stay closed", async () => {
  const { remote, seen, port, close } = await setup();
  try {
    const cookie = await pairPhone(port, remote);
    assert.equal(remote.view().devices[0]?.name, "iPhone");
    const answer = await send(port, "/api/state", { headers: { cookie, origin: `https://${PUBLIC}`, "x-bench-token": "guess" } });
    assert.equal(answer.status, 200);
    assert.deepEqual(
      { host: seen[0]?.host, token: seen[0]?.["x-bench-token"], origin: seen[0]?.origin, cookie: seen[0]?.cookie },
      { host: "127.0.0.1:8787", token: "launch-token", origin: undefined, cookie: undefined },
    );
    for (const target of ["/api/remote", "/api/remote/pairing", "/api/mcp/key", "/api/terminal/open", "/api/devices/stream", "/api/browser/link"]) {
      assert.equal((await send(port, target, { headers: { cookie } })).status, 403, target);
    }
    assert.equal(seen.length, 1);
    assert.equal((await send(port, "/pair", { headers: { cookie } })).status, 303);
  } finally {
    await close();
  }
});

test("the request log names the path, status and device, and leaves out the query", async () => {
  const lines: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-log-"));
  const settings = createRemoteSettings(path.join(dir, "remote.json"));
  settings.save({ authtoken: "t" });
  const remote = createRemote({
    port: 8787,
    token: "launch-token",
    devices: createDeviceStore({ file: path.join(dir, "devices.json") }),
    tunnel: createTunnel(async () => ({ url: () => `https://${PUBLIC}`, close: async () => {} })),
    local: idle(),
    settings,
    handle: async (_req, res) => {
      res.end("ok");
    },
    log: (line) => lines.push(line),
  });
  await remote.setEnabled("ngrok", true);
  const server = http.createServer((req, res) => void remote.serve(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  try {
    await send(port, "/api/state?token=guess");
    await send(port, "/api/state", { headers: { host: "evil.example" } });
    assert.match(lines[0] ?? "", /^\[remote\] GET \/api\/state 403 unpaired \d+ms$/);
    assert.match(lines[1] ?? "", /^\[remote\] GET \/api\/state 403 refused \d+ms$/);
  } finally {
    await remote.close();
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
});

test("removing a device ends its event stream at once", async () => {
  const { remote, port, close } = await setup();
  try {
    const cookie = await pairPhone(port, remote);
    const id = remote.view().devices[0]?.id ?? "";
    const ended = new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: PUBLIC, cookie } }, (res) => {
        res.once("data", () => assert.ok(remote.removeDevice(id)));
        res.on("error", () => resolve());
        res.on("close", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
    await ended;
    assert.equal((await send(port, "/api/state", { headers: { cookie } })).status, 403);
  } finally {
    await close();
  }
});

test("turning remote access off stops the tunnel and keeps the switch per port", async () => {
  const { remote, settings, port, close } = await setup();
  try {
    assert.deepEqual(settings.read().enabledPorts, [8787]);
    await remote.setEnabled("ngrok", false);
    assert.equal(remote.view().ngrok.tunnel.state, "off");
    assert.equal(remote.startPairing(), null);
    assert.equal((await send(port, "/pair")).status, 403);
    assert.deepEqual(settings.read().enabledPorts, []);
    assert.equal(remote.view().hasAuthtoken, true);
    assert.ok(!JSON.stringify(remote.view()).includes("ngrok-token"));
  } finally {
    await close();
  }
});

test("a failed start shows ngrok's first line without the authtoken", async () => {
  const tunnel = createTunnel(async () => {
    throw new Error("failed to connect session: bad token secret-123\nYour authtoken: secret-123\nInstructions…");
  });
  const status = await tunnel.start("127.0.0.1:1", "secret-123", "");
  assert.deepEqual(status, { state: "failed", url: "", error: "failed to connect session: bad token …" });
});

test("a lost ngrok session reconnects, and starts over when it does not come back", async () => {
  const changes: ((status: string) => void)[] = [];
  const tunnel = createTunnel(async (config) => {
    if (config.onStatusChange) changes.push(config.onStatusChange);
    return { url: () => `https://${PUBLIC}`, close: async () => {} };
  }, { reconnectMs: 30 });
  await tunnel.start("127.0.0.1:1", "t", "");
  changes[0]?.("closed");
  assert.deepEqual(tunnel.status(), { state: "starting", url: `https://${PUBLIC}`, error: "Reconnecting to ngrok…" });
  assert.equal(tunnel.host(), "");
  changes[0]?.("connected");
  assert.equal(tunnel.status().state, "on");
  changes[0]?.("closed");
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
  assert.equal(changes.length, 2);
  assert.equal(tunnel.status().state, "on");
  changes[0]?.("closed");
  assert.equal(tunnel.status().state, "on");
  await tunnel.stop();
});

test("turning the tunnel off does not wait on a dead session", async () => {
  const tunnel = createTunnel(async () => ({ url: () => `https://${PUBLIC}`, close: () => new Promise<void>(() => {}) }), { closeMs: 20 });
  await tunnel.start("127.0.0.1:1", "t", "");
  const started = Date.now();
  await tunnel.stop();
  assert.ok(Date.now() - started < 500);
  assert.equal(tunnel.status().state, "off");
});

test("the sidebar's state follows the switch and the tunnel, and every change is announced", async () => {
  const { remote, close } = await setup();
  try {
    let changes = 0;
    const stop = remote.onChange(() => {
      changes += 1;
    });
    const localOff = { available: true, enabled: false, state: "off", url: "", error: "" };
    assert.deepEqual(remote.state(), { ngrok: { available: true, enabled: true, state: "on", url: `https://${PUBLIC}`, error: "" }, local: localOff });
    await remote.setEnabled("ngrok", false);
    assert.deepEqual(remote.state(), { ngrok: { available: true, enabled: false, state: "off", url: "", error: "" }, local: localOff });
    assert.ok(changes >= 2);
    stop();
    const before = changes;
    await remote.setEnabled("ngrok", true);
    assert.equal(changes, before);
  } finally {
    await close();
  }
});

test("the remote listener refuses every WebSocket upgrade, also from a paired phone", async () => {
  const { remote, port, close } = await setup();
  try {
    const cookie = await pairPhone(port, remote);
    for (const headers of [{}, { cookie }, { cookie, "sec-websocket-protocol": "vite-hmr" }]) {
      const answer = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          path: "/api/terminal/stream",
          headers: { host: PUBLIC, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
        });
        req.on("response", (res) => resolve(String(res.statusCode)));
        req.on("upgrade", () => resolve("upgraded"));
        req.on("error", reject);
        req.end();
      });
      assert.equal(answer, "403");
    }
  } finally {
    await close();
  }
});

test("pairing allows twenty tries a minute from all browsers together", async () => {
  const { remote, port, close } = await setup();
  try {
    remote.startPairing();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      statuses.push((await send(port, "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: { code: "WRONG" } })).status);
    }
    assert.ok(statuses.slice(0, 20).every((status) => status === 403));
    assert.equal(statuses[20], 429);
  } finally {
    await close();
  }
});

test("a phone removed by another X Bench process loses its stream and is not accepted", { timeout: 5000 }, async () => {
  const { remote, port, close, devicesFile } = await setup();
  try {
    const cookie = await pairPhone(port, remote);
    const id = remote.view().devices[0]?.id ?? "";
    const ended = new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: PUBLIC, cookie } }, (res) => {
        res.once("data", () => assert.ok(createDeviceStore({ file: devicesFile }).remove(id)));
        res.on("error", () => resolve());
        res.on("close", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
    await ended;
    assert.equal((await send(port, "/api/state", { headers: { cookie } })).status, 403);
  } finally {
    await close();
  }
});

test("a device removed in one process is never written back by another", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remote-shared-")), "devices.json");
  let now = 1_000_000;
  const app = createDeviceStore({ file, now: () => now });
  const dev = createDeviceStore({ file, now: () => now });
  const paired = app.pair(app.startPairing().code, "Phone");
  assert.ok(paired.ok);
  if (!paired.ok) return;
  assert.equal(dev.verify(paired.cookie)?.id, paired.device.id);
  assert.ok(app.remove(paired.device.id));
  now += 120_000;
  assert.equal(dev.verify(paired.cookie), null);
  assert.equal(createDeviceStore({ file }).verify(paired.cookie), null);
  assert.deepEqual(dev.list(), []);
});

test("a stop while a restart waits on the old listener keeps the tunnel off", async () => {
  let opened = 0;
  const tunnel = createTunnel(async () => {
    opened += 1;
    return { url: () => `https://${PUBLIC}`, close: () => new Promise<void>(() => {}) };
  }, { closeMs: 40 });
  await tunnel.start("127.0.0.1:1", "t", "");
  const restarting = tunnel.start("127.0.0.1:1", "t", "");
  await tunnel.stop();
  await restarting;
  assert.equal(tunnel.status().state, "off");
  assert.equal(opened, 1);
});

test("a start that fails tries again until it works, and gives up on a refused authtoken", async () => {
  let calls = 0;
  const tunnel = createTunnel(async () => {
    calls += 1;
    if (calls < 3) throw new Error("failed to connect session: network unreachable");
    return { url: () => `https://${PUBLIC}`, close: async () => {} };
  }, { retryMs: 10 });
  assert.equal((await tunnel.start("127.0.0.1:1", "t", "")).state, "failed");
  await new Promise((resolve) => {
    setTimeout(resolve, 120);
  });
  assert.equal(calls, 3);
  assert.equal(tunnel.status().state, "on");
  await tunnel.stop();

  let refused = 0;
  const bad = createTunnel(async () => {
    refused += 1;
    throw new Error("The authtoken you specified does not look like a proper ngrok authtoken.");
  }, { retryMs: 10 });
  await bad.start("127.0.0.1:1", "2abc-secret-token", "");
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
  assert.equal(refused, 1);
  await bad.stop();
});

test("a paired phone reaches only the checked path, marked as remote, and never what stays on the Mac", async () => {
  const { remote, seen, port, close } = await setup();
  try {
    const cookie = await pairPhone(port, remote);
    const blocked = ["/api/./remote", "/api/browse", "/api/folder/open", "/api/providers/choose", "/api/devices", "/api/devices/input", "/api/browser/open", "/api/browser/tab", "/api/sak/open", "/api/board/open", "/api/terminal/open"];
    for (const target of blocked) assert.equal((await send(port, target, { headers: { cookie } })).status, 403, target);
    assert.equal(seen.length, 0);
    await send(port, "/api/remote/../state?x=1", { headers: { cookie, [REMOTE_HEADER]: "0" } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.[REMOTE_HEADER], "1");
    assert.equal((await send(port, "/api/browser/thumb/abc.png", { headers: { cookie } })).status, 200);
  } finally {
    await close();
  }
});

test("switching off while the listener starts keeps the tunnel off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-early-"));
  const settings = createRemoteSettings(path.join(dir, "remote.json"));
  settings.save({ authtoken: "t" });
  let opened = 0;
  const remote = createRemote({
    port: 8787,
    token: "launch-token",
    devices: createDeviceStore({ file: path.join(dir, "devices.json") }),
    tunnel: createTunnel(async () => {
      opened += 1;
      return { url: () => `https://${PUBLIC}`, close: async () => {} };
    }),
    local: idle(),
    settings,
    handle: async (_req, res) => {
      res.end("ok");
    },
  });
  try {
    const starting = remote.setEnabled("ngrok", true);
    await remote.setEnabled("ngrok", false);
    await starting;
    assert.equal(opened, 0);
    assert.equal(remote.view().ngrok.tunnel.state, "off");
  } finally {
    await remote.close();
  }
});

test("the local network runs beside ngrok on its own listener, without an authtoken, and outlives ngrok's stop", async () => {
  const { remote, settings, localForwarded, port, close } = await setup();
  try {
    await remote.setEnabled("local", true);
    const localPort = Number((localForwarded[0] ?? "").split(":")[1]);
    assert.notEqual(localPort, port);
    assert.deepEqual(settings.read().localPorts, [8787]);
    const pairing = remote.startPairing();
    assert.deepEqual(pairing?.urls, [`https://${PUBLIC}/pair#${pairing?.code}`, `https://${LOCAL}/pair#${pairing?.code}`]);
    // Each listener answers only its own tunnel's name.
    assert.match((await send(localPort, "/api/state")).body, /Unknown host/);
    assert.match((await send(port, "/api/state", { headers: { host: LOCAL } })).body, /Unknown host/);
    const cookie = await pairPhone(localPort, remote, LOCAL);

    settings.save({ authtoken: "" });
    await remote.setEnabled("ngrok", false);
    assert.equal(remote.state().ngrok.available, false);
    assert.equal(remote.state().local.state, "on");
    const later = remote.startPairing();
    assert.deepEqual(later?.urls, [`https://${LOCAL}/pair#${later?.code}`]);
    const answer = await send(localPort, "/api/state", { headers: { host: LOCAL, origin: `https://${LOCAL}`, cookie } });
    assert.equal(answer.body, "ok");
  } finally {
    await close();
  }
});
