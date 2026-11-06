// The one check every /api request and the device, terminal and browser-link sockets pass before a route runs.
// Only the X Bench page on this host, or a local script that read the launch token, gets through:
// - Host must be 127.0.0.1:<port> or localhost:<port>, so a DNS-rebound name is refused.
// - Origin, when the browser sends one, must be the host's own origin.
// - The launch token must come in the X-Bench-Token header, or for a GET and the sockets in ?token=.
// - A request that can change something must be JSON (or the type its route names), so a page on another
//   site cannot send it as a simple request without a preflight.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const TOKEN_HEADER = "x-bench-token";
export const TOKEN_PARAM = "token";

// A JSON body larger than this is refused. /api/prompt raises it for attached files.
export const MAX_JSON_BYTES = 1024 * 1024;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface Refusal {
  status: number;
  error: string;
}

export interface GuardOptions {
  port: number;
  token: string;
}

// Host, Origin and token. Checked before the request is routed.
export function refuseRequest(req: IncomingMessage, url: URL, { port, token }: GuardOptions): Refusal | null {
  const page = refusePage(req, port);
  if (page) return page;
  if (!sameToken(tokenOf(req, url), token)) return { status: 403, error: "Missing or wrong launch token" };
  return null;
}

// Content type and size for a request that carries a body. Checked once the route is known.
export function refuseBody(req: IncomingMessage, contentType = "application/json", maxBytes = MAX_JSON_BYTES): Refusal | null {
  if (!BODY_METHODS.has(String(req.method))) return null;
  const sent = (String(req.headers["content-type"] || "").split(";")[0] ?? "").trim().toLowerCase();
  if (sent !== contentType) return { status: 415, error: `Send ${contentType}` };
  const length = Number(req.headers["content-length"]);
  if (Number.isFinite(length) && length > maxBytes) return { status: 413, error: "Request body is too large" };
  return null;
}

// Host and Origin for a page request (index.html and Vite's modules). The page carries the token, so neither a
// DNS-rebound name nor a page on another origin, such as another localhost port, may read it.
export function refusePage(req: IncomingMessage, port: number): Refusal | null {
  if (!knownHost(req, port)) return { status: 403, error: "Unknown host" };
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${String(req.headers.host).toLowerCase()}`) return { status: 403, error: "Foreign origin" };
  return null;
}

export function knownHost(req: IncomingMessage, port: number): boolean {
  const host = String(req.headers.host || "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function tokenOf(req: IncomingMessage, url: URL): string {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === "string" && header) return header;
  // EventSource, <img> and WebSocket cannot send a header.
  if (req.method === "GET") return url.searchParams.get(TOKEN_PARAM) || "";
  return "";
}

function sameToken(sent: string, token: string): boolean {
  const left = Buffer.from(sent);
  const right = Buffer.from(token);
  return Boolean(token) && left.length === right.length && timingSafeEqual(left, right);
}
