// settings.json: { "keepAwake": false, "planTool": false }. Settings of the app itself that the host acts on, shared by every host on
// the same home. The page's own preferences stay in its localStorage.

import path from "node:path";
import { z } from "zod";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";

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
  let cached: { stamp: string; value: AppSettings } | null = null;
  let seenStamp = fileStamp(file);

  function read(): AppSettings {
    const stamp = fileStamp(file);
    if (cached?.stamp !== stamp) cached = { stamp, value: loadDurable(file, parse, DEFAULTS) };
    return { ...cached.value };
  }

  return {
    read,
    save(change) {
      const next = { ...read(), ...change };
      const saved = saveDurable(file, `${JSON.stringify(next, null, 2)}\n`, parse);
      cached = null;
      if (!saved) throw new Error(`${path.basename(file)} does not read. Fix or remove it to change settings.`);
      seenStamp = fileStamp(file);
      return next;
    },
    changedOnDisk() {
      const stamp = fileStamp(file);
      if (stamp === seenStamp) return false;
      seenStamp = stamp;
      return true;
    },
  };
}
