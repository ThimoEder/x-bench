// Sidebar routes: project order and collapse, renaming, pinning, archiving and unarchiving chats, and folders of chats.

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { canonicalCwd } from "../chat/sessions.ts";
import { stopWork } from "../chat/switchChat.ts";
import { type SidebarState, addFolder, archiveSession, cleanTitle, folderNamed, moveToFolder, pinSession, removeFolder, removeProject, renameFolder, renameSession, reorderProjects, setFolderCollapsed, setProjectCollapsed, unarchiveSession, unpinSession } from "./sidebar.ts";
import { sendJson } from "../http.ts";
import { appWorktreeOf, removeChatWorktree } from "../git/worktree.ts";
import { answerCleanup, readTickets, writeTickets } from "../board/tickets.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { Cwd, Maybe, SessionBody, SessionId, Text } from "../bodies.ts";

const SessionIds = z.array(SessionId).default([]);

export function sidebarRoutes(host: Host): Route[] {
  const { store, publish, presentedOpen, catalogSnapshot, safeSessions, changeSidebar } = host;

  function changeFolders(res: ServerResponse, change: (state: SidebarState) => SidebarState) {
    changeSidebar(change);
    publish({ ...catalogSnapshot() });
    sendJson(res, 200, { ok: true });
  }

  return [
    route({
      method: "POST",
      path: "/api/folders/create",
      body: z.object({ cwd: Cwd, name: Text, sessionIds: SessionIds }),
      handle({ res, body }) {
        const cwd = canonicalCwd(body.cwd);
        const name = cleanTitle(body.name);
        if (!cwd || !name) {
          sendJson(res, 400, { error: "Name the folder first" });
          return;
        }
        changeFolders(res, (state) => {
          const found = folderNamed(state, cwd, name);
          if (found) return moveToFolder(state, body.sessionIds, found.id);
          const id = randomBytes(6).toString("hex");
          return moveToFolder(addFolder(state, cwd, name, id), body.sessionIds, id);
        });
      },
    }),
    route({
      method: "POST",
      path: "/api/folders/move",
      body: z.object({ sessionIds: SessionIds, folderId: Maybe }),
      handle({ res, body }) {
        changeFolders(res, (state) => moveToFolder(state, body.sessionIds, body.folderId || null));
      },
    }),
    route({
      method: "POST",
      path: "/api/folders/rename",
      body: z.object({ folderId: z.string(), name: Text }),
      handle({ res, body }) {
        const name = cleanTitle(body.name);
        if (!name) {
          sendJson(res, 400, { error: "Name the folder first" });
          return;
        }
        changeFolders(res, (state) => renameFolder(state, body.folderId, name));
      },
    }),
    route({
      method: "POST",
      path: "/api/folders/collapsed",
      body: z.object({ folderId: z.string(), collapsed: z.boolean() }),
      handle({ res, body }) {
        changeFolders(res, (state) => setFolderCollapsed(state, body.folderId, body.collapsed));
      },
    }),
    route({
      method: "POST",
      path: "/api/folders/remove",
      body: z.object({ folderId: z.string() }),
      handle({ res, body }) {
        changeFolders(res, (state) => removeFolder(state, body.folderId));
      },
    }),
    route({
      method: "POST",
      path: "/api/projects/remove",
      body: z.object({ cwd: Cwd }),
      handle({ res, body }) {
        changeSidebar((state) => removeProject(state, canonicalCwd(body.cwd)));
        publish({ ...catalogSnapshot() });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/projects/collapsed",
      body: z.object({ cwd: Cwd, collapsed: z.boolean() }),
      handle({ res, body }) {
        changeSidebar((state) => setProjectCollapsed(state, canonicalCwd(body.cwd), body.collapsed));
        publish({ ...catalogSnapshot() });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/projects/order",
      body: z.object({ cwd: z.array(z.string()) }),
      handle({ res, body }) {
        changeSidebar((state) => reorderProjects(state, body.cwd));
        publish({ ...catalogSnapshot() });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/rename",
      body: SessionBody.extend({ title: Text }),
      handle({ res, body }) {
        const { sessionId } = body;
        const title = cleanTitle(body.title);
        if (!title) {
          sendJson(res, 400, { error: "Name the chat first" });
          return;
        }
        changeSidebar((state) => renameSession(state, sessionId, title));
        publish({ open: presentedOpen(), sessions: safeSessions(store.snapshot.cwd), ...catalogSnapshot() });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/pin",
      body: SessionBody.extend({ pinned: z.boolean().optional() }),
      handle({ res, body }) {
        const { sessionId } = body;
        changeSidebar((state) => (body.pinned === false ? unpinSession(state, sessionId) : pinSession(state, sessionId)));
        publish({ ...catalogSnapshot() });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/archive",
      body: SessionBody.extend({ worktree: z.boolean().optional() }),
      async handle({ res, body }) {
        // Archiving hides the row and keeps the ticket link and the history, and answers a done ticket's offer to archive. It ends the session's turn, background tasks and shells.
        const { sessionId } = body;
        const listed = [...store.snapshot.projects.flatMap((project) => project.sessions), ...store.snapshot.chats].find((session) => session.id === sessionId);
        changeSidebar((state) => archiveSession(state, sessionId));
        host.terminals.endSession(sessionId);
        await stopWork(host.providers.forSession(sessionId), sessionId);
        const worktreeRoot = canonicalCwd(host.paths.worktrees);
        const worktree = body.worktree === true && listed?.ownWorktree ? appWorktreeOf(listed.cwd, worktreeRoot) : null;
        const kept = worktree ? await removeChatWorktree(worktree, sessionId, host.chatRows(), worktreeRoot) : "";
        const tickets = readTickets(host.paths.tickets);
        const answered = answerCleanup(tickets, sessionId);
        if (JSON.stringify(answered) !== JSON.stringify(tickets)) writeTickets(answered, host.paths.tickets);
        publish({ ...catalogSnapshot(), ...(kept ? { error: kept } : {}) });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/unarchive",
      body: SessionBody,
      handle({ res, body }) {
        changeSidebar((state) => unarchiveSession(state, body.sessionId));
        publish({ ...catalogSnapshot() });
        sendJson(res, 200, { ok: true });
      },
    }),
  ];
}
