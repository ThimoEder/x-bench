// Every file and folder the host keeps in ~/.x-bench.

import os from "node:os";
import path from "node:path";

export type XBenchPaths = ReturnType<typeof xBenchPaths>;

// The X_BENCH_* variables move a single file, for a test or a second host that must not share it.
// A dev host cannot open the secrets the installed app sealed, so it keeps its own in ~/.x-bench/dev.
export function xBenchPaths(home = os.homedir(), env: NodeJS.ProcessEnv = process.env, devSecrets = false) {
  const dir = path.join(home, ".x-bench");
  const file = (name: string) => path.join(dir, name);
  const secret = (name: string) => (devSecrets ? path.join(dir, "dev", name) : file(name));
  return {
    dir,
    sidebar: file("sidebar.json"),
    // The folder a chat started outside any project runs in.
    chatHome: file("chat"),
    sessionIndex: file("sessions.json"),
    chats: env.X_BENCH_CHATS || file("chats"),
    btw: file("btw"),
    harnessCommands: file("harness-commands.json"),
    suggestions: env.X_BENCH_SUGGESTIONS || file("suggestions.json"),
    tickets: env.X_BENCH_TICKETS || file("tickets.json"),
    sak: env.X_BENCH_SAK || secret("sak.json"),
    jira: env.X_BENCH_JIRA || secret("jira.json"),
    trello: env.X_BENCH_TRELLO || secret("trello.json"),
    providerSettings: env.X_BENCH_PROVIDER_SETTINGS || file("providers.json"),
    claudeSettings: env.X_BENCH_CLAUDE_SETTINGS || file("claude.json"),
    claudeModels: file("claude-models.json"),
    chatgptModels: file("chatgpt-models.json"),
    usage: file("usage.json"),
    routines: env.X_BENCH_ROUTINES_FILE || file("routines.json"),
    routineRuns: env.X_BENCH_ROUTINE_RUNS || file("routine-runs.json"),
    routinesLock: env.X_BENCH_ROUTINES_LOCK || file("routines.lock"),
    appSettings: env.X_BENCH_APP_SETTINGS || file("settings.json"),
    browserPages: env.X_BENCH_BROWSER_DIR || file("browser-pages"),
    worktrees: file("worktrees"),
    simulatorBuilds: file("simulator-builds"),
    simulatorLogs: file("simulator-logs"),
    voiceModels: file("models"),
    remoteSettings: env.X_BENCH_REMOTE || secret("remote.json"),
    remoteDevices: file("remote-devices.json"),
    remoteCa: file("remote-ca"),
    launchToken: (port: number) => file(`launch-token-${port}`),
  };
}
