// The providers the host can run sessions on, and which one holds each session.
// The host calls this registry, never a harness directly. The settings page turns providers
// on and off, picks the one a new chat starts on, and each one's default approval mode.

import type { CatalogEntry } from "../../bridge/protocol.ts";
import type { Mode, Provider, ProviderStatus } from "../../bridge/provider.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import { memoryProviderSettings, type ProviderSettingsStore } from "./providerSettings.ts";
import type { SessionIndexStore } from "../chat/sessionIndex.ts";
import { chatIds, chatView, type ChatIds } from "../chat/chatIds.ts";
import { memoryChatRecords, type ChatRecords } from "../chat/chatRecords.ts";

export interface ProviderEntry extends CatalogEntry {
  provider: string;
}

export interface Providers {
  // Every provider, on or off.
  list(): Provider[];
  get(id: string | null | undefined): Provider | null;
  // The provider without its chat view, for a session addressed by its harness id: one a chat ran on before.
  harness(id: string | null | undefined): Provider | null;
  // A provider that is off never starts, and its models are not offered.
  isEnabled(provider: Provider): boolean;
  enabled(): Provider[];
  // The provider a new chat starts on unless the model menu picks another: the chosen one while
  // it is on, else the first provider that is on. With none on, the first provider, which refuses.
  defaultProvider(): Provider;
  // The approval mode a new session of this provider starts in.
  defaultMode(provider: Provider): Mode;
  settings: ProviderSettingsStore;
  forSession(sessionId: string): Provider;
  getSession(sessionId: string): SessionState | null;
  sessions(): SessionState[];
  activityMarks(): { working: string[]; attention: string[] };
  ownsTurn(sessionId: string): boolean;
  // Titles and folders every provider reported, tagged with the provider.
  catalog(): ProviderEntry[];
  catalogTitle(sessionId: string): string | null;
  index: SessionIndexStore;
  // What switched chats keep besides the session they run on now.
  records: ChatRecords;
  ids: ChatIds;
  // Notes the session and its provider in the index.
  remember(session: SessionState, provider: Provider, title?: string): void;
  onSession(listener: (session: SessionState, provider: Provider) => void): void;
  onStatus(listener: (status: ProviderStatus, provider: Provider) => void): void;
  onCatalog(listener: (entry: CatalogEntry, provider: Provider) => void): void;
  onUsageChange(listener: (provider: Provider) => void): void;
  stopAll(): Promise<void>;
}

// Every provider is handed out in its chat view, where a session's id is its chat's.
export function createProviders(
  harnesses: Provider[],
  index: SessionIndexStore,
  settings: ProviderSettingsStore = memoryProviderSettings(),
  records: ChatRecords = memoryChatRecords(),
): Providers {
  const ids = chatIds(index, records);
  const list = harnesses.map((provider) => chatView(provider, ids));
  const first = list[0];
  if (!first) throw new Error("the host needs at least one provider");
  const byId = new Map(list.map((provider) => [provider.id, provider]));
  const rawById = new Map(harnesses.map((provider) => [provider.id, provider]));

  function isEnabled(provider: Provider) {
    return settings.read().providers[provider.id]?.enabled !== false;
  }

  function holder(sessionId: string): Provider | null {
    return list.find((provider) => provider.getSession(sessionId)) ?? null;
  }

  const defaultProvider = (): Provider => {
    const chosen = byId.get(settings.read().defaultProvider ?? "");
    if (chosen && isEnabled(chosen)) return chosen;
    return list.find(isEnabled) ?? first;
  };

  // A session the index does not know is still in the catalog of the harness that keeps it, under its harness id.
  function cataloged(sessionId: string): Provider | null {
    const keeper = harnesses.find((provider) => provider.catalog.has(sessionId));
    return keeper ? (byId.get(keeper.id) ?? null) : null;
  }

  const registry: Providers = {
    list: () => [...list],
    get: (id) => (id ? (byId.get(id) ?? null) : null),
    harness: (id) => (id ? (rawById.get(id) ?? null) : null),
    isEnabled,
    enabled: () => list.filter(isEnabled),
    defaultProvider,
    defaultMode(provider) {
      const chosen = settings.read().providers[provider.id]?.defaultMode;
      return chosen && provider.modes.some((mode) => mode.id === chosen) ? chosen : provider.defaultMode;
    },
    settings,
    forSession(sessionId) {
      return holder(sessionId) ?? byId.get(index.get(sessionId)?.provider ?? "") ?? cataloged(sessionId) ?? defaultProvider();
    },
    getSession(sessionId) {
      return holder(sessionId)?.getSession(sessionId) ?? null;
    },
    sessions: () => list.flatMap((provider) => provider.sessions()),
    activityMarks() {
      const working: string[] = [];
      const attention: string[] = [];
      for (const provider of list) {
        const marks = provider.activityMarks();
        working.push(...marks.working);
        attention.push(...marks.attention);
      }
      return { working, attention };
    },
    ownsTurn: (sessionId) => list.some((provider) => provider.ownsTurn(sessionId)),
    catalog: () => list.flatMap((provider) => [...provider.catalog.values()].map((entry) => ({ ...entry, provider: provider.id }))),
    catalogTitle(sessionId) {
      const row = index.get(sessionId);
      if (records.get(sessionId) && row?.title) return row.title;
      // The harnesses' own catalogs, read by harness id: the chat view would rebuild a whole catalog per read.
      const harnessId = row?.harnessId || sessionId;
      for (const provider of harnesses) {
        const title = provider.catalog.get(harnessId)?.title;
        if (title) return title;
      }
      return row?.title || null;
    },
    index,
    records,
    ids,
    remember(session, provider, title) {
      // Only a switch moves a switched chat. Another window still holding its old session must not move it back.
      const row = records.get(session.id) ? index.get(session.id) : null;
      try {
        index.record({
          id: session.id,
          provider: row?.provider ?? provider.id,
          harnessId: row?.harnessId ?? ids.toHarness(session.id),
          cwd: session.cwd,
          updatedAt: new Date().toISOString(),
          ...(title ? { title } : {}),
        });
      } catch {
        // The session still runs if the index cannot be written. forSession then falls back to the catalogs and the default.
      }
    },
    onSession(listener) {
      for (const provider of list) provider.onSession((session) => listener(session, provider));
    },
    onStatus(listener) {
      for (const provider of list) provider.onStatus((status) => listener(status, provider));
    },
    onCatalog(listener) {
      for (const provider of list) provider.onCatalog((entry) => listener(entry, provider));
    },
    onUsageChange(listener) {
      for (const provider of list) provider.onUsageChange?.(() => listener(provider));
    },
    async stopAll() {
      await Promise.all(list.map((provider) => (provider.status === "idle" ? undefined : provider.stop().catch(() => {}))));
    },
  };
  return registry;
}
