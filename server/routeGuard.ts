// The one check for routes that act on a session: its id must be on the desk, or be a new session still
// waiting for its first prompt. A POST names the session in its body, whose schema must keep sessionId, other methods
// in the sessionId query parameter.

import { isRecord } from "../bridge/lenient.ts";
import type { Provider } from "../bridge/provider.ts";
import type { SessionState } from "../bridge/reducer.ts";
import { sendJson } from "./http.ts";
import type { Host } from "./app.ts";
import type { RouteRequest } from "./router.ts";

export interface OnDeskRequest<Body = unknown> extends RouteRequest<Body> {
  sessionId: string;
}

export interface SessionRequest<Body = unknown> extends OnDeskRequest<Body> {
  current: SessionState;
  // The provider that holds the session.
  provider: Provider;
}

// The reply for a session that is not open.
export interface Closed {
  status: number;
  error: string;
}

type Handler<T> = (request: T) => Promise<void> | void;

const NOT_OPEN: Closed = { status: 400, error: "No session is open" };

const FOLDER_GONE: Closed = { status: 409, error: "This chat's folder is gone" };

export function deskGuard({ desk, providers, store }: Pick<Host, "desk" | "providers" | "store">) {
  function sessionIdOf({ req, url, body }: RouteRequest): string {
    const named = req.method === "POST" ? (isRecord(body) ? body.sessionId : "") : url.searchParams.get("sessionId");
    return typeof named === "string" ? named : "";
  }

  function refuse({ res }: RouteRequest, closed: Closed) {
    sendJson(res, closed.status, { error: closed.error });
  }

  return {
    // The id is on the desk. No provider may hold the session.
    onDesk<Body>(handle: Handler<OnDeskRequest<Body>>, closed: Closed = NOT_OPEN): Handler<RouteRequest<Body>> {
      return (request) => {
        const sessionId = sessionIdOf(request);
        if (!desk.has(sessionId)) return refuse(request, closed);
        return handle({ ...request, sessionId });
      };
    },
    // The id is on the desk, or a new session opened off it still waits for its first prompt.
    onDeskOrUnsent<Body>(handle: Handler<OnDeskRequest<Body>>): Handler<RouteRequest<Body>> {
      return (request) => {
        const sessionId = sessionIdOf(request);
        if (!desk.has(sessionId) && !store.unsent.has(sessionId)) return refuse(request, NOT_OPEN);
        return handle({ ...request, sessionId });
      };
    },
    // The id is on the desk, or the chat waits on the person, who answers it from the Needs you page.
    onDeskOrWaiting<Body>(handle: Handler<OnDeskRequest<Body>>): Handler<RouteRequest<Body>> {
      return (request) => {
        const sessionId = sessionIdOf(request);
        if (!desk.has(sessionId) && !store.snapshot.needsYou.some((wait) => wait.sessionId === sessionId)) return refuse(request, NOT_OPEN);
        return handle({ ...request, sessionId });
      };
    },
    // The id is on the desk and a provider holds the session.
    withSession<Body>(handle: Handler<SessionRequest<Body>>, closed: Closed = NOT_OPEN): Handler<RouteRequest<Body>> {
      return (request) => {
        const sessionId = sessionIdOf(request);
        const provider = providers.forSession(sessionId);
        const current = provider.getSession(sessionId);
        if (!desk.has(sessionId) || !current) return refuse(request, closed);
        return handle({ ...request, sessionId, current, provider });
      };
    },
    // Inside onDesk or withSession: the session's folder exists. A chat whose folder is gone runs in a stand-in.
    inFolder<T extends OnDeskRequest>(handle: Handler<T>): Handler<T> {
      return (request) => (store.goneFolders.has(request.sessionId) ? refuse(request, FOLDER_GONE) : handle(request));
    },
  };
}
