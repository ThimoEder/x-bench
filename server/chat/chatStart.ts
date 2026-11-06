// Starting a chat off the desk, for a suggested task or a routine run: the folder made ready, the session created
// and named in the sidebar, and its first prompt sent.

import type { Mode, Provider } from "../../bridge/provider.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import { gitError } from "../git/git.ts";
import { httpError, messageOf, statusOf } from "../http.ts";
import { canonicalCwd, isDirectory } from "./sessions.ts";
import { noteChat, notePrompt, renameSession, showProject } from "../sidebar/sidebar.ts";
import type { TaskStart } from "../board/taskStart.ts";
import { branchFromMain, currentBranch, latestMain, runIn } from "../git/branch.ts";
import type { Host } from "../app.ts";

export type ChatStartHost = Pick<
  Host,
  "providers" | "store" | "paths" | "ensureProvider" | "createWorktree" | "sessionRules" | "sidebarHome" | "changeSidebar" | "publish" | "safeSessions" | "catalogSnapshot" | "activity" | "sessionError"
>;

export interface ChatStartOptions {
  provider: Provider;
  folder: string;
  where: TaskStart;
  // The branch a worktree or branch start checks out, with -2, -3 … when the name is taken.
  branch: string;
  title: string;
  model?: string;
  effort?: string;
  mode: Mode;
  note?: string;
  // The first prompt, for the folder the chat starts in.
  prompt(cwd: string): string;
  // Checked once the session exists: false closes it again and fails the start with 409.
  stillWanted?(): boolean;
  // Runs once the session exists, before the sidebar shows it.
  onCreated?(session: SessionState, cwd: string): void;
  // False for a chat that stays out of the sidebar, such as a routine run: it only gets its title there, and its
  // folder is not added as a project.
  listed?: boolean;
}

export interface StartedChat {
  session: SessionState;
  cwd: string;
  // Whether the harness took the first prompt.
  sent: Promise<boolean>;
}

// undo puts a branched folder back where it was and deletes the new, empty branch.
async function readyFolder(host: ChatStartHost, where: TaskStart, folder: string, stem: string, providerId: string, name: string): Promise<{ cwd: string; undo?: () => Promise<void> }> {
  if (where === "branch") {
    const git = runIn(folder);
    const previous = (await currentBranch(folder, git)) || (await git(["rev-parse", "HEAD"])).trim();
    const { branch } = await branchFromMain(folder, stem, git);
    return {
      cwd: folder,
      undo: async () => {
        await git(["checkout", previous, "--"]);
        await git(["branch", "-D", branch]);
      },
    };
  }
  if (where === "worktree") {
    const created = await host.createWorktree(folder, await latestMain(folder), providerId, { name, branch: stem });
    if (!isDirectory(created.path)) throw new Error("Worktree was not created");
    return { cwd: canonicalCwd(created.path) };
  }
  return { cwd: folder };
}

// Errors carry a status: 400 when the folder could not be made ready, the harness's status when the chat did not open.
export async function startChat(host: ChatStartHost, options: ChatStartOptions): Promise<StartedChat> {
  const { providers, store } = host;
  const { provider } = options;
  // The provider starts before any git work, so one that cannot start leaves no worktree or branch behind.
  await host.ensureProvider(provider);
  let ready: Awaited<ReturnType<typeof readyFolder>>;
  try {
    ready = await readyFolder(host, options.where, canonicalCwd(options.folder), options.branch, provider.id, options.title);
  } catch (error) {
    throw httpError(gitError(error) || messageOf(error), 400);
  }
  const { cwd, undo } = ready;
  const chat = cwd === canonicalCwd(host.paths.chatHome);
  const rules = [chat ? "" : host.sessionRules(cwd), options.note || ""].filter(Boolean).join("\n\n");
  let session: SessionState;
  try {
    session = await provider.createSession({
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      mode: options.mode,
      ...(rules ? { rules } : {}),
    });
  } catch (error) {
    await undo?.().catch(() => {});
    // A new worktree stays, and the next start makes a fresh one.
    const kept = options.where === "worktree" ? ` The worktree is at ${cwd}.` : "";
    throw httpError(`The chat did not start: ${messageOf(error)}${kept}`, statusOf(error, 500));
  }
  if (options.stillWanted && !options.stillWanted()) {
    await provider.forgetSession(session.id).catch(() => {});
    await undo?.().catch(() => {});
    throw httpError("The start was called off while the chat opened", 409);
  }
  providers.remember(session, provider, options.title);
  options.onCreated?.(session, cwd);
  const listed = options.listed ?? true;
  host.changeSidebar((state) => {
    if (!listed) return renameSession(state, session.id, options.title);
    const named = notePrompt(renameSession(chat ? state : showProject(state, host.sidebarHome(cwd)), session.id, options.title), session.id);
    return chat ? noteChat(named, session.id) : named;
  });
  host.publish({ sessions: host.safeSessions(store.snapshot.cwd), ...host.catalogSnapshot(), ...host.activity() });
  const prompting = provider.prompt(session.id, options.prompt(cwd));
  const failed = host.sessionError(session.id, provider);
  const sent = prompting.then(
    () => true,
    (error: unknown) => {
      failed(error);
      return false;
    },
  );
  return { session, cwd, sent };
}
