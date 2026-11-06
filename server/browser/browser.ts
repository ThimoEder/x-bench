// The browser pane's state on the host. The Electron app owns the pane's tabs and connects to the host over a
// WebSocket at /api/browser/link (desktop/browser/browser.js). The host sends it calls (open a page, a Chrome
// DevTools command, a capture) and gets the tabs back whenever they change. Agents reach the pane through
// the browser tools (browserTools.ts), and the page through /api/browser/*.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fields, isRecord, listOf } from "../../bridge/lenient.ts";
import { createPrompts, type Prompts } from "../chat/prompts.ts";
import type { WebSocketConnection } from "../websocket.ts";

export { PROMPT_OPTIONS } from "../chat/prompts.ts";

export interface BrowserTab {
  id: number;
  // The chat the tab belongs to.
  owner: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // Mouse input goes in at page coordinates times this, while a wide viewport is shrunk to fit the pane.
  inputScale: number;
}

// What the page knows about the pane: every chat's tabs, and each chat's current tab. focus counts up
// whenever a page opens in a new tab, so the page brings the Browser tab up for that chat.
export interface BrowserView {
  available: boolean;
  tabs: BrowserTab[];
  active: Record<string, number>;
  focus: { count: number; owner: string | null };
}

const Tab = z.object({
  id: z.number().int(),
  owner: z.string(),
  url: z.string().catch(""),
  title: z.string().catch(""),
  loading: z.boolean().catch(false),
  canGoBack: z.boolean().catch(false),
  canGoForward: z.boolean().catch(false),
  inputScale: z.number().positive().catch(1).default(1),
});

const Incoming = fields({
  type: z.string().catch(""),
  id: z.number().optional().catch(undefined),
  result: z.unknown().optional(),
  error: z.string().optional().catch(undefined),
  tabs: listOf(Tab).optional(),
  active: z.record(z.string(), z.number().int()).optional().catch(undefined),
});

const CALL_TIMEOUT_MS = 30_000;
const MAX_THUMBS = 300;
const THUMB_ID = /^[a-f0-9]{12}$/;

// The browser also holds the host's prompts (prompts.ts), since its changes reach the page the same way.
export interface Browser extends Prompts {
  view(): BrowserView;
  // The Electron app's link. While one app is linked, another is turned away until that link closes.
  attach(link: WebSocketConnection): boolean;
  // Counts links, so tab ids from an earlier app are never taken for the current app's tabs.
  generation(): number;
  call<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  // A chat's current tab, if it has one.
  current(owner: string): BrowserTab | null;
  // Brings the Browser tab up for the chat.
  focus(owner: string): void;
  // prompts is true when a prompt came or went, which the sessions' permission cards show.
  onChange(listener: (prompts: boolean) => void): () => void;

  // A deleted chat: its prompts are denied and its tabs closed.
  forget(sessionId: string): void;

  saveThumb(data: string): string | null;
  thumbFile(id: string): string | null;
}

export function createBrowser(dir: string): Browser {
  let link: WebSocketConnection | null = null;
  let tabs: BrowserTab[] = [];
  let active: Record<string, number> = {};
  let focus: BrowserView["focus"] = { count: 0, owner: null };
  let links = 0;
  let nextCall = 1;
  const calls = new Map<number, { link: WebSocketConnection; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const listeners = new Set<(prompts: boolean) => void>();
  const prompts = createPrompts(() => changed(true));

  function changed(prompts = false) {
    for (const listener of listeners) listener(prompts);
  }

  function dropCalls(of: WebSocketConnection, reason: string) {
    for (const [id, pending] of calls) {
      if (pending.link !== of) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      calls.delete(id);
    }
  }

  function receive(payload: Buffer) {
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!isRecord(raw)) return;
    const message = Incoming.parse(raw);
    if (message.type === "state") {
      tabs = message.tabs ?? [];
      active = message.active ?? {};
      changed();
      return;
    }
    if (message.type === "reply" && typeof message.id === "number") {
      const pending = calls.get(message.id);
      if (!pending) return;
      calls.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  }


  function pruneThumbs() {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".jpg"))
        .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const file of files.slice(MAX_THUMBS)) fs.rmSync(path.join(dir, file.name), { force: true });
    } catch {
      // A thumbnail too many is harmless.
    }
  }

  const self: Browser = {
    view: () => ({ available: Boolean(link), tabs, active, focus }),
    generation: () => links,
    attach(next) {
      if (link) {
        next.close();
        return false;
      }
      link = next;
      links += 1;
      next.onMessage((payload) => {
        if (link === next) receive(payload);
      });
      next.onClose(() => {
        dropCalls(next, "The browser link closed. The browser runs in the X Bench app.");
        if (link !== next) return;
        link = null;
        tabs = [];
        active = {};
        changed();
      });
      changed();
      return true;
    },
    call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS) {
      const current = link;
      if (!current) return Promise.reject(new Error("The browser runs in the X Bench app, and the app is not connected to this host."));
      const id = nextCall++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error(`The browser did not answer ${op} in ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
        calls.set(id, { link: current, resolve: (value) => resolve(value as T), reject, timer });
        if (!current.sendText(JSON.stringify({ type: "call", id, op, args }))) {
          clearTimeout(timer);
          calls.delete(id);
          reject(new Error("The browser link is closed."));
        }
      });
    },
    current: (owner) => tabs.find((tab) => tab.owner === owner && tab.id === active[owner]) ?? null,
    focus(owner) {
      focus = { count: focus.count + 1, owner };
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    ...prompts,
    forget(sessionId) {
      prompts.forget(sessionId);
      if (tabs.some((tab) => tab.owner === sessionId)) self.call("closeOwner", { owner: sessionId }).catch(() => {});
    },

    saveThumb(data) {
      try {
        const id = randomBytes(6).toString("hex");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, `${id}.jpg`), Buffer.from(data, "base64"), { mode: 0o600 });
        pruneThumbs();
        return id;
      } catch {
        return null;
      }
    },
    thumbFile(id) {
      if (!THUMB_ID.test(id)) return null;
      const file = path.join(dir, `${id}.jpg`);
      return fs.existsSync(file) ? file : null;
    },
  };
  return self;
}

export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}
