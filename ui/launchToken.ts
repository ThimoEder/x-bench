// The launch token the host writes into index.html (server/launchToken.ts). The host refuses any /api request
// without it: fetch sends it in the X-Bench-Token header, and what cannot send headers
// (EventSource, <img>, <video>, the device and terminal WebSockets) sends it in ?token=.

const TOKEN_HEADER = "X-Bench-Token";

export function launchToken(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="x-bench-token"]')?.getAttribute("content") || "";
}

// True on a page opened through remote access, which has no launch token and hides what only works on the Mac.
export function remotePage(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('meta[name="x-bench-remote"]'));
}

// A background poll passes quiet, so it does not clear an error the banner is showing.
export interface CallOptions {
  quiet?: boolean;
  // Leaves the error banner alone, for calls whose failure the caller shows itself. The thrown
  // error carries the host's reply as reply and the HTTP status as status.
  silent?: boolean;
}

export type ApiCall = (path: string, body: Record<string, unknown>, method?: string, options?: CallOptions) => Promise<unknown>;

// fetch with the launch token.
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = launchToken();
  if (token) headers.set(TOKEN_HEADER, token);
  return fetch(path, { ...init, headers });
}

// An /api URL with the launch token, for a GET that cannot send a header.
export function withToken(url: string): string {
  const token = launchToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
