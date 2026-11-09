import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fields, isRecord, maybe } from "../../../bridge/lenient.ts";
import { openSecret, sealSecret } from "../../secrets/secrets.ts";
import { responseJson, type BoardCallOptions, type BoardFetchResponse } from "../boardAdapter.ts";

const pageSize = 200;
const pageCap = 10;

// The address and token in ~/.x-bench/sak.json.
export interface SakConnection {
  baseUrl: string;
  token: string;
  enabled: boolean;
  // Absolute path of the SQLite file. Empty when the connection file does not name one.
  // The host starts SAK against this file; it is never copied into the bundle.
  database: string;
  // Absolute path of a built SAK website for the started SAK to serve, set by hand. Empty when the file names none.
  website: string;
}

// What the page learns about the connection. It never holds the token.
// version is forwarded as SAK sent it.
export interface SakStatus {
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  version: unknown;
  baseUrl: string;
}

export interface SakFetchOptions extends BoardCallOptions {
  match?: unknown;
  range?: string;
}

// A call to the stored SAK connection. Bodies come back as SAK sent them.
export type SakRequest = (method: string, sakPath: string, payload?: unknown, extra?: SakFetchOptions) => Promise<unknown>;

export type SakError = Error & { status: number; code: unknown };

// ~/.x-bench/sak.json. The values are checked where they are read.
const StoredConnection = fields({
  baseUrl: z.unknown().optional(),
  token: z.unknown().optional(),
  enabled: z.unknown().optional(),
  database: z.unknown().optional(),
  website: z.unknown().optional(),
});

// SAK's bodies. Only these fields are read here.
const SakFailureBody = fields({ error: maybe(z.string()) });

const SakHealth = fields({ version: z.unknown().optional() });

const SakTaskPage = fields({
  total: z.unknown().optional(),
  items: z.unknown().optional(),
});

export function loopbackBase(value: unknown): string | null {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (parsed.protocol !== "http:") return null;
  if (host !== "127.0.0.1" && host !== "localhost") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (!/^\d+$/.test(parsed.port)) return null;
  return `http://${host}:${parsed.port}`;
}

export function readConnection(file: string): SakConnection {
  const empty = { baseUrl: "http://127.0.0.1:4345", token: "", enabled: false, database: "", website: "" };
  if (!existsSync(file)) return empty;
  try {
    const raw = StoredConnection.parse(JSON.parse(readFileSync(file, "utf8")));
    const baseUrl = loopbackBase(raw.baseUrl) || empty.baseUrl;
    const token = openSecret(raw.token).trim();
    // A saved token from before the setup screen stays on.
    const enabled = raw.enabled === false ? false : Boolean(token);
    return { baseUrl, token, enabled, database: storedPath(raw.database), website: storedPath(raw.website) };
  } catch {
    return empty;
  }
}

export function writeConnection(
  connection: { baseUrl?: unknown; token?: unknown; enabled?: unknown; database?: unknown; website?: unknown } | null | undefined,
  file: string,
): SakConnection {
  const baseUrl = loopbackBase(connection?.baseUrl);
  if (!baseUrl) {
    throw sakError(400, "The local board must be on this machine");
  }
  const token = String(connection?.token || "").trim();
  if (!token || /[\r\n]/.test(token)) throw sakError(400, "Add a token for the local board");
  const enabled = connection?.enabled === false ? false : true;
  const database = databasePath(connection?.database);
  const website = storedPath(connection?.website);
  const stored = { baseUrl, token: sealSecret(token), enabled, ...(database && { database }), ...(website && { website }) };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { baseUrl, token, enabled, database, website };
}

// What the setup screen sends. A missing address or token keeps the saved one.
export function saveConnection(
  body: { baseUrl?: unknown; token?: unknown; enabled?: unknown; database?: unknown },
  file: string,
): void {
  const current = readConnection(file);
  const baseUrl = body.baseUrl ? loopbackBase(body.baseUrl) : current.baseUrl;
  if (!baseUrl) throw sakError(400, "The local board must be on this machine");
  const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : current.token;
  if (!token) throw sakError(400, "Add a token for the local board");
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  // Setup does not send the database path. A save must not drop the file SAK is started with.
  const database = body.database !== undefined ? databasePath(body.database) : current.database;
  writeConnection({ baseUrl, token, enabled, database, website: current.website }, file);
}

export function sakFetch(connection: SakConnection, method: string, sakPath: string, body?: unknown, options: SakFetchOptions = {}): Promise<unknown> {
  return sakCall(connection, method, sakPath, body, options, responseJson);
}

