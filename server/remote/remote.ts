// Remote access: a listener on 127.0.0.1 per tunnel that only that tunnel forwards to: ngrok, and the local
// network's TLS listener (localTunnel.ts). Each switches on by itself. Every request comes from outside, so it is
// checked here before the host sees it:
// - Host must be the tunnel's name, and Origin, when sent, its https origin.
// - The pair page and the home-screen app's manifest and icons are all an unpaired browser gets. Every other
//   request needs a paired device's cookie.
// - The terminal, the device and browser streams, the agents' MCP endpoint and remote access's own settings stay
//   on the Mac. WebSocket upgrades are refused.
// A request that passes is rewritten as a local one (Host, launch token) and handed to the host's own handler,
// which serves the page without the launch token.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TOKEN_HEADER } from "../apiGuard.ts";
import { readJson, sendJson } from "../http.ts";
import type { DeviceStore, RemoteDevice } from "../devices/remoteDevices.ts";
import { cleanDomain, type RemoteKind, type RemoteSettings, type RemoteSettingsStore, type Tunnel, type TunnelStatus } from "./remoteTunnel.ts";
import type { RemoteState } from "../snapshot.ts";

export const PAIR_PATH = "/pair";
export const DEVICE_COOKIE = "xb_device";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
// Pair attempts from every browser together, per minute.
const PAIR_ATTEMPTS = 20;

// The home-screen app's manifest and icons. Browsers fetch the manifest without cookies, so these need no pairing.
export const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/favicon.png"]);

// What stays on the Mac: remote access's own settings, the agents' tools, the terminal, the simulators, the
// browser pane's controls, the board's signed-in tab, and anything that opens a dialog or Finder there.
const BLOCKED = [
  /^\/api\/remote(\/|$)/,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/terminal(\/|$)/,
  /^\/api\/devices(\/|$)/,
  /^\/api\/browser\/(link|open|tab)$/,
  /^\/api\/browse$/,
  /^\/api\/(sak|board)\/open$/,
  /^\/api\/folder\/open$/,
  /^\/api\/providers\/choose$/,
];

// Set on every request the remote listener hands to the host, whatever the phone sent, so a route can refuse
// what only makes sense at the Mac.
export const REMOTE_HEADER = "x-bench-remote";

export function viaRemote(req: IncomingMessage): boolean {
  return req.headers[REMOTE_HEADER] === "1";
}

export interface RemoteView {
  hasAuthtoken: boolean;
  domain: string;
  ngrok: { enabled: boolean; tunnel: TunnelStatus };
  local: { enabled: boolean; tunnel: TunnelStatus };
  devices: RemoteDevice[];
  // One pair link per tunnel that is on.
  pairing: { code: string; expiresAt: number; urls: string[] } | null;
}

export interface Remote {
  view(): RemoteView;
  state(): RemoteState;
  // Calls listener when the tunnel, the switch or the saved token changes. Returns the unsubscribe.
  onChange(listener: () => void): () => void;
  saveSettings(change: { authtoken?: string; domain?: string }): RemoteView;
  setEnabled(kind: RemoteKind, enabled: boolean): Promise<RemoteView>;
  startIfEnabled(): Promise<void>;
  startPairing(): RemoteView["pairing"];
  cancelPairing(): void;
  removeDevice(id: string): boolean;
  // A listener's own handler, for tests.
  serve(req: IncomingMessage, res: ServerResponse, kind?: RemoteKind): Promise<void>;
  close(): Promise<void>;
}

export interface RemoteOptions {
  port: number;
  token: string;
  devices: DeviceStore;
  tunnel: Tunnel;
  local: Tunnel;
  settings: RemoteSettingsStore;
  // The host's handler for a request that now looks local.
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  // One line per finished request through the tunnel, without its query string.
  log?: (line: string) => void;
  now?: () => number;
  // How often open streams are checked against devices removed in another process.
  sweepMs?: number;
  // Called when the last tunnel turns off, so the host can stop work done only for the phone.
  onStop?: () => void;
}

// One tunnel and the listener only it forwards to.
interface Link {
  kind: RemoteKind;
  tunnel: Tunnel;
  server: http.Server;
  listening: Promise<number> | null;
  // Each start or stop takes a new generation, so a start still waiting on the listener gives way to a later stop.
  generation: number;
  // From a start until its stop, so the last stop knows it is the last.
  on: boolean;
}

