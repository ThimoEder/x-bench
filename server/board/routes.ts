// Board routes: every /api/board and /api/<provider> request goes to handleBoard in server/board/board.ts.

import type { ServerResponse } from "node:http";
import { canonicalCwd, isDirectory } from "../chat/sessions.ts";
import { nameUntitled, notePrompt, renameSession, showProject } from "../sidebar/sidebar.ts";
import { handleBoard, isBoardPath, PageBody, type BoardContext } from "./board.ts";
import { stripHidden } from "./boardText.ts";
import { messageOf, readBody, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function boardRoutes(host: Host): Route[] {
  const { providers, store, port, paths, sak, publish, presentedOpen, activity, catalogSnapshot, safeSessions, ensureProvider, sessionRules, sidebarHome, checkoutOf, changeSidebar, providerError } = host;

  const context: BoardContext<ServerResponse> = {
    sendJson,
    sendFile(res, file) {
      res.statusCode = file.status;
      for (const [name, value] of Object.entries(file.headers)) res.setHeader(name, value);
      // A file can be anything a ticket holds, so one opened on this origin runs no script.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.end(file.bytes);
    },
    // paths names each board source's connection file by its provider id.
    files: { tickets: paths.tickets, connections: paths },
    origin: `http://127.0.0.1:${port}`,
    isDirectory,
    isChatHome(folder: string) {
      return canonicalCwd(folder) === canonicalCwd(paths.chatHome);
    },
    sessions() {
      const { working } = providers.activityMarks();
      const live = new Set(working);
      return providers.sessions().map((session) => ({
        id: session.id,
        cwd: session.cwd || "",
        working: live.has(session.id),
      }));
    },
    publish() {
      publish({ open: presentedOpen(), sessions: safeSessions(store.snapshot.cwd), ...catalogSnapshot(), ...activity(), error: null });
    },
    changed() {
      store.boardChanges += 1;
      publish(catalogSnapshot());
    },
    syncSak: sak.sync,
    setUpSak: sak.setUp,
    nameChat(sessionId, title) {
      changeSidebar((state) => nameUntitled(state, sessionId, stripHidden(title)));
    },
    projectHome: checkoutOf,
    async openBoardPage(page) {
      if (!host.browser.view().available) throw Object.assign(new Error("Open the board here from X Bench's desktop app"), { status: 503 });
      return host.browser.call("openBoardPage", { ...page });
    },
    async openThread({ cwd: folder, ticket, picks, prompt }) {
      // The thread runs on the model its sheet picked, and starts in the background: the desk and the
      // surface stay as they are, and the host sends the prompt.
      const provider = (picks.provider ? providers.get(picks.provider) : null) ?? providers.defaultProvider();
      if (!providers.isEnabled(provider)) {
        const text = providers.enabled().length ? `${provider.label} is off. Turn it on in Settings.` : "No provider is on. Turn one on in Settings.";
        throw Object.assign(new Error(text), { status: 409, code: "provider-off" });
      }
      await ensureProvider(provider);
      const session = await provider.createSession({
        cwd: folder,
        ...(picks.model ? { model: picks.model } : {}),
        ...(picks.effort ? { effort: picks.effort } : {}),
        mode: providers.defaultMode(provider),
        rules: sessionRules(folder, ticket),
      });
      const title = stripHidden(ticket.title);
      providers.remember(session, provider, title);
      changeSidebar((state) => notePrompt(renameSession(showProject(state, sidebarHome(folder)), session.id, title), session.id));
      publish({ sessions: safeSessions(store.snapshot.cwd), ...catalogSnapshot(), ...activity(), error: null });
      return {
        sessionId: session.id,
        send() {
          provider.prompt(session.id, prompt).catch((error: unknown) => {
            providerError(provider, new Error(`The chat "${title}" did not get its prompt: ${messageOf(error) || `${provider.label} failed`}`));
          });
        },
      };
    },
  };

  return [
    {
      method: "POST",
      path: /^\/api\/(?:board|sak)\/tasks\/[A-Za-z0-9_-]+\/files$/,
      raw: true,
      contentType: "application/octet-stream",
      maxBody: MAX_FILE_BYTES,
      async handle({ req, res, url }) {
        await handleBoard(req, res, url, { file: new Blob([await readBody(req, MAX_FILE_BYTES)]) }, context);
      },
    },
    route({
      path: isBoardPath,
      body: PageBody,
      async handle({ req, res, url, body }) {
        await handleBoard(req, res, url, body, context);
      },
    }),
  ];
}
