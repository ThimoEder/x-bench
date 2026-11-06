// Review routes for a session on the desk: git status, diffs, revert, branches, the worktree list, and files.

import type { ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { directChildren, reallyInsideFolder, resolveInFolder } from "../folder/files.ts";
import { followCheckout, gitError, presentGit, presentPatch, presentPatches, presentRefs, refName } from "./git.ts";
import { revertAll } from "./revert.ts";
import { checkoutFolder, listGrokWorktrees, mergeWorktreeLists, refIsOnlyPath, sharesCheckout, turnFolders } from "./folderGit.ts";
import { diffBaseOf, localGitBranches, localGitDiffs, localGitStatus } from "./localGit.ts";
import { listFolder, readFolderFile } from "../folder/localFiles.ts";
import { readPullRequest } from "./pullRequest.ts";
import { findReplyVideo, readReplyImage, readReviewImage, sendVideo, type ReviewImage } from "./reviewImage.ts";
import { gitWorktreeRows } from "./worktree.ts";
import { messageOf, sendJson } from "../http.ts";
import { isDirectory } from "../chat/sessions.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { deskGuard } from "../routeGuard.ts";
import { SessionBody, Text } from "../bodies.ts";

const WHOLE_PATCH_MAX = 200000;

const Base = z.string().optional();

const Paths = z.array(z.string()).default([]);

// Git and files run here in the session's folder, so reviewing a session starts no harness.
export function reviewRoutes(host: Host): Route[] {
  const { providers } = host;
  const { onDesk, withSession, inFolder } = deskGuard(host);

  // The folder of a session on the desk, whichever provider holds it.
  function folderOf(sessionId: string): string {
    return providers.getSession(sessionId)?.cwd || "";
  }

  return [
    {
      method: "GET",
      path: "/api/git/image",
      handle: withSession(async ({ res, url, current }) => {
        if (!current.cwd) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const image = await readReviewImage({
          cwd: current.cwd,
          filePath: url.searchParams.get("path") || "",
          side: url.searchParams.get("side") === "before" ? "before" : "after",
          base: diffBaseOf(url.searchParams.get("base")),
        });
        if (!image) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendImage(res, image);
      }, { status: 404, error: "not found" }),
    },
    {
      // A picture a reply names. An absolute path is read as given. images/<file> that is not in the
      // project is this chat's picture, kept beside the Grok session.
      method: "GET",
      path: "/api/file/image",
      handle: withSession(async ({ res, url, current, sessionId }) => {
        let image = null;
        // Beside the Grok session that wrote the reply: a switched chat's live one or an earlier one.
        for (const harnessId of providers.ids.harnesses(sessionId)) {
          image = await readReplyImage(url.searchParams.get("path") || "", { cwd: current.cwd, sessionId: harnessId });
          if (image) break;
        }
        if (!image) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendImage(res, image);
      }, { status: 404, error: "not found" }),
    },
    {
      // A video a reply names, found the way a picture is.
      method: "GET",
      path: "/api/file/video",
      handle: withSession(async ({ req, res, url, current, sessionId }) => {
        let video = null;
        for (const harnessId of providers.ids.harnesses(sessionId)) {
          video = await findReplyVideo(url.searchParams.get("path") || "", { cwd: current.cwd, sessionId: harnessId });
          if (video) break;
        }
        if (!video) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendVideo(req, res, video);
      }, { status: 404, error: "not found" }),
    },
    route({
      method: "POST",
      path: "/api/git",
      body: SessionBody.extend({ base: Base }),
      handle: onDesk(inFolder(async ({ res, body, sessionId }) => {
        try {
          const folder = folderOf(sessionId);
          if (!folder) throw new Error("No session is open");
          if (!isDirectory(folder)) throw new Error("This chat's folder is gone");
          const [status, diffs] = await Promise.all([localGitStatus(folder), localGitDiffs(folder, null, {}, diffBaseOf(body.base))]);
          providers.forSession(sessionId).setSessionCwd(sessionId, followCheckout(folder, status));
          sendJson(res, 200, presentGit(status, diffs));
        } catch (error) {
          sendJson(res, 200, { branch: "", commit: "", files: [], error: messageOf(error) });
        }
      })),
    }),
    route({
      method: "POST",
      path: "/api/git/pr",
      body: SessionBody,
      handle: onDesk(inFolder(async ({ res, sessionId }) => {
        const folder = folderOf(sessionId);
        try {
          sendJson(res, 200, { pr: folder ? await readPullRequest(folder) : null });
        } catch (error) {
          sendJson(res, 502, { error: messageOf(error) });
        }
      })),
    }),
    route({
      method: "POST",
      path: "/api/git/diff",
      body: SessionBody.extend({ path: Text, base: Base, whole: z.boolean().optional() }),
      handle: onDesk(inFolder(async ({ res, body, sessionId }) => {
        const filePath = body.path;
        if (!filePath) {
          sendJson(res, 400, { error: "Choose a changed file" });
          return;
        }
        const folder = folderOf(sessionId);
        // Without a folder git would run in the host's own directory.
        if (!folder) {
          sendJson(res, 400, { error: "Choose a changed file" });
          return;
        }
        const whole = body.whole === true;
        const found = presentPatch(await localGitDiffs(folder, [filePath], {}, diffBaseOf(body.base), whole), filePath, whole ? Infinity : undefined);
        // A cut whole patch would hide later changes, so the page falls back to the diff.
        const patch = whole && found && found.patch.length > WHOLE_PATCH_MAX ? null : found;
        sendJson(res, 200, { patch });
      }), { status: 400, error: "Choose a changed file" }),
    }),
    route({
      method: "POST",
      path: "/api/git/diffs",
      body: SessionBody.extend({ paths: Paths, base: Base }),
      handle: onDesk(inFolder(async ({ res, body, sessionId }) => {
        const paths = body.paths.filter(Boolean);
        if (!paths.length) {
          sendJson(res, 400, { error: "Choose a changed file" });
          return;
        }
        const folder = folderOf(sessionId);
        if (!folder) {
          sendJson(res, 400, { error: "Choose a changed file" });
          return;
        }
        const diffs = await localGitDiffs(folder, paths, {}, diffBaseOf(body.base));
        sendJson(res, 200, { patches: presentPatches(diffs) });
      }), { status: 400, error: "Choose a changed file" }),
    }),
    route({
      method: "POST",
      path: "/api/git/revert",
      body: SessionBody.extend({ paths: Paths }),
      handle: withSession(inFolder(async ({ res, body, sessionId, current, provider }) => {
        if (current.status === "running") {
          sendJson(res, 400, { error: "Wait until this turn finishes before reverting" });
          return;
        }
        // A change made after the page read its list stays.
        const listed = new Set(body.paths);
        if (!listed.size) {
          sendJson(res, 400, { error: "Choose a change to revert" });
          return;
        }
        try {
          const [status, diffs] = await Promise.all([localGitStatus(current.cwd), localGitDiffs(current.cwd)]);
          const folder = provider.setSessionCwd(sessionId, followCheckout(current.cwd, status));
          const presented = presentGit(status, diffs);
          const files = presented.files.filter((file) => listed.has(String(file.path)));
          const result = await revertAll({ cwd: folder || current.cwd, root: presented.root || folder || current.cwd, files });
          if (!result.reverted.length) {
            sendJson(res, 400, { error: result.error || "Nothing to revert" });
            return;
          }
          sendJson(res, 200, { reverted: result.reverted, skipped: result.skipped });
        } catch (error) {
          sendJson(res, 400, { error: gitError(error) });
        }
      }), { status: 400, error: "Choose a change to revert" }),
    }),
    route({
      method: "POST",
      path: "/api/git/refs",
      body: SessionBody,
      handle: withSession(inFolder(async ({ res, sessionId, current, provider }) => {
        try {
          const [branches, worktrees, gitTrees, status] = await Promise.all([
            localGitBranches(current.cwd),
            listGrokWorktrees(current.cwd),
            gitWorktreeRows(current.cwd).catch(() => []),
            localGitStatus(current.cwd).catch(() => null),
          ]);
          const folder = provider.setSessionCwd(sessionId, followCheckout(current.cwd, status));
          sendJson(res, 200, presentRefs(branches, mergeWorktreeLists(worktrees, gitTrees), folder || current.cwd, status));
        } catch (error) {
          sendJson(res, 200, { branch: "", root: "", branches: [], worktrees: [], defaultBranch: "", error: gitError(error) });
        }
      })),
    }),
    route({
      method: "POST",
      path: "/api/git/checkout",
      body: SessionBody.extend({ branch: Text }),
      handle: withSession(inFolder(async ({ res, body, current }) => {
        const branch = refName(body.branch);
        if (!branch) {
          sendJson(res, 400, { error: "Choose a branch" });
          return;
        }
        if (await refIsOnlyPath(current.cwd, branch)) {
          sendJson(res, 400, { error: `${branch} is a path, not a branch` });
          return;
        }
        if (await sharesCheckout(current.cwd, turnFolders(providers))) {
          sendJson(res, 400, { error: "Wait until the turn in this folder finishes before switching branches" });
          return;
        }
        try {
          await checkoutFolder(current.cwd, branch);
          sendJson(res, 200, { branch });
        } catch (error) {
          sendJson(res, 400, { error: gitError(error) });
        }
      })),
    }),
    route({
      method: "POST",
      path: "/api/files",
      body: SessionBody.extend({ path: Text }),
      handle: withSession(inFolder(async ({ res, body, current }) => {
        const directory = path.resolve(body.path || current.cwd);
        if (!reallyInsideFolder(current.cwd, directory)) {
          sendJson(res, 400, { error: "Path is outside the session folder" });
          return;
        }
        const nodes = directChildren(directory, await listFolder(directory));
        sendJson(res, 200, { nodes });
      })),
    }),
    route({
      method: "POST",
      path: "/api/file",
      body: SessionBody.extend({ path: Text }),
      handle: withSession(inFolder(async ({ res, body, current }) => {
        const filePath = resolveInFolder(current.cwd, body.path);
        if (!filePath || filePath === path.resolve(current.cwd)) {
          sendJson(res, 400, { error: "Choose a file" });
          return;
        }
        if (!reallyInsideFolder(current.cwd, filePath)) {
          sendJson(res, 400, { error: "Path is outside the session folder" });
          return;
        }
        const content = await readFolderFile(filePath);
        sendJson(res, 200, { path: filePath, content: String(content).slice(0, 80000) });
      })),
    }),
  ];
}

function sendImage(res: ServerResponse, image: ReviewImage) {
  res.writeHead(200, {
    "Content-Type": image.mimeType,
    "Content-Length": image.body.length,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  });
  res.end(image.body);
}
