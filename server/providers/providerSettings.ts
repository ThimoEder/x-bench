// Which providers the app runs, which one a new chat starts on, and the approval mode a new
// session of each starts in. ~/.x-bench/providers.json, written by the settings page:
//
// { "defaultProvider": "grok", "providers": { "claude": { "enabled": false, "defaultMode": "auto" } } }
//
// Without the file every provider is on, the first is the default, and each starts in its own
// default mode. What belongs to one harness (Claude's config folder and binary) has its own file.

import { z } from "zod";
import { fields, maybe } from "../../bridge/lenient.ts";
import { MODES, type Mode } from "../../bridge/provider.ts";
import { fileStamp, loadDurable, saveDurable, unreadable } from "../jsonFile.ts";

export interface ProviderPrefs {
  enabled?: boolean;
  defaultMode?: Mode;
}

export interface ProviderSettings {
  defaultProvider?: string;
  providers: Record<string, ProviderPrefs>;
}

const Prefs = fields({ enabled: maybe(z.boolean()), defaultMode: maybe(z.enum(MODES)) });

const SettingsFile = z.object({
  defaultProvider: maybe(z.string()),
  providers: z.record(z.string(), Prefs).catch({}).default({}),
});

function parse(value: unknown): ProviderSettings | null {
  const parsed = SettingsFile.safeParse(value);
  if (!parsed.success) return null;
  const providers: Record<string, ProviderPrefs> = {};
  for (const [id, prefs] of Object.entries(parsed.data.providers)) {
    providers[id] = {
      ...(prefs.enabled === undefined ? {} : { enabled: prefs.enabled }),
      ...(prefs.defaultMode ? { defaultMode: prefs.defaultMode } : {}),
    };
  }
  return { ...(parsed.data.defaultProvider ? { defaultProvider: parsed.data.defaultProvider } : {}), providers };
}

export interface ProviderSettingsStore {
  read(): ProviderSettings;
  // Returns false when the file on disk does not read, and leaves it alone.
  save(settings: ProviderSettings): boolean;
  // True while the file on disk does not read. Nothing changes until it is fixed.
  unreadable(): boolean;
}

// Read on every published snapshot, so the file is parsed again only when it changed. Another
// host on the same home (npm run dev next to the app) sees a change on its next read.
export function createProviderSettings(file: string): ProviderSettingsStore {
  let cached: { stamp: string; value: ProviderSettings } | null = null;
  return {
    read() {
      const stamp = fileStamp(file);
      if (cached?.stamp !== stamp) cached = { stamp, value: loadDurable(file, parse, { providers: {} }) };
      return { ...cached.value, providers: { ...cached.value.providers } };
    },
    save(settings) {
      const saved = saveDurable(file, `${JSON.stringify(settings, null, 2)}\n`, parse);
      cached = null;
      return saved;
    },
    unreadable: () => unreadable(file),
  };
}

// Settings that live in memory only, for tests and a host without a home.
export function memoryProviderSettings(initial: ProviderSettings = { providers: {} }): ProviderSettingsStore {
  let value = initial;
  return {
    read: () => ({ ...value, providers: { ...value.providers } }),
    save(settings) {
      value = settings;
      return true;
    },
    unreadable: () => false,
  };
}
