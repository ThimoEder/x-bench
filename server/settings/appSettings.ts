// settings.json: { "keepAwake": false, "planTool": false }. Settings of the app itself that the host acts on, shared by every host on
// the same home. The page's own preferences stay in its localStorage.

import { z } from "zod";
import { watchedJson } from "../jsonFile.ts";

export interface AppSettings {
  keepAwake: boolean;
  // Experimental: agents keep a step list with the host's update_plan tool.
  planTool: boolean;
}

const DEFAULTS: AppSettings = { keepAwake: false, planTool: false };

const SettingsFile = z.object({
  keepAwake: z.boolean().catch(DEFAULTS.keepAwake).default(DEFAULTS.keepAwake),
  planTool: z.boolean().catch(DEFAULTS.planTool).default(DEFAULTS.planTool),
});

function parse(value: unknown): AppSettings | null {
  const parsed = SettingsFile.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface AppSettingsStore {
  read(): AppSettings;
  save(change: Partial<AppSettings>): AppSettings;
  // True when another host changed the file since the last call.
  changedOnDisk(): boolean;
}

export function createAppSettings(file: string): AppSettingsStore {
  const json = watchedJson(file, parse, DEFAULTS, "change settings");
  const read = (): AppSettings => ({ ...json.read() });

  return {
    read,
    save(change) {
      const next = { ...read(), ...change };
      json.write(next);
      return next;
    },
    changedOnDisk: json.changedOnDisk,
  };
}
