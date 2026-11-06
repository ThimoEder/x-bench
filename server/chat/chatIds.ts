// A chat switched to another provider keeps its app id while it runs on another harness session. The registry
// hands the host each provider wrapped in this view: ids going in are the chat's, turned into the harness's,
// and every session, mark and catalog entry coming out carries the chat's id again.

import type { CatalogEntry } from "../../bridge/protocol.ts";
import type { Provider } from "../../bridge/provider.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import type { ChatRecords } from "./chatRecords.ts";
import type { SessionIndexStore } from "./sessionIndex.ts";

export interface ChatIds {
  toHarness(appId: string): string;
  toApp(harnessId: string): string;
  // Every harness session the chat ran on, the one it runs on now first.
  harnesses(appId: string): string[];
}

// A harness session a chat runs on now is found in the index, one it ran on before in the chat records.
export function chatIds(index: SessionIndexStore, records: ChatRecords): ChatIds {
  return {
    toHarness: (appId) => index.get(appId)?.harnessId || appId,
    toApp: (harnessId) => {
      const live = index.chatOf(harnessId);
      if (live && live.id !== harnessId) return live.id;
      return records.chatOf(harnessId) || harnessId;
    },
    harnesses(appId) {
      const earlier = (records.get(appId)?.stretches ?? []).map((stretch) => stretch.harnessId).reverse();
      return [...new Set([index.get(appId)?.harnessId || appId, ...earlier])];
    },
  };
}

function isSession(value: unknown): value is SessionState {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" && Array.isArray((value as { transcript?: unknown }).transcript);
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  return typeof value === "object" && value !== null && typeof (value as { sessionId?: unknown }).sessionId === "string";
}

// A provider whose session ids are the chats' ids. Methods of the Provider contract take the session id first,
// so a first argument that names a chat is turned into its harness id.
export function chatView<P extends Provider>(provider: P, ids: ChatIds): P {
  function out(value: unknown): unknown {
    if (isSession(value)) {
      const id = ids.toApp(value.id);
      return id === value.id ? value : { ...value, id };
    }
    if (isCatalogEntry(value)) {
      const sessionId = ids.toApp(value.sessionId!);
      return sessionId === value.sessionId ? value : { ...value, sessionId };
    }
    if (Array.isArray(value) && value.some((item) => isSession(item) || isCatalogEntry(item))) return value.map(out);
    return value;
  }

  function call(method: (...args: unknown[]) => unknown, args: unknown[]) {
    const first = args[0];
    const inArgs = typeof first === "string" ? [ids.toHarness(first), ...args.slice(1)] : args;
    const result = method.apply(provider, inArgs);
    return result instanceof Promise ? result.then(out) : out(result);
  }

  const special: Record<string, unknown> = {
    onSession: (listener: (session: SessionState) => void) => provider.onSession((session) => listener(out(session) as SessionState)),
    onCatalog: (listener: (entry: CatalogEntry) => void) => provider.onCatalog((entry) => listener(out(entry) as CatalogEntry)),
    activityMarks: () => {
      const marks = provider.activityMarks();
      return { working: marks.working.map(ids.toApp), attention: marks.attention.map(ids.toApp) };
    },
  };

  return new Proxy(provider, {
    get(target, prop) {
      if (typeof prop === "string" && prop in special) return special[prop];
      if (prop === "openTurns") {
        const openTurns = target.openTurns;
        return openTurns && (() => openTurns.call(target).map(ids.toApp));
      }
      if (prop === "catalog") {
        const catalog = target.catalog;
        const mapped = new Map<string, CatalogEntry>();
        for (const [id, entry] of catalog) mapped.set(ids.toApp(id), out(entry) as CatalogEntry);
        return mapped;
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => call(value as (...args: unknown[]) => unknown, args);
    },
  });
}
