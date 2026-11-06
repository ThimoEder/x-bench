// Folder routes: the page's folder, and a folder's branches and worktrees before a session exists.

import path from "node:path";
import { z } from "zod";
import { chooseFolder, openFolder, revealFile } from "./folder.ts";
import { folderPathOf, resolveInFolder } from "./files.ts";
import { checkoutFolder, readFolderRefs, sharesCheckout, turnFolders } from "../git/folderGit.ts";
import { gitError, refName } from "../git/git.ts";
import { canonicalCwd, isDirectory } from "../chat/sessions.ts";
import { latestMain } from "../git/branch.ts";
import { messageOf, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { deskGuard } from "../routeGuard.ts";
import { Cwd, SessionBody, Text } from "../bodies.ts";
import { viaRemote } from "../remote/remote.ts";

export function folderRoutes(host: Host): Route[] {
  const { store, publish, safeSessions, providers, createWorktree } = host;
  const { withSession } = deskGuard(host);

  function worktreeProvider(id: string | undefined): string {
    if (id) {
      const requested = providers.get(id);
      if (!requested || !providers.isEnabled(requested)) throw new Error("That provider is not available");
      return requested.id;
    }
    const fallback = providers.defaultProvider();
    if (!fallback || !providers.isEnabled(fallback)) throw new Error("That provider is not available");
    return fallback.id;
  }

  return [
    route({
      method: "POST",
      path: "/api/browse",
      body: z.object({ pick: z.boolean().optional() }),
      async handle({ res, body }) {
        const folder = await chooseFolder();
        if (body.pick) {
          sendJson(res, 200, { cwd: folder || "" });
          return;
        }
        if (folder) {
          publish({ cwd: folder, sessions: safeSessions(folder), error: null });
        }
        sendJson(res, 200, { cwd: store.snapshot.cwd, sessions: store.snapshot.sessions });
      },
    }),
    route({
      method: "POST",
      path: "/api/cwd",
      body: z.object({ cwd: Cwd }),
      handle({ res, body }) {
        const next = path.resolve(body.cwd);
        if (!isDirectory(next)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        publish({ cwd: next, sessions: safeSessions(next), error: null });
        sendJson(res, 200, { cwd: next, sessions: store.snapshot.sessions });
      },
    }),
    route({
      method: "POST",
      path: "/api/folder",
      body: z.object({ cwd: Cwd }),
      handle({ res, body }) {
        const next = path.resolve(body.cwd);
        if (!isDirectory(next)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        const folder = canonicalCwd(next);
        sendJson(res, 200, { cwd: folder, name: path.basename(folder) || folder });
      },
    }),
    route({
      method: "POST",
      // A file a reply names. With dock, one that really lies in the session folder opens in the review dock:
      // the answer gives its path under the folder. Any other file is shown in Finder.
      path: "/api/file/open",
      body: SessionBody.extend({ path: Text, dock: z.boolean().optional() }),
      handle: withSession(async ({ req, res, body, current }) => {
        const target = resolveInFolder(current.cwd, body.path);
        if (!target) {
          sendJson(res, 400, { error: "Choose a file" });
          return;
        }
        const inFolder = body.dock === true ? folderPathOf(current.cwd, target) : null;
        if (inFolder) {
          sendJson(res, 200, { opened: "dock", path: inFolder });
          return;
        }
        if (viaRemote(req)) {
          sendJson(res, 403, { error: "This file opens in Finder on the Mac" });
          return;
        }
        try {
          sendJson(res, 200, { opened: "finder", path: await revealFile(target) });
        } catch (error) {
          const text = messageOf(error) || "Couldn't show the file";
          sendJson(res, text === "File does not exist" ? 404 : 500, { error: text });
        }
      }),
    }),
    route({
      method: "POST",
      path: "/api/folder/open",
      body: SessionBody,
      handle: withSession(async ({ res, current }) => {
        if (!isDirectory(current.cwd || "")) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        try {
          sendJson(res, 200, { cwd: await openFolder(current.cwd) });
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) || "Couldn't open the folder" });
        }
      }),
    }),
    route({
      method: "POST",
      path: "/api/folder/refs",
      body: z.object({ cwd: Cwd }),
      async handle({ res, body }) {
        const next = path.resolve(body.cwd);
        if (!isDirectory(next)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        sendJson(res, 200, await readFolderRefs(canonicalCwd(next)));
      },
    }),
    route({
      method: "POST",
      path: "/api/folder/checkout",
      body: z.object({ cwd: Cwd, branch: Text }),
      async handle({ res, body }) {
        const next = path.resolve(body.cwd);
        const branch = refName(body.branch);
        if (!isDirectory(next)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        if (!branch) {
          sendJson(res, 400, { error: "Choose a branch" });
          return;
        }
        if (await sharesCheckout(next, turnFolders(providers))) {
          sendJson(res, 400, { error: "Wait until the turn in this folder finishes before switching branches" });
          return;
        }
        try {
          await checkoutFolder(canonicalCwd(next), branch);
          sendJson(res, 200, { branch });
        } catch (error) {
          sendJson(res, 400, { error: gitError(error) });
        }
      },
    }),
    route({
      method: "POST",
      path: "/api/folder/worktree",
      body: z.object({ cwd: Cwd, gitRef: Text, provider: z.string().optional(), name: Text }),
      async handle({ res, body }) {
        const next = path.resolve(body.cwd);
        // No gitRef means the folder's default branch, fetched first.
        const asked = body.gitRef && refName(body.gitRef);
        if (!isDirectory(next)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        if (!asked && body.gitRef) {
          sendJson(res, 400, { error: "Choose a branch" });
          return;
        }
        const folder = canonicalCwd(next);
        try {
          const gitRef = asked || (await latestMain(folder).catch(() => "HEAD"));
          const created = await createWorktree(folder, gitRef, worktreeProvider(body.provider), { name: body.name });
          if (!isDirectory(created.path)) {
            sendJson(res, 500, { error: "Worktree was not created" });
            return;
          }
          sendJson(res, 200, created);
        } catch (error) {
          sendJson(res, 400, { error: gitError(error) });
        }
      },
    }),
  ];
}
