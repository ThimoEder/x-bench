// The /api route table: each route names a method and a path, and dispatch runs the first match.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { refuseBody } from "./apiGuard.ts";
import { readJson, sendJson } from "./http.ts";
import { issueText } from "./bodies.ts";

export interface RouteRequest<Body = unknown> {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  // Undefined for a route without a body schema.
  body: Body;
  // The groups of a pattern path, or [] for an exact path.
  match: string[];
}

export interface Route<Body = unknown> {
  // Any method when missing.
  method?: string;
  // The exact pathname, a pattern for it, or a test on it.
  path: string | RegExp | ((pathname: string) => boolean);
  // The handler reads the request body itself.
  raw?: boolean;
  // A body that fails it gets 400. A GET or HEAD reads as {}.
  body?: z.ZodType<Body>;
  // The body type a POST, PUT, PATCH or DELETE must send. application/json when missing.
  contentType?: string;
  // The largest body in bytes. MAX_JSON_BYTES when missing.
  maxBody?: number;
  handle(request: RouteRequest<Body>): Promise<void> | void;
}

// Types the handler's body from the route's schema, which a plain object in a Route[] cannot.
export function route<Body>(route: Route<Body>): Route {
  return route;
}

export async function dispatch(routes: readonly Route[], req: IncomingMessage, res: ServerResponse, url: URL) {
  for (const route of routes) {
    if (route.method && route.method !== req.method) continue;
    const match = matchPath(route.path, url.pathname);
    if (!match) continue;
    const refused = refuseBody(req, route.contentType, route.maxBody);
    if (refused) {
      sendJson(res, refused.status, { error: refused.error });
      return;
    }
    const sent = route.raw || req.method === "GET" || req.method === "HEAD" ? {} : await readJson(req, route.maxBody);
    const parsed = route.body?.safeParse(sent);
    if (parsed && !parsed.success) {
      sendJson(res, 400, { error: issueText(parsed.error) });
      return;
    }
    await route.handle({ req, res, url, body: parsed?.data, match });
    return;
  }
  // An unknown POST still has its body checked and read first, so a body that is not JSON fails the same way.
  const refused = refuseBody(req);
  if (refused) {
    sendJson(res, refused.status, { error: refused.error });
    return;
  }
  if (req.method === "POST") await readJson(req);
  sendJson(res, 404, { error: "Not found" });
}

function matchPath(path: Route["path"], pathname: string): string[] | null {
  if (typeof path === "string") return path === pathname ? [] : null;
  if (typeof path === "function") return path(pathname) ? [] : null;
  return path.exec(pathname);
}
