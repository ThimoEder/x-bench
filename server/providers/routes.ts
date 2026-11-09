// Provider settings: what the settings page shows about each provider, and saving its choices.
// Turning a provider off stops its agent. Its open chats stay, and cannot send until it is on
// again. Pointing Claude at another config folder or binary closes its chats, which that
// account cannot load, and stops Claude, so the next chat starts it with the new settings.
// Login stays in each harness: the page says how to sign in, and never takes a token.

import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { commandVersion, isExecutable } from "../../bridge/command.ts";
import { isMode, type Detected, type Mode, type ModeChoice, type Provider, type ProviderStatus } from "../../bridge/provider.ts";
import { claudeBinaries, claudeConfigFolders, environmentConfigDir, findClaude } from "../../bridge/claude/install.ts";
import { adapterEnvironment } from "../../bridge/adapter.ts";
import { collapseHome, expandHome } from "../../bridge/home.ts";
import { createClaudeSettings, type ClaudeFile } from "./claudeSettings.ts";
import { isDirectory } from "../chat/sessions.ts";
import { choosePath } from "../folder/folder.ts";
import type { ProviderSettings } from "./providerSettings.ts";
import { messageOf, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { Text } from "../bodies.ts";

const ClaudeFields = z.object({ configDir: Text, executable: Text });

// One provider on the settings page.
export interface ProviderSettingsRow {
  id: string;
  label: string;
  enabled: boolean;
  defaultMode: Mode;
  modes: ModeChoice[];
  status: ProviderStatus;
  detected: Detected;
  // Its chats open on this host, on either surface.
  openChats: number;
}

// Claude's own settings, from ~/.x-bench/claude.json. Paths are as a person types them (~/…).
export interface ClaudeSettingsView {
  // The folder Claude uses: the one claude.json names, else the one the environment gives claude.
  configDir: string;
  // False while claude.json names no folder, so the one shown is the environment's.
  configDirSaved: boolean;
  // The binary claude.json names, or "" for the installed claude.
  executable: string;
  // The installed claude that runs while executable is "".
  installed: string;
  // Config folders in the home folder and claude binaries on PATH, to pick from.
  folders: string[];
  binaries: string[];
  // claude.json does not read, so nothing of Claude's can be saved until it is fixed.
  unreadable: boolean;
}

export interface ProviderSettingsView {
  defaultProvider: string;
  providers: ProviderSettingsRow[];
  claude: ClaudeSettingsView | null;
  // providers.json does not read, so nothing can be saved until it is fixed.
  unreadable: boolean;
  // The chooser for a folder or a binary (macOS only).
  canChoose: boolean;
}

const CLAUDE = "claude";

export function providerRoutes(host: Host): Route[] {
  const { providers, surfaces, store, publish, presentedOpen, activity, refreshUsage } = host;
  const claudeSettings = createClaudeSettings(host.paths.claudeSettings);

  async function view(): Promise<ProviderSettingsView> {
    const rows = await Promise.all(
      providers.list().map(async (provider): Promise<ProviderSettingsRow> => {
        const detected = await provider.detect().catch((error: unknown) => ({ installed: false, version: null, signedIn: null, message: messageOf(error) || "Could not check" }));
        return {
          id: provider.id,
          label: provider.label,
          enabled: providers.isEnabled(provider),
          defaultMode: providers.defaultMode(provider),
          modes: [...provider.modes],
          status: provider.status,
          detected,
          openChats: provider.sessions().length,
        };
      }),
    );
    return {
      defaultProvider: providers.defaultProvider().id,
      providers: rows,
      claude: providers.get(CLAUDE) ? claudeView() : null,
      unreadable: providers.settings.unreadable(),
      canChoose: process.platform === "darwin",
    };
  }

  function claudeView(): ClaudeSettingsView {
    const stored = claudeSettings.readFile();
    const installed = findClaude();
    const env = adapterEnvironment();
    return {
      configDir: stored.configDir ?? collapseHome(environmentConfigDir(env)),
      configDirSaved: Boolean(stored.configDir),
      executable: stored.executable ?? "",
      installed: installed ? collapseHome(installed) : "",
      folders: claudeConfigFolders(os.homedir(), env),
      binaries: claudeBinaries(),
      unreadable: claudeSettings.unreadable(),
    };
  }

  // Claude's fields from the page, checked. A config folder is always named, so Claude never ends up
  // on the default ~/.claude because a field was left empty.
  async function checkClaude(fields: z.output<typeof ClaudeFields>): Promise<ClaudeFile> {
    const configDir = fields.configDir.trim();
    const executable = fields.executable.trim();
    if (!configDir) throw refusal("Choose Claude's config folder.");
    const folder = expandHome(configDir);
    if (!isDirectory(folder)) {
      throw refusal(`There is no folder at ${collapseHome(folder)}. To use a new account there, sign in with claude in a terminal first: CLAUDE_CONFIG_DIR=${collapseHome(folder)} claude`);
    }
    if (executable) {
      const binary = expandHome(executable);
      if (!isExecutable(binary)) throw refusal(`There is no program at ${collapseHome(binary)}.`);
      const version = await commandVersion(binary, ["--version"]);
      if (!version?.includes("Claude Code")) throw refusal(`${collapseHome(binary)} is not Claude Code.`);
    }
    return {
      configDir: collapseHome(folder),
      ...(executable ? { executable: collapseHome(expandHome(executable)) } : {}),
    };
  }

  // Stops the provider's agent. Its open chats stay, and cannot send while it is off.
  async function pause(provider: Provider) {
    if (provider.status !== "idle" && provider.status !== "stopped") await provider.stop().catch(() => {});
    store.usage.delete(provider.id);
  }

  // Closes the provider's chats and stops its agent. Its sidebar rows stay.
  async function letGo(provider: Provider) {
    for (const session of provider.sessions()) {
      surfaces.drop(session.id);
      store.mentions.delete(session.id);
      await provider.forgetSession(session.id).catch(() => {});
    }
    if (provider.status !== "idle" && provider.status !== "stopped") await provider.stop().catch(() => {});
    store.usage.delete(provider.id);
  }

  return [
    {
      method: "GET",
      path: "/api/providers",
      async handle({ res }) {
        sendJson(res, 200, await view());
      },
    },
    route({
      method: "POST",
      path: "/api/providers",
      body: z.object({
        providers: z.record(z.string(), z.object({ enabled: z.boolean().optional(), defaultMode: z.string().optional() })).default({}),
        defaultProvider: z.string().optional(),
        claude: ClaudeFields.optional(),
      }),
      async handle({ res, body }) {
        // Read first: only a read notices that the file broke since the last one.
        const current = providers.settings.read();
        if (providers.settings.unreadable()) {
          sendJson(res, 409, { error: "providers.json in ~/.x-bench does not read. Fix it by hand, then try again." });
          return;
        }
        const next: ProviderSettings = { providers: {} };
        for (const provider of providers.list()) {
          const prefs = body.providers[provider.id];
          const enabled = prefs?.enabled ?? providers.isEnabled(provider);
          const asked = prefs?.defaultMode;
          const mode = isMode(asked) && provider.modes.some((choice) => choice.id === asked) ? asked : providers.defaultMode(provider);
          next.providers[provider.id] = { enabled, ...(mode === provider.defaultMode ? {} : { defaultMode: mode }) };
        }
        // Every provider may be off: then no chat can start or send until one is on again.
        const on = providers.list().filter((provider) => next.providers[provider.id]?.enabled);
        const chosen = providers.get(body.defaultProvider ?? current.defaultProvider);
        if (chosen && on.length && !on.includes(chosen)) {
          sendJson(res, 400, { error: `${chosen.label} is off, so new chats cannot start on it. Pick another default.` });
          return;
        }
        // With none on, the chosen default is kept for when one is on again.
        next.defaultProvider = (chosen ?? on[0] ?? providers.defaultProvider()).id;

        const claude = providers.get(CLAUDE);
        let claudeFile: ClaudeFile | null = null;
        let claudeMoved = false;
        // Claude's fields count only when they differ from claude.json, so a save of other settings
        // never pins, checks or restarts anything of Claude's.
        if (claude && body.claude) {
          const stored = claudeSettings.readFile();
          if (claudeSettings.unreadable()) {
            sendJson(res, 409, { error: "claude.json in ~/.x-bench does not read. Fix it by hand, then try again." });
            return;
          }
          const where = (file: ClaudeFile) => `${file.configDir ? expandHome(file.configDir) : ""}\0${file.executable ? expandHome(file.executable) : ""}`;
          const asked = { configDir: body.claude.configDir.trim(), executable: body.claude.executable.trim() };
          if (where(stored) !== where(asked)) {
            try {
              claudeFile = await checkClaude(body.claude);
            } catch (error) {
              sendJson(res, 400, { error: messageOf(error) });
              return;
            }
            claudeMoved = where(stored) !== where(claudeFile);
            if (!claudeMoved) claudeFile = null;
          }
        }

        // A provider going off pauses: its agent stops and its chats stay. Claude on another account closes its chats.
        // Neither cuts off a running turn.
        const pausing = providers.list().filter((provider) => providers.isEnabled(provider) && !next.providers[provider.id]?.enabled && !(provider === claude && claudeMoved));
        const closing = claude && claudeMoved ? [claude] : [];
        const busy = [...pausing, ...closing].find((provider) => provider.sessions().some((session) => session.status === "running"));
        if (busy) {
          sendJson(res, 409, { error: `A ${busy.label} turn is running. Stop it or wait for it to end, then save again.` });
          return;
        }

        // claude.json first: if it refuses, nothing of this save is written.
        if (claudeFile && !claudeSettings.save(claudeFile)) {
          sendJson(res, 409, { error: "claude.json in ~/.x-bench does not read. Fix it by hand, then try again." });
          return;
        }
        if (!providers.settings.save(next)) {
          sendJson(res, 409, { error: "providers.json in ~/.x-bench does not read. Fix it by hand, then try again." });
          return;
        }
        for (const provider of pausing) await pause(provider);
        for (const provider of closing) {
          await letGo(provider);
          refreshUsage(provider);
        }
        publish({ open: presentedOpen(), usage: [...store.usage.values()], ...activity(), error: null });
        sendJson(res, 200, await view());
      },
    }),
    route({
      method: "POST",
      path: "/api/providers/choose",
      body: z.object({ kind: z.enum(["folder", "binary"]).default("folder") }),
      // The macOS chooser for Claude's config folder or binary. Hidden folders show, since config folders are.
      async handle({ res, body }) {
        const { kind } = body;
        const home = os.homedir();
        const bin = path.join(home, ".local", "bin");
        const picked =
          kind === "folder"
            ? await choosePath("folder", "Choose Claude's config folder", home)
            : await choosePath("file", "Choose the claude program", isDirectory(bin) ? bin : home);
        sendJson(res, 200, { path: picked ? collapseHome(picked) : "" });
      },
    }),
  ];
}

function refusal(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}