export function createRemote({ port, token, devices, tunnel, local, settings, handle, log, now = Date.now, sweepMs = 2000, onStop }: RemoteOptions): Remote {
  // Each device's open responses, so removing a device ends its event stream at once.
  const open = new Map<string, Set<ServerResponse>>();
  let attempts: number[] = [];
  const listeners = new Set<() => void>();
  let sweep: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const links: Record<RemoteKind, Link> = { ngrok: makeLink("ngrok", tunnel), local: makeLink("local", local) };
  const kinds = ["ngrok", "local"] as const;

  function makeLink(kind: RemoteKind, linkTunnel: Tunnel): Link {
    const server = http.createServer((req, res) => {
      serve(req, res, kind).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "Request failed" });
      });
    });
    server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    return { kind, tunnel: linkTunnel, server, listening: null, generation: 0, on: false };
  }

  function portsOf(stored: RemoteSettings, kind: RemoteKind): number[] {
    return kind === "ngrok" ? stored.enabledPorts : stored.localPorts;
  }

  function changed() {
    for (const notify of listeners) notify();
  }

  function listen(link: Link): Promise<number> {
    link.listening ??= new Promise((resolve, reject) => {
      link.server.once("error", reject);
      link.server.listen(0, "127.0.0.1", () => resolve((link.server.address() as AddressInfo).port));
    });
    return link.listening;
  }

  function pairingView(): RemoteView["pairing"] {
    const pairing = devices.pairing();
    if (!pairing) return null;
    const urls = kinds
      .map((kind) => links[kind].tunnel.status())
      .filter((status) => status.state === "on" && status.url)
      .map((status) => `${status.url}${PAIR_PATH}#${pairing.code}`);
    return urls.length ? { ...pairing, urls } : null;
  }

  function view(): RemoteView {
    const stored = settings.read();
    return {
      hasAuthtoken: Boolean(stored.authtoken),
      domain: stored.domain,
      ngrok: { enabled: stored.enabledPorts.includes(port), tunnel: tunnel.status() },
      local: { enabled: stored.localPorts.includes(port), tunnel: local.status() },
      devices: devices.list(),
      pairing: pairingView(),
    };
  }

  async function start(link: Link) {
    const mine = ++link.generation;
    const { authtoken, domain } = settings.read();
    if ((link.kind === "ngrok" && !authtoken) || closed) return;
    link.on = true;
    const listening = await listen(link);
    if (mine !== link.generation) return;
    // A device removed in another X Bench process loses its open streams here too.
    sweep ??= setInterval(() => {
      for (const id of open.keys()) if (!devices.has(id)) closeDevice(id);
    }, sweepMs);
    sweep.unref?.();
    await link.tunnel.start(`127.0.0.1:${listening}`, authtoken, domain);
  }

  // Everything this stop owns ends before it waits on the tunnel, so a start in the meantime keeps its own streams.
  async function stop(link: Link) {
    link.generation += 1;
    link.on = false;
    const ending = link.tunnel.stop();
    link.server.closeAllConnections();
    if (!kinds.some((kind) => links[kind].on)) {
      clearInterval(sweep);
      sweep = undefined;
      devices.cancelPairing();
      open.clear();
      onStop?.();
    }
    await ending;
  }

  function closeDevice(id: string) {
    for (const res of open.get(id) ?? []) res.destroy();
    open.delete(id);
  }

  function track(id: string, res: ServerResponse) {
    const set = open.get(id) ?? new Set<ServerResponse>();
    set.add(res);
    open.set(id, set);
    res.on("close", () => {
      set.delete(res);
      if (!set.size) open.delete(id);
    });
  }

  async function serve(req: IncomingMessage, res: ServerResponse, kind: RemoteKind = "ngrok") {
    let who = "refused";
    if (log) {
      const started = now();
      const method = req.method;
      const target = String(req.url || "/").split("?")[0];
      res.on("close", () => log(`[remote] ${method} ${target} ${res.statusCode} ${who} ${now() - started}ms`));
    }
    const host = links[kind].tunnel.host();
    if (!host || String(req.headers.host || "").toLowerCase() !== host) {
      sendJson(res, 403, { error: "Unknown host" });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `https://${host}`) {
      sendJson(res, 403, { error: "Foreign origin" });
      return;
    }
    const url = new URL(req.url || "/", `https://${host}`);
    const device = devices.verify(cookieOf(req));
    who = device?.name ?? "unpaired";
    if (url.pathname === PAIR_PATH) {
      await pairRoute(req, res, device);
      return;
    }
    const publicFile = req.method === "GET" && PUBLIC_FILES.has(url.pathname);
    if (!device && !publicFile) {
      if (req.method === "GET" && String(req.headers.accept || "").includes("text/html")) {
        res.writeHead(303, { Location: PAIR_PATH, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      sendJson(res, 403, { error: "Pair this device first" });
      return;
    }
    if (BLOCKED.some((pattern) => pattern.test(url.pathname))) {
      sendJson(res, 403, { error: "This stays on the Mac" });
      return;
    }
    if (device) track(device.id, res);
    req.headers.host = `127.0.0.1:${port}`;
    delete req.headers.origin;
    delete req.headers.cookie;
    req.headers[TOKEN_HEADER] = token;
    req.headers[REMOTE_HEADER] = "1";
    // The host routes the path that was checked here, whatever base it parses the target against.
    req.url = url.pathname + url.search;
    await handle(req, res);
  }

  async function pairRoute(req: IncomingMessage, res: ServerResponse, device: RemoteDevice | null) {
    if (req.method === "GET") {
      if (device) {
        res.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const page = Buffer.from(PAIR_PAGE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": page.length, "Cache-Control": "no-store" });
      res.end(page);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST" });
      res.end();
      return;
    }
    if (String(req.headers["content-type"] || "").split(";")[0]?.trim().toLowerCase() !== "application/json") {
      sendJson(res, 415, { error: "Send application/json" });
      return;
    }
    const at = now();
    attempts = attempts.filter((time) => at - time < 60_000);
    if (attempts.length >= PAIR_ATTEMPTS) {
      sendJson(res, 429, { error: "Too many tries. Wait a minute" });
      return;
    }
    attempts.push(at);
    const body = await readJson(req, 4096);
    const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const name = typeof input.name === "string" && input.name.trim() ? input.name : deviceName(String(req.headers["user-agent"] || ""));
    const paired = devices.pair(typeof input.code === "string" ? input.code : "", name);
    if (!paired.ok) {
      sendJson(res, 403, { error: paired.error });
      return;
    }
    res.setHeader("Set-Cookie", `${DEVICE_COOKIE}=${paired.cookie}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
    sendJson(res, 200, { ok: true, name: paired.device.name });
  }

  return {
    view,
    state() {
      const stored = settings.read();
      const linkState = (kind: RemoteKind, available: boolean) => {
        const { state, url, error } = links[kind].tunnel.status();
        return { available, enabled: portsOf(stored, kind).includes(port), state, url, error };
      };
      return { ngrok: linkState("ngrok", Boolean(stored.authtoken)), local: linkState("local", true) };
    },
    onChange(notify) {
      listeners.add(notify);
      const unsubscribe = [tunnel.onChange(notify), local.onChange(notify)];
      return () => {
        listeners.delete(notify);
        for (const each of unsubscribe) each();
      };
    },
    saveSettings(change) {
      const next: { authtoken?: string; domain?: string } = {};
      if (typeof change.authtoken === "string" && change.authtoken.trim()) next.authtoken = change.authtoken.trim();
      if (typeof change.domain === "string") next.domain = cleanDomain(change.domain);
      settings.save(next);
      changed();
      return view();
    },
    async setEnabled(kind, enabled) {
      const others = portsOf(settings.read(), kind).filter((item) => item !== port);
      const ports = enabled ? [...others, port] : others;
      settings.save(kind === "ngrok" ? { enabledPorts: ports } : { localPorts: ports });
      changed();
      if (enabled) await start(links[kind]);
      else await stop(links[kind]);
      return view();
    },
    async startIfEnabled() {
      const stored = settings.read();
      await Promise.all(kinds.filter((kind) => portsOf(stored, kind).includes(port)).map((kind) => start(links[kind])));
    },
    startPairing() {
      if (!kinds.some((kind) => links[kind].tunnel.status().state === "on")) return null;
      devices.startPairing();
      return pairingView();
    },
    cancelPairing: () => devices.cancelPairing(),
    removeDevice(id) {
      const removed = devices.remove(id);
      closeDevice(id);
      return removed;
    },
    serve,
    async close() {
      closed = true;
      await Promise.all(kinds.map((kind) => stop(links[kind])));
      await Promise.all(kinds.map((kind) => links[kind].listening && new Promise((resolve) => {
        links[kind].server.close(resolve);
      })));
    },
  };
}

export function cookieOf(req: IncomingMessage): string {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === DEVICE_COOKIE) return value.join("=");
  }
  return "";
}

export function deviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android phone";
  if (/Macintosh/.test(userAgent)) return "Mac";
  return "Browser";
}

const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Pair with X Bench</title>
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<style>
  body { font: 16px/1.4 -apple-system, system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  form { width: min(22rem, calc(100vw - 2rem)); display: grid; gap: 0.75rem; }
  .logo { width: 56px; height: 56px; border-radius: 13px; }
  h1 { font-size: 1.4rem; margin: 0; }
  p { margin: 0; opacity: 0.75; }
  label { display: grid; gap: 0.3rem; font-size: 0.9rem; }
  input { font: inherit; padding: 0.6rem 0.7rem; border-radius: 0.5rem; border: 1px solid #8886; }
  #code { font-family: ui-monospace, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
  button { font: inherit; padding: 0.65rem; border-radius: 0.5rem; border: 0; background: #2f6fed; color: white; }
  button:disabled { opacity: 0.6; }
  #error { color: #d33; min-height: 1.4em; }
</style>
</head>
<body>
<form id="pair">
  <img class="logo" src="/apple-touch-icon.png" alt="" />
  <h1>Pair with X Bench</h1>
  <p>Scan the code in X Bench's Settings, Remote, on your Mac, or type the code shown there.</p>
  <label>Code <input id="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required /></label>
  <label>Name for this device <input id="name" placeholder="iPhone" autocomplete="off" /></label>
  <button type="submit">Pair</button>
  <p id="error" role="alert"></p>
</form>
<script>
  const form = document.getElementById("pair");
  const code = document.getElementById("code");
  const error = document.getElementById("error");
  code.value = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch("${PAIR_PATH}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.value, name: document.getElementById("name").value }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) location.replace("/");
      else error.textContent = data.error || "Pairing failed";
    } catch {
      error.textContent = "The Mac did not answer";
    } finally {
      button.disabled = false;
    }
  });
</script>
</body>
</html>
`;
