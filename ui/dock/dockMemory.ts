import { useSyncExternalStore } from "react";
import type { ChangeScope } from "../git/GitChanges.tsx";

// What the review dock showed for each chat, so a chat switched back to shows the dock as it was left.

export const DOCK_CHATS_KEY = "x-bench-dock-chats";
export const DOCK_CHATS_LIMIT = 200;

export type DockTab = "plan" | "changes" | "files" | "terminal" | "browser" | "device" | "unity";

export type PaneEdge = "top" | "bottom" | "left" | "right";

// A second pane on edge of the first. ratio is the top or left pane's share of the dock.
export interface DockSplit {
  tab: DockTab;
  edge: PaneEdge;
  ratio: number;
}

export interface DockPlace {
  open?: boolean;
  tab?: DockTab;
  split?: DockSplit;
  scope?: ChangeScope;
  // The file selected in Changes.
  change?: string;
  // The file open in Files.
  file?: string;
  // The shell shown in Terminal.
  shell?: string;
  // Whether the terminal's panel under the desk is open.
  terminal?: boolean;
  device?: string;
  width?: number;
  // The width before the dock reached across the chat, where it returns when it closes.
  rest?: number;
}

export interface DockMemory {
  get(sessionId: string): DockPlace | undefined;
  // Merges into the chat's place. A field set to undefined is cleared.
  save(sessionId: string, place: DockPlace): void;
  forget(sessionId: string): void;
  subscribe(listener: () => void): () => void;
}

type DockStorage = Pick<Storage, "getItem" | "setItem">;

const TABS: readonly string[] = ["plan", "changes", "files", "terminal", "browser", "device", "unity"];
const SCOPES: readonly string[] = ["head", "main"];
const EDGES: readonly string[] = ["top", "bottom", "left", "right"];
export const PANE_MIN = 0.2;

export function paneRatio(value: number): number {
  return Math.min(1 - PANE_MIN, Math.max(PANE_MIN, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function size(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// Keeps the fields that read right and drops the rest.
export function dockPlaceFrom(raw: unknown): DockPlace | undefined {
  if (!isRecord(raw)) return undefined;
  const place: DockPlace = {};
  if (typeof raw.open === "boolean") place.open = raw.open;
  if (typeof raw.terminal === "boolean") place.terminal = raw.terminal;
  if (typeof raw.tab === "string" && TABS.includes(raw.tab)) place.tab = raw.tab as DockTab;
  const split = raw.split;
  if (isRecord(split) && typeof split.tab === "string" && TABS.includes(split.tab) && typeof split.edge === "string" && EDGES.includes(split.edge)) {
    const ratio = typeof split.ratio === "number" && Number.isFinite(split.ratio) ? paneRatio(split.ratio) : 0.5;
    place.split = { tab: split.tab as DockTab, edge: split.edge as PaneEdge, ratio };
  }
  if (typeof raw.scope === "string" && SCOPES.includes(raw.scope)) place.scope = raw.scope as ChangeScope;
  const change = text(raw.change);
  if (change) place.change = change;
  const file = text(raw.file);
  if (file) place.file = file;
  const shell = text(raw.shell);
  if (shell) place.shell = shell;
  const device = text(raw.device);
  if (device) place.device = device;
  const width = size(raw.width);
  if (width) place.width = width;
  const rest = size(raw.rest);
  if (rest) place.rest = rest;
  return place;
}

function pruned(place: DockPlace): DockPlace {
  const out: DockPlace = {};
  for (const [key, value] of Object.entries(place)) {
    if (value !== undefined && value !== "") Object.assign(out, { [key]: value });
  }
  return out;
}

function defaultStorage(): DockStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Places are kept oldest first, and the oldest go once there are more than limit.
export function dockMemory(storage?: DockStorage | null, limit = DOCK_CHATS_LIMIT): DockMemory {
  let places: Map<string, DockPlace> | null = null;
  const listeners = new Set<() => void>();

  function store(): DockStorage | null {
    return storage === undefined ? defaultStorage() : storage;
  }

  function load(): Map<string, DockPlace> {
    if (places) return places;
    places = new Map();
    try {
      const raw: unknown = JSON.parse(store()?.getItem(DOCK_CHATS_KEY) || "[]");
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0]) continue;
          const place = dockPlaceFrom(row[1]);
          if (place) places.set(row[0], place);
        }
      }
    } catch {
      // An unreadable entry starts every chat fresh.
    }
    return places;
  }

  function write(map: Map<string, DockPlace>) {
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    try {
      store()?.setItem(DOCK_CHATS_KEY, JSON.stringify([...map]));
    } catch {
      // The places still hold for this visit.
    }
    for (const listener of listeners) listener();
  }

  return {
    get(sessionId) {
      return sessionId ? load().get(sessionId) : undefined;
    },
    save(sessionId, place) {
      if (!sessionId) return;
      const map = load();
      const current = map.get(sessionId);
      const next = pruned({ ...current, ...place });
      if (current && JSON.stringify(current) === JSON.stringify(next)) return;
      map.delete(sessionId);
      map.set(sessionId, next);
      write(map);
    },
    forget(sessionId) {
      const map = load();
      if (!map.delete(sessionId)) return;
      write(map);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// The page's places, in localStorage.
export const dockPlaces = dockMemory();

// Reads one field, so a write to another field, such as the width on every frame of a drag, re-renders nothing.
export function useDockPlace<K extends keyof DockPlace>(sessionId: string | null | undefined, field: K): DockPlace[K] {
  return useSyncExternalStore(dockPlaces.subscribe, () => (sessionId ? dockPlaces.get(sessionId)?.[field] : undefined));
}
