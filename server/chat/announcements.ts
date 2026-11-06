import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fields, maybe } from "../../bridge/lenient.ts";
import type { ServiceNotice } from "../snapshot.ts";

// settings_cache.json. Its payload may itself be a JSON string.
const SettingsCache = fields({ payload: z.unknown().optional() });
const SettingsPayload = fields({ settings: z.unknown().optional() });
const Settings = fields({ announcements: maybe(z.array(z.unknown())) });

const AnnouncementInput = fields({
  id: z.unknown().optional(),
  severity: z.unknown().optional(),
  title: z.unknown().optional(),
  message: z.unknown().optional(),
  expires_at: z.unknown().optional(),
  cta: maybe(z.looseObject({ url: z.unknown().optional(), label: z.unknown().optional() })),
});

type Severity = ServiceNotice["severity"];

const serviceSeverities = new Set<string>(["critical", "warning", "error"] satisfies Severity[]);

export function settingsCachePath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const root = env.GROK_HOME || path.join(home, ".grok");
  return path.join(root, "settings_cache.json");
}

export function presentAnnouncements(payload: unknown, now = Date.now()): ServiceNotice[] {
  const wrapped = SettingsPayload.parse(payload).settings;
  const settings = wrapped && typeof wrapped === "object" ? wrapped : payload;
  const list = Settings.parse(settings).announcements ?? [];
  const notices: ServiceNotice[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = AnnouncementInput.parse(raw);
    const severity = String(item.severity || "").toLowerCase();
    if (!isSeverity(severity)) continue;
    if (expired(item.expires_at, now)) continue;
    const title = text(item.title);
    const message = text(item.message);
    if (!title && !message) continue;
    const url = httpUrl(item.cta?.url);
    notices.push({
      id: text(item.id) || title || message,
      severity,
      title: title || message,
      message: title ? message : "",
      url,
      link: url ? text(item.cta?.label) || "Status" : "",
    });
  }
  return notices;
}

export function readServiceNotices(file = settingsCachePath(), now = Date.now()): ServiceNotice[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const inner = SettingsCache.parse(raw).payload;
    const payload: unknown = typeof inner === "string" ? JSON.parse(inner) : raw;
    return presentAnnouncements(payload, now);
  } catch {
    return [];
  }
}

function isSeverity(value: string): value is Severity {
  return serviceSeverities.has(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function httpUrl(value: unknown): string {
  const url = text(value);
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function expired(value: unknown, now: number): boolean {
  if (value == null || value === "") return false;
  const time = Date.parse(String(value));
  return Number.isFinite(time) && time <= now;
}