export async function sakCall<T>(
  connection: SakConnection,
  method: string,
  sakPath: string,
  body: unknown,
  { timeoutMs = 5000, match, range, fetchImpl = fetch }: SakFetchOptions,
  read: (response: BoardFetchResponse) => Promise<T>,
): Promise<T> {
  const base = loopbackBase(connection.baseUrl);
  if (!base) throw sakError(400, "The local board must be on this machine");
  if (!connection.token) throw sakError(400, "Add a token for the local board");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${connection.token}`, Accept: "application/json" };
    const file = body instanceof Blob;
    // SAK reads a file's type from its leading bytes, so an upload names none.
    if (body !== undefined && !file) headers["Content-Type"] = "application/json";
    if (match !== undefined && match !== null) headers["If-Match"] = String(match);
    if (range) headers.Range = range;
    const response = await fetchImpl(`${base}${sakPath}`, {
      method,
      headers,
      body: body === undefined || file ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = SakFailureBody.parse(await responseJson(response)).error ?? null;
      throw sakError(response.status, safeSakMessage(response.status, code), code);
    }
    return await read(response);
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") throw sakError(504, "The local board did not answer");
    if (isRecord(error) && error.status) throw error;
    throw sakError(502, "The local board is not reachable");
  } finally {
    clearTimeout(timer);
  }
}

const refusals = new Map([
  ["unsupported_media_type", "The local board takes PNG, JPEG, GIF and WebP pictures and MP4, QuickTime and WebM clips"],
  ["too_large", "The local board takes pictures up to 20 MiB and clips up to 100 MiB"],
  ["relation_exists", "These tickets already have that relation"],
  ["parent_exists", "This ticket already has a parent"],
  ["cycle", "That would make a loop"],
]);

function safeSakMessage(status: number, code: string | null): string {
  if (code === "unauthorized" || status === 401) return "The local board refused its token";
  const refusal = code ? refusals.get(code) : undefined;
  if (refusal) return refusal;
  if (status === 409) return "Someone else edited this ticket";
  if (status === 504) return "The local board did not answer";
  if (status === 502) return "The local board is not reachable";
  return code && !code.includes("_") ? code : "The local board refused the request";
}

export function enabledConnection(file: string): SakConnection {
  const stored = readConnection(file);
  if (!stored.enabled) throw sakError(400, "Enable the local board in Setup");
  return stored;
}

// Calls to the connection saved in file, read again on every call.
export function sakRequest(file: string, fetchOptions?: BoardCallOptions): SakRequest {
  return (verb, sakPath, payload, extra) => sakFetch(enabledConnection(file), verb, sakPath, payload, { ...fetchOptions, ...extra });
}

export async function sakStatus(connection: SakConnection, options?: SakFetchOptions): Promise<SakStatus> {
  const baseUrl = loopbackBase(connection.baseUrl) || "http://127.0.0.1:4345";
  const configured = Boolean(connection.token && loopbackBase(connection.baseUrl));
  const enabled = Boolean(configured && connection.enabled);
  if (!configured || !enabled) return { configured, enabled: false, reachable: false, version: null, baseUrl };
  try {
    const health = SakHealth.parse(await sakFetch(connection, "GET", "/api/health", undefined, options));
    return { configured: true, enabled: true, reachable: true, version: health.version || null, baseUrl };
  } catch {
    return { configured: true, enabled: true, reachable: false, version: null, baseUrl };
  }
}

export async function listAllTasks(
  request: SakRequest,
  projectId: number,
  search: string,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  let total = 0;
  for (let page = 1; page <= pageCap; page += 1) {
    const query = new URLSearchParams({ sort: "id", per_page: String(pageSize), page: String(page) });
    if (search) query.set("search", search);
    const body = SakTaskPage.parse(await request("GET", `/api/projects/${projectId}/tasks?${query}`));
    total = Number(body.total) || 0;
    items.push(...spreadItems(body.items));
    if (items.length >= total) return { items, truncated: false };
  }
  return { items, truncated: items.length < total };
}

export function sakError(status: number, message: string, code: unknown = null): SakError {
  return Object.assign(new Error(message), { status, code });
}

// An absolute path, or "" when the connection does not name one. A non-empty relative path is refused.
function databasePath(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (!path.isAbsolute(text) || text.includes("\0") || /[\r\n]/.test(text)) {
    throw sakError(400, "The local board's database must be a file on this machine");
  }
  return text;
}

// A path already stored. A value this build would refuse is ignored, so one bad field does not
// hide the token.
function storedPath(value: unknown): string {
  try {
    return databasePath(value);
  } catch {
    return "";
  }
}

// A list's items, or a string's characters, as spreading them always gave. Anything else reads as empty.
export function spreadItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  return [];
}
