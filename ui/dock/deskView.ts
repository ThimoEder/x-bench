import type { OpenSession } from "../../server/snapshot.ts";

// An open chat, or one the page shows while the host loads it.
export type ShownSession = OpenSession & { loading?: true; archived?: true };

// The draft closes as soon as the new session exists. The event stream can
// still be showing the previous desk for a moment, so keep the new session
// on screen until that list catches up.
export function sessionsForDesk<T extends { id: string }>(openSessions: T[] | null | undefined, handoff: T | null | undefined): T[] {
  const open = openSessions || [];
  if (handoff && !open.some((session) => session.id === handoff.id)) return [handoff];
  return open;
}

// The server answers "No session is open" for a session that already left its desk, and the snapshot
// that drops it can arrive after that reply. A request that named a session is stale, so it stays out of the banner.
export function staleSessionFailure(message: unknown, sessionId: unknown): boolean {
  return message === "No session is open" && Boolean(sessionId);
}

// The session a request names: in the body of a POST, in the sessionId query parameter otherwise.
export function requestSessionId(path: string, body: unknown): string {
  if (body && typeof body === "object" && "sessionId" in body && body.sessionId) return String(body.sessionId);
  return new URLSearchParams(path.split("?")[1] || "").get("sessionId") || "";
}

// The first message of a new session, shown the moment it is sent. Creating the session takes a
// second or two, and the host's copy of it has no message until the prompt is posted.
export interface FirstMessage {
  // The session it went to, once the host has made it.
  sessionId: string | null;
  text: string;
  attachments: { name: string; kind: "image" | "file"; mimeType: string; preview?: string }[];
}

interface PendingCapable {
  id: string;
  status: string;
  transcript: readonly { type: string }[];
}

// The session with the first message in front, running, until the host's copy has a message of its own.
export function withFirstMessage<T extends PendingCapable>(session: T, first: FirstMessage | null, id = first?.sessionId): T {
  if (!first || session.id !== id || session.transcript.some((item) => item.type === "user")) return session;
  const item = {
    id: "first-message",
    type: "user" as const,
    text: first.text,
    streaming: false,
    ...(first.attachments.length ? { attachments: first.attachments } : {}),
  };
  return { ...session, status: "running", transcript: [item, ...session.transcript] };
}

// A chat the page switched to before the host has loaded it, and the slot it takes: the whole desk, a slot
// beside the open chat, or the slot of the chat it replaces.
export interface Opening<T> {
  session: T;
  place: "replace" | "beside" | { replaceId: string };
}

// The slot a chat dropped on a pane takes. A pane still loading has no slot on the host's desk yet, so the
// dropped chat takes the slot that pane was going to take.
export function slotOf<T extends { id: string }>(paneId: string, opening: Opening<T> | null): Opening<T>["place"] {
  return opening?.session.id === paneId ? opening.place : { replaceId: paneId };
}

// The desk with the chat being opened in its slot, until the host's desk lists it.
export function deskWithOpening<T extends { id: string }>(openSessions: T[], opening: Opening<T> | null): T[] {
  if (!opening || openSessions.some((session) => session.id === opening.session.id)) return openSessions;
  const { place, session } = opening;
  if (place === "beside") return [...openSessions, session];
  if (place !== "replace" && openSessions.some((item) => item.id === place.replaceId)) {
    return openSessions.map((item) => (item.id === place.replaceId ? session : item));
  }
  return [session];
}

// The chat while it loads: a Grok chat's stored copy when the host sent one, or an empty one the pane
// shows as a skeleton. Its title and provider come from its sidebar row.
export function loadingSession(row: { id: string; cwd: string; title?: string | null; provider?: string }, stored: OpenSession | null = null): OpenSession & { loading: true } {
  if (stored) return { ...stored, title: row.title || stored.title, loading: true };
  return {
    id: row.id,
    cwd: row.cwd,
    status: "idle",
    stopReason: null,
    error: null,
    revision: 0,
    modelId: null,
    reasoningEffort: null,
    configOptions: [],
    commands: [],
    plan: null,
    planDoc: null,
    usage: null,
    context: null,
    pendingPermission: null,
    pendingPlan: null,
    pendingQuestion: null,
    mentions: [],
    transcript: [],
    modeId: "",
    activity: null,
    backgroundTasks: [],
    queue: [],
    suggestion: null,
    title: row.title || null,
    provider: row.provider || "",
    suggestions: [],
    loading: true,
  };
}

interface DeskReply {
  open?: OpenSession[];
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The host builds these lists from the same open sessions it publishes.
function isOpenList(value: unknown): value is OpenSession[] {
  return Array.isArray(value);
}

export function deskReply(data: unknown): DeskReply {
  if (!isRecord(data)) return {};
  return {
    open: isOpenList(data.open) ? data.open : undefined,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
  };
}
