// Starting or dismissing a suggested task.

import path from "node:path";
import { isTaskStart, retargetPrompt, taskBranchName } from "./taskStart.ts";
import { startChat } from "../chat/chatStart.ts";
import { isDirectory } from "../chat/sessions.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import { messageOf, sendJson, statusOf } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { Cwd, SessionBody, Text } from "../bodies.ts";

function currentPicks(session: SessionState | null): { model?: string; effort?: string } {
  const value = (id: string) => {
    const current = session?.configOptions.find((option) => option.id === id)?.currentValue;
    return typeof current === "string" && current ? current : undefined;
  };
  const model = value("model");
  const effort = value("effort");
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function suggestionRoutes(host: Host): Route[] {
  const { suggestions, providers } = host;
  // Suggestions whose start is running, as "<session>\0<suggestion>".
  const starting = new Set<string>();

  return [
    route({
      method: "POST",
      path: "/api/suggestions/start",
      body: SessionBody.extend({ id: Text, where: Text, cwd: Cwd }),
      async handle({ res, body }) {
        const sourceId = body.sessionId;
        const suggestion = suggestions.list(sourceId).find((item) => item.id === body.id);
        if (!suggestion) {
          sendJson(res, 404, { error: "That suggestion is gone" });
          return;
        }
        const where = body.where;
        if (!isTaskStart(where)) {
          sendJson(res, 400, { error: "Choose where to start" });
          return;
        }
        const folder = path.resolve(body.cwd);
        if (!body.cwd || !isDirectory(folder)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        const source = providers.forSession(sourceId);
        const provider = providers.isEnabled(source) ? source : providers.defaultProvider();
        if (!providers.isEnabled(provider)) {
          sendJson(res, 409, { error: "No provider is on. Turn one on in Settings." });
          return;
        }
        const claim = `${sourceId}\0${suggestion.id}`;
        if (starting.has(claim)) {
          sendJson(res, 409, { error: "It is already starting" });
          return;
        }
        starting.add(claim);
        try {
          const picks = provider === source ? currentPicks(source.getSession(sourceId)) : {};
          const sourceCwd = source.getSession(sourceId)?.cwd;
          let started;
          try {
            started = await startChat(host, {
              provider,
              folder,
              where,
              branch: taskBranchName(suggestion.title),
              title: suggestion.title,
              ...picks,
              mode: providers.defaultMode(provider),
              prompt: (cwd) => retargetPrompt(suggestion.prompt, [folder, ...(sourceCwd ? [sourceCwd] : [])], cwd),
              onCreated() {
                // The page sends no dismiss after a start, so this is the only removal: a reload cannot start it twice.
                try {
                  suggestions.remove(sourceId, suggestion.id);
                } catch {
                  // A suggestions file that does not read keeps it. The chat runs either way.
                }
              },
            });
          } catch (error) {
            sendJson(res, statusOf(error, 500), { error: messageOf(error) });
            return;
          }
          sendJson(res, 200, { sessionId: started.session.id, cwd: started.cwd });
        } finally {
          starting.delete(claim);
        }
      },
    }),
    route({
      method: "POST",
      path: "/api/suggestions/dismiss",
      body: SessionBody.extend({ id: Text }),
      handle({ res, body }) {
        if (!body.id) {
          sendJson(res, 400, { error: "Choose a suggestion" });
          return;
        }
        suggestions.remove(body.sessionId, body.id);
        sendJson(res, 200, { ok: true });
      },
    }),
  ];
}
