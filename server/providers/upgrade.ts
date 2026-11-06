// The one listener for WebSocket upgrades on the host's HTTP server. Every upgrade passes refusePage first,
// as every page request does, so no other origin and no DNS-rebound name opens a socket. The device, terminal and
// browser-link sockets then check the launch token themselves. Vite's hot reload socket is handed to Vite only after that
// check: Vite listens on a server of its own that never binds a port (see devUi in index.ts), because a listener
// of Vite's on the host's server would see every upgrade before this one. An upgrade nobody takes is answered
// and closed, not left open.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { refusePage } from "../apiGuard.ts";

export const DEVICE_STREAM_PATH = "/api/devices/stream";
export const BROWSER_LINK_PATH = "/api/browser/link";
export const TERMINAL_STREAM_PATH = "/api/terminal/stream";

// The subprotocols Vite's client opens its socket with, at the base path "/".
const VITE_PROTOCOLS = new Set(["vite-hmr", "vite-ping"]);

export interface UpgradeRoutes {
  port: number;
  deviceStream(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  // The Electron app's link to the browser pane. It checks the launch token itself.
  browserLink?: (address: URL, req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  terminalStream(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  // Vite's upgrade handler in dev. The built page has none.
  hotReload?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export function createUpgradeRouter({ port, deviceStream, terminalStream, browserLink, hotReload }: UpgradeRoutes) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (refusePage(req, port)) {
      reject(socket, "403 Forbidden");
      return;
    }
    const address = parseTarget(req.url);
    if (!address) {
      reject(socket, "400 Bad Request");
      return;
    }
    if (address.pathname === DEVICE_STREAM_PATH) {
      deviceStream(address, req, socket, head).catch(() => reject(socket, "500 Internal Server Error"));
      return;
    }
    if (address.pathname === TERMINAL_STREAM_PATH) {
      terminalStream(address, req, socket, head).catch(() => reject(socket, "500 Internal Server Error"));
      return;
    }
    if (browserLink && address.pathname === BROWSER_LINK_PATH) {
      browserLink(address, req, socket, head);
      return;
    }
    if (hotReload && isHotReload(req, address)) {
      hotReload(req, socket, head);
      return;
    }
    reject(socket, "404 Not Found");
  };
}

export function isHotReload(req: IncomingMessage, address: URL): boolean {
  return address.pathname === "/" && VITE_PROTOCOLS.has(String(req.headers["sec-websocket-protocol"] || ""));
}

// Parsed as Vite parses it, so `//foo` is `//foo` here too and not `/`. A throw here would end the host,
// since it runs in an event listener.
function parseTarget(target = "/"): URL | null {
  try {
    return new URL(`http://127.0.0.1${target}`);
  } catch {
    return null;
  }
}

function reject(socket: Duplex, status: string) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
