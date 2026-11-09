// board-settings.json, next to tickets.json: each bound folder's board settings.

import path from "node:path";
import { z } from "zod";
import { fields, isRecord, maybe } from "../../bridge/lenient.ts";
import { loadDurable, saveDurable } from "../jsonFile.ts";
import { MOVE_KEYS, NO_SETTINGS, type BoardSettings, type ColumnSettings } from "./boardSettings.ts";
import { clip, stripHidden } from "./boardText.ts";

type Stored = Record<string, BoardSettings>;

const MAX_COLUMNS = 100;

const StoredSettings = fields({
  columns: maybe(z.record(z.string(), z.unknown())),
  order: maybe(z.array(z.unknown())),
  moves: maybe(z.record(z.string(), z.unknown())),
});

const StoredColumn = fields({ hidden: maybe(z.boolean()), collapsed: maybe(z.boolean()), color: maybe(z.string()) });

const StoredMove = fields({ status: maybe(z.string()), title: maybe(z.string()) });

export function settingsFile(ticketsFile: string): string {
  return path.join(path.dirname(ticketsFile), "board-settings.json");
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeSettings(input: unknown): BoardSettings {
  const stored = StoredSettings.parse(input);
  const columns: Record<string, ColumnSettings> = {};
  for (const [status, value] of Object.entries(stored.columns ?? {}).slice(0, MAX_COLUMNS)) {
    const item = StoredColumn.parse(value);
    const color = text(item.color, 20).toLowerCase();
    const column: ColumnSettings = {
      ...(item.hidden ? { hidden: true } : {}),
      ...(item.collapsed ? { collapsed: true } : {}),
      ...(/^[a-z]+$/.test(color) ? { color } : {}),
    };
    if (status.length <= 200 && Object.keys(column).length) columns[status] = column;
  }
  const order = (stored.order ?? []).filter((status): status is string => typeof status === "string" && status.length <= 200);
  const moves: BoardSettings["moves"] = {};
  for (const key of MOVE_KEYS) {
    const value = stored.moves?.[key];
    if (value === null) moves[key] = null;
    if (!isRecord(value)) continue;
    // Both reach the agent rules, so they are one line without hidden characters.
    const move = StoredMove.parse(value);
    const status = clip(stripHidden(move.status ?? ""), 200);
    if (status) moves[key] = { status, title: clip(stripHidden(move.title ?? ""), 80) || status };
  }
  return { columns, order: [...new Set(order)].slice(0, MAX_COLUMNS), moves };
}

function parseStored(value: unknown): Stored | null {
  if (!isRecord(value)) return null;
  const boards: Stored = {};
  for (const [folder, settings] of Object.entries(isRecord(value.boards) ? value.boards : {})) boards[folder] = normalizeSettings(settings);
  return boards;
}

function readStored(file: string): Stored {
  return loadDurable(file, parseStored, {});
}

// folder is the canonical folder whose binding names the board.
export function readSettings(ticketsFile: string, folder: string): BoardSettings {
  return readStored(settingsFile(ticketsFile))[folder] ?? NO_SETTINGS;
}

// null drops the folder's settings.
export function saveSettings(ticketsFile: string, folder: string, input: unknown): BoardSettings {
  const file = settingsFile(ticketsFile);
  const boards = { ...readStored(file) };
  if (input === null && !boards[folder]) return NO_SETTINGS;
  if (input === null) delete boards[folder];
  else boards[folder] = normalizeSettings(input);
  saveDurable(file, `${JSON.stringify({ boards }, null, 2)}\n`, parseStored);
  return readSettings(ticketsFile, folder);
}
