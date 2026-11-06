// The ngrok tunnel for remote access, and its settings in ~/.x-bench/remote.json (mode 0600):
//
// { "authtoken": "…", "domain": "name.ngrok-free.app", "enabledPorts": [8797], "localPorts": [8797] }
//
// localPorts switches on the local network's tunnel (localTunnel.ts), which needs no authtoken.
// The switches are kept per port: each host starts a tunnel only when it was switched on there. ngrok refuses a
// second host on the same domain while the first holds it.

import fs from "node:fs";
import path from "node:path";
import { messageOf } from "../http.ts";
import { openSecret, sealSecret } from "../secrets/secrets.ts";

export type RemoteKind = "ngrok" | "local";

export interface RemoteSettings {
  authtoken: string;
  domain: string;
  enabledPorts: number[];
  localPorts: number[];
}

export interface RemoteSettingsStore {
  read(): RemoteSettings;
  save(change: Partial<RemoteSettings>): RemoteSettings;
}

export function createRemoteSettings(file: string): RemoteSettingsStore {
  return {
    read: () => readSettings(file),
    save(change) {
      const next = { ...readSettings(file), ...change };
      // A token sealed under a key this host lacks reads as "", so a save that does not set one keeps it as stored.
      const kept = readStored(file).authtoken;
      const authtoken = change.authtoken === undefined && typeof kept === "string" ? kept : sealSecret(next.authtoken);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ ...next, authtoken }, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
      return next;
    },
  };
}

// "https://name.ngrok-free.app/" and "name.ngrok-free.app" are the same domain.
export function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function readSettings(file: string): RemoteSettings {
  const item = readStored(file);
  return {
    authtoken: openSecret(item.authtoken),
    domain: typeof item.domain === "string" ? cleanDomain(item.domain) : "",
    enabledPorts: ports(item.enabledPorts),
    localPorts: ports(item.localPorts),
  };
}

function readStored(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function ports(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((port): port is number => Number.isInteger(port)) : [];
}

export interface TunnelStatus {
  state: "off" | "starting" | "on" | "failed";
  url: string;
  error: string;
}

export interface Listener {
  url(): string | null;
  close(): Promise<void>;
}

export interface ForwardConfig {
  addr: string;
  authtoken: string;
  domain?: string;
  // "closed" when the session to ngrok is lost, "connected" when it is back.
  onStatusChange?: (status: string) => void;
}

export type Forward = (config: ForwardConfig) => Promise<Listener>;

export interface Tunnel {
  start(addr: string, authtoken: string, domain: string): Promise<TunnelStatus>;
  stop(): Promise<void>;
  status(): TunnelStatus;
  // The public host name while the tunnel is up, for example name.ngrok-free.app.
  host(): string;
  // Calls listener after every status change. Returns the unsubscribe.
  onChange(listener: () => void): () => void;
}

// A lost session that has not come back after reconnectMs starts over, since ngrok can leave the endpoint
// offline while the SDK keeps waiting. A start that fails tries again after retryMs, doubling up to retryMaxMs,
// unless ngrok refused the authtoken. A listener's close is given up after closeMs, because a dead session never
// answers it.
export function createTunnel(
  forward: Forward = ngrokForward,
  { reconnectMs = 20_000, closeMs = 3000, retryMs = 20_000, retryMaxMs = 5 * 60_000 } = {},
): Tunnel {
  let status: TunnelStatus = { state: "off", url: "", error: "" };
  let listener: Listener | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  // Each start or stop takes a new run before it waits on anything, so only the latest one acts.
  let run = 0;

  function set(next: TunnelStatus) {
    status = next;
    for (const notify of listeners) notify();
  }

  function later(ms: number, mine: number, again: () => Promise<TunnelStatus>) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (mine === run) void again();
    }, ms);
    timer.unref?.();
  }

  async function stop() {
    run += 1;
    clearTimeout(timer);
    const open = listener;
    listener = null;
    set({ state: "off", url: "", error: "" });
    if (open) await closeWithin(open, closeMs);
  }

  async function open(addr: string, authtoken: string, domain: string, attempt: number): Promise<TunnelStatus> {
    run += 1;
    const mine = run;
    clearTimeout(timer);
    const previous = listener;
    listener = null;
    set({ state: "starting", url: "", error: "" });
    if (previous) await closeWithin(previous, closeMs);
    if (mine !== run) return status;
    const onStatusChange = (change: string) => {
      if (mine !== run) return;
      if (change === "closed") {
        set({ state: "starting", url: status.url, error: "Reconnecting to ngrok…" });
        later(reconnectMs, mine, () => open(addr, authtoken, domain, 0));
      } else if (change === "connected" && listener) {
        clearTimeout(timer);
        set({ state: "on", url: listener.url() || status.url, error: "" });
      }
    };
    try {
      const opened = await forward({ addr, authtoken, ...(domain ? { domain } : {}), onStatusChange });
      if (mine !== run) {
        await closeWithin(opened, closeMs);
        return status;
      }
      listener = opened;
      set({ state: "on", url: opened.url() || "", error: "" });
    } catch (error) {
      if (mine !== run) return status;
      set({ state: "failed", url: "", error: failure(error, authtoken) });
      if (!/authtoken|authentication/i.test(messageOf(error))) later(Math.min(retryMs * 2 ** attempt, retryMaxMs), mine, () => open(addr, authtoken, domain, attempt + 1));
    }
    return status;
  }

  function start(addr: string, authtoken: string, domain: string): Promise<TunnelStatus> {
    return open(addr, authtoken, domain, 0);
  }

  return {
    start,
    stop,
    status: () => status,
    onChange(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    host() {
      if (status.state !== "on" || !status.url) return "";
      try {
        return new URL(status.url).host.toLowerCase();
      } catch {
        return "";
      }
    },
  };
}

function closeWithin(listener: Listener, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    listener.close().catch(() => {}).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ngrok's errors repeat the authtoken and add install instructions on later lines.
function failure(error: unknown, authtoken: string): string {
  const line = (messageOf(error).split("\n")[0] ?? "").trim();
  return (authtoken ? line.split(authtoken).join("…") : line) || "ngrok did not start";
}

// The SDK loads native code, so it is imported only when the tunnel starts.
async function ngrokForward(config: ForwardConfig): Promise<Listener> {
  const ngrok = await import("@ngrok/ngrok");
  return ngrok.forward(config);
}
