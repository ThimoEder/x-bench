// Session routes: the event stream, opening, loading, deleting and leaving sessions, prompts and the queue,
// side questions, mentions, and the plan, permission, mode and config answers.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { AttachmentInput, composePrompt } from "../../bridge/attachments.ts";
import { FormAnswers } from "../../bridge/elicitation.ts";
import { isMode, type Provider } from "../../bridge/provider.ts";
import { listFolderSkills } from "../chat/skills.ts";
import { ownBtwDir } from "../chat/btw.ts";
import { canonicalCwd, isDirectory, isSessionId } from "../chat/sessions.ts";
import { searchFolder } from "../folder/localFiles.ts";
import { dropSession, noteChat, notePrompt, showProject } from "../sidebar/sidebar.ts";
import { dropSessionLinks, readTickets, writeTickets } from "../board/tickets.ts";
import { toolImage } from "./images.ts";
import { messageOf, sendJson, statusOf } from "../http.ts";
import { MAX_JSON_BYTES } from "../apiGuard.ts";
import { MAX_TOTAL_BYTES } from "../../ui/chat/composer/attachments.ts";
import type { Host, SwitchRun } from "../app.ts";
import type { GoneFolder } from "../folder/goneFolder.ts";
import { route, type Route } from "../router.ts";
import { Cwd, Maybe, SessionBody, RequestId, SessionId, Text } from "../bodies.ts";
import { latestMain } from "../git/branch.ts";
import { appWorktreeOf, removeChatWorktree, worktreeChanges } from "../git/worktree.ts";
import { deskGuard } from "../routeGuard.ts";
import { contextWindows } from "./context.ts";
import { withHandoff } from "./handoff.ts";
import { previewSwitch, stopTurn, stopWork, switchChat, SwitchCancelled, type SwitchDeps, type SwitchRequest } from "./switchChat.ts";

// A prompt carries its attached files as base64, which is a third larger than the files.
const MAX_PROMPT_BYTES = Math.ceil((MAX_TOTAL_BYTES * 4) / 3) + MAX_JSON_BYTES;

const Attachments = z.array(AttachmentInput).optional();

const SwitchBody = SessionBody.extend({
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  handoff: z.enum(["summary", "text"]).optional(),
});

const QueueBody = SessionBody.extend({ id: z.string(), version: z.number().optional() });

export function sessionRoutes(host: Host): Route[] {
  const { providers, desk, surfaces, store, publish, presentedOpen, presentedStored, activity, catalogSnapshot, safeSessions, ensureProvider, providerError, sessionError, clearSessionError, clearedBy, sessionRules, sidebarHome, changeSidebar, followOpenSessions, pollUsage, goneFolderOf, createWorktree } = host;
  const { onDesk, onDeskOrUnsent, onDeskOrWaiting, withSession } = deskGuard(host);
  const { chatRecords, paths, harnessCommands } = host;
  const installed = new Map<string, Promise<boolean>>();

  const switchDeps: SwitchDeps = {
    providers,
    ensureProvider,
    rules: (cwd) => (canonicalCwd(cwd) === canonicalCwd(paths.chatHome) ? undefined : sessionRules(cwd)),
    windows: contextWindows,
    blocked(provider) {
      if (!providers.isEnabled(provider)) return `${provider.label} is off`;
      if (provider.status === "failed") return `${provider.label} is not running`;
      const usage = store.usage.get(provider.id);
      const resets = usage?.resetsAt ? Date.parse(usage.resetsAt) : Number.NaN;
      if (usage && usage.percent >= 100 && !(resets <= Date.now())) return `${provider.label} has reached its usage limit`;
      return null;
    },
  };

  // A prompt, or a follow-up while a turn runs. A switched chat's first message on the new provider carries the
  // conversation that provider missed.
  // Resolves once the message is on its way, before its turn ends.
  async function sendPrompt(sessionId: string, given: unknown, attachments: unknown): Promise<void> {
    const provider = holderOf(sessionId);
    if (provider.getSession(sessionId)?.status !== "running") {
      try {
        // A chat kept open while its provider was off starts the provider again with its next message.
        await ensureProvider(provider);
      } catch (error) {
        providerError(provider, error);
        return;
      }
    }
    const record = chatRecords.get(sessionId);
    const handoff = record?.pending ?? null;
    if (record && handoff) chatRecords.save(sessionId, { ...record, pending: null });
    const text = handoff ? withHandoff(handoff, String(given ?? "")) : given;
    const before = provider.getSession(sessionId)?.transcript.length ?? 0;
    const send = provider.getSession(sessionId)?.status === "running" ? provider.followUp(sessionId, text, attachments) : provider.prompt(sessionId, text, attachments);
    const reportFailure = sessionError(sessionId, provider);
    send.catch((error: unknown) => {
      // Only a message that never reached the session gives its handoff back: one the harness took carries it.
      const now = chatRecords.get(sessionId);
      if (handoff && now && !now.pending && (provider.getSession(sessionId)?.transcript.length ?? 0) <= before) chatRecords.save(sessionId, { ...now, pending: handoff });
      reportFailure(error);
    });
  }

  // Stops a running switch at its next step. The summary turn runs on the model the chat is leaving, which still
  // holds the chat's id, and may wait on a permission nobody can see.
  function cancelSwitch(sessionId: string, run: SwitchRun) {
    run.cancelled = true;
    if (run.view.summarizing) stopTurn(holderOf(sessionId), sessionId);
  }

  // The messages sent while a switch ran, each as it was sent. The first starts the turn and the rest follow it,
  // which a second prompt would not: it would find the first one's turn running.
  async function sendHeld(sessionId: string, run: SwitchRun) {
    for (const [index, held] of run.held.entries()) {
      const before = providers.getSession(sessionId)?.transcript.length ?? 0;
      await sendPrompt(sessionId, held.text, held.attachments);
      if (index < run.held.length - 1) await untilTaken(sessionId, before);
    }
  }

  // Until the message is in: its turn runs, or it already ended and the transcript grew.
  async function untilTaken(sessionId: string, before: number, wait = 5000) {
    const until = Date.now() + wait;
    const taken = () => {
      const session = providers.getSession(sessionId);
      return session?.status === "running" || (session?.transcript.length ?? 0) > before;
    };
    while (Date.now() < until && !taken()) {
      await new Promise((done) => {
        setTimeout(done, 25);
      });
    }
  }

  function switchRequest(sessionId: string, body: z.output<typeof SwitchBody>): SwitchRequest {
    return {
      chatId: sessionId,
      provider: body.provider,
      ...(body.model ? { model: body.model } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      ...(body.handoff ? { handoff: body.handoff } : {}),
    };
  }

  // The folder the chat last ran in, as this app recorded it.
  function recordedFolder(sessionId: string): string {
    const listed = [...store.snapshot.projects.flatMap((project) => project.sessions), ...store.snapshot.chats].find((session) => session.id === sessionId);
    return providers.index.get(sessionId)?.cwd || listed?.cwd || "";
  }

  // A chat whose folder is gone opens to be read: from the harness's own record where it keeps one, else
  // loaded in the checkout its worktree came from or the chat folder.
  async function openToRead(provider: Provider, sessionId: string, gone: GoneFolder) {
    if (provider.showStoredSession) return provider.showStoredSession(sessionId, gone.path);
    if (!gone.home) fs.mkdirSync(paths.chatHome, { recursive: true });
    return provider.loadSession(sessionId, gone.home ?? canonicalCwd(paths.chatHome));
  }

  function holderOf(sessionId: string): Provider {
    return providers.forSession(sessionId);
  }

  // A harness that is off or fails to start may still delete its copy without its agent, and a failed delete reports the start error.
  async function deleteOwnCopy(view: Provider, holder: Provider, sessionId: string) {
    const startError: unknown = await ensureProvider(view).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await holder.deleteSession?.(sessionId);
    } catch (error) {
      throw startError ?? error;
    }
  }

  // A chat stays open when its provider is turned off, but sends nothing until it is on again.
  function offMessage(provider: Provider) {
    return `${provider.label} is off. Turn it on in Settings to send.`;
  }


  return [
    {
      method: "GET",
      path: /^\/api\/images\/([^/]+)\/([^/]+)\/(\d+)$/,
      handle({ res, match }) {
        const sessionId = decodeURIComponent(match[1] ?? "");
        const toolCallId = decodeURIComponent(match[2] ?? "");
        const index = Number(match[3]);
        const image =
          isSessionId(sessionId) && /^[\w.:-]{1,200}$/.test(toolCallId)
            ? toolImage(providers.getSession(sessionId), toolCallId, index)
            : null;
        if (!image) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": image.mimeType,
          "Content-Length": image.body.length,
          "Cache-Control": "private, max-age=3600",
        });
        res.end(image.body);
      },
    },
    {
      method: "GET",
      path: "/api/health",
      handle({ res }) {
        sendJson(res, 200, { ok: true, providers: Object.fromEntries(providers.list().map((provider) => [provider.id, provider.status])) });
      },
    },
    {
      method: "GET",
      path: "/api/events",
      handle({ req, res, url }) {
        const brotli = /\bbr\b(?!\s*;\s*q=0(\.0*)?\s*(,|$))/.test(String(req.headers["accept-encoding"] ?? ""));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...(brotli ? { "Content-Encoding": "br" } : {}),
        });
        const stream = brotli ? brotliPage(res) : res;
        // A page asks for changed fields only. One built before that, still open across a host update, gets whole snapshots.
        const page = { write: (chunk: string) => stream.write(chunk), changes: url.searchParams.get("changes") === "1" };
        // A new page gets the model catalog as the providers have it now, not as it was at the last change.
        publish({});
        page.write(`data: ${JSON.stringify(store.snapshot)}\n\n`);
        store.clients.add(page);
        for (const provider of providers.enabled().filter((each) => each.startsWithPage)) {
          const found = installed.get(provider.id) ?? provider.detect().then((detected) => detected.installed, () => false);
          installed.set(provider.id, found);
          found
            .then((yes) => {
              if (!yes && installed.get(provider.id) === found) installed.delete(provider.id);
              return yes ? ensureProvider(provider) : undefined;
            })
            .catch(() => {});
        }
        pollUsage();
        const beat = setInterval(() => page.write(": ping\n\n"), 15000);
        res.on("close", () => {
          clearInterval(beat);
          store.clients.delete(page);
        });
      },
    },
    {
      method: "GET",
      path: "/api/sessions",
      handle({ res, url }) {
        const next = url.searchParams.get("cwd");
        const folder = next ? path.resolve(next) : store.snapshot.cwd;
        sendJson(res, 200, { cwd: folder, sessions: safeSessions(folder) });
      },
    },
    route({
      method: "POST",
      path: "/api/surface",
      body: z.object({ mode: z.enum(["chat", "builder"]) }),
      handle({ res, body }) {
        desk.claim();
        surfaces.show(body.mode);
        try {
          followOpenSessions();
        } catch {
          // The restored panes still open if a session log cannot be read.
        }
        publish({ surface: surfaces.surface(), open: presentedOpen(), ...activity(), error: null });
        sendJson(res, 200, { surface: surfaces.surface(), open: store.snapshot.open });
      },
    }),
    route({
      method: "POST",
      path: "/api/session",
      body: z.object({
        cwd: Cwd,
        chat: z.boolean().optional(),
        beside: z.boolean().optional(),
        background: z.boolean().optional(),
        replaceId: SessionId.optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        mode: z.string().optional(),
      }),
      async handle({ res, body }) {
        const chat = Boolean(body.chat);
        if (chat && body.beside) {
          sendJson(res, 409, { error: "Close a session before opening another." });
          return;
        }
        let next = path.resolve(body.cwd || store.snapshot.cwd);
        if (chat) {
          fs.mkdirSync(paths.chatHome, { recursive: true });
          next = canonicalCwd(paths.chatHome);
        }
        if (!isDirectory(next)) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        const replaceId = body.replaceId ?? "";
        if (replaceId && !desk.has(replaceId)) {
          sendJson(res, 400, { error: "That session is not open" });
          return;
        }
        if (body.beside && !surfaces.allowsBeside()) {
          sendJson(res, 409, { error: "Close a session before opening another." });
          return;
        }
        if (body.beside && !replaceId && !desk.canAdd()) {
          sendJson(res, 409, { error: "Close a session before opening another." });
          return;
        }
        const provider = body.provider ? providers.get(body.provider) : providers.defaultProvider();
        if (!provider) {
          sendJson(res, 400, { error: "Unknown provider" });
          return;
        }
        if (!providers.isEnabled(provider)) {
          sendJson(res, 409, { error: providers.enabled().length ? `${provider.label} is off. Turn it on in Settings.` : "No provider is on. Turn one on in Settings." });
          return;
        }
        // A new session starts in its provider's default mode unless the page picked one (/plan).
        const asked = body.mode;
        const mode = isMode(asked) && provider.modes.some((choice) => choice.id === asked) ? asked : providers.defaultMode(provider);
        // Sent with background, or overtaken by a newer load, session or surface switch, the session opens off the desk.
        const background = Boolean(body.background);
        const current = background ? null : desk.claim();
        if (chat && !background) surfaces.show("chat");
        publish({
          cwd: chat || background ? store.snapshot.cwd : next,
          surface: surfaces.surface(),
          open: presentedOpen(),
          error: null,
        });
        await ensureProvider(provider);
        const session = await provider.createSession({
          cwd: next,
          ...(body.model ? { model: body.model } : {}),
          ...(body.effort ? { effort: body.effort } : {}),
          mode,
          ...(chat ? {} : { rules: sessionRules(next) }),
        });
        providers.remember(session, provider);
        if (!current?.()) store.unsent.add(session.id);
        else if (chat) desk.replace(session.id);
        else if (replaceId) desk.replaceSlot(replaceId, session.id);
        else if (body.beside) desk.add(session.id);
        else desk.replace(session.id);
        changeSidebar((state) => {
          const prompted = notePrompt(chat ? state : showProject(state, sidebarHome(next)), session.id);
          return chat ? noteChat(prompted, session.id) : prompted;
        });
        publish({ open: presentedOpen(), sessions: safeSessions(store.snapshot.cwd), ...catalogSnapshot(), ...activity(), error: null });
        sendJson(res, 200, { sessionId: session.id, open: store.snapshot.open });
      },
    }),
    route({
      method: "POST",
      // A chat as its harness's own record has it, for the page to show while /api/load runs. Null for a chat
      // whose provider keeps no record, one already loaded, or one with nothing recorded.
      path: "/api/preview",
      body: z.object({ sessionId: SessionId, cwd: Cwd }),
      async handle({ res, body }) {
        const { sessionId } = body;
        const provider = holderOf(sessionId);
        if (!isSessionId(sessionId) || !provider.previewStoredSession || provider.getSession(sessionId)) {
          sendJson(res, 200, { session: null });
          return;
        }
        const cwd = recordedFolder(sessionId) || path.resolve(body.cwd || store.snapshot.cwd);
        const stored = await provider.previewStoredSession(sessionId, cwd);
        if (!stored?.transcript.length) {
          sendJson(res, 200, { session: null });
          return;
        }
        const shown = presentedStored(stored, provider);
        // /api/images serves the pictures of a loaded chat only, so they show once this chat has loaded.
        sendJson(res, 200, { session: { ...shown, transcript: shown.transcript.map((item) => ({ ...item, images: undefined })) } });
      },
    }),
    route({
      method: "POST",
      path: "/api/load",
      body: z.object({ sessionId: SessionId, cwd: Maybe, beside: z.boolean().optional(), replaceId: SessionId.optional() }),
      async handle({ res, body }) {
        const current = desk.claim();
        const asked = path.resolve(body.cwd || store.snapshot.cwd);
        const { sessionId } = body;
        await store.closing.get(sessionId);
        // The recorded folder decides: a caller can name the checkout of a chat whose worktree is gone.
        const recorded = recordedFolder(sessionId);
        const missing = !isDirectory(asked) ? asked : recorded && !isDirectory(recorded) ? recorded : "";
        const gone = missing ? await goneFolderOf(sessionId, missing) : null;
        const next = gone ? (gone.home ?? canonicalCwd(paths.chatHome)) : asked;
        if (body.beside && !surfaces.allowsBeside()) {
          sendJson(res, 409, { error: "Close a session before opening another." });
          return;
        }
        if (body.beside && desk.has(sessionId)) {
          sendJson(res, 200, { open: store.snapshot.open });
          return;
        }
        if (body.beside && !desk.canAdd(sessionId)) {
          sendJson(res, 409, { error: "Close a session before opening another." });
          return;
        }
        const builder = canonicalCwd(next) !== canonicalCwd(paths.chatHome);
        const provider = holderOf(sessionId);
        publish(clearedBy(provider));
        await ensureProvider(provider);
        // A builder session gets the folder's board rules again, for a harness that needs them on every load.
        // A chat whose folder came back lets go of its copy in the stand-in folder, which a load would return as it is.
        if (!gone && store.goneFolders.has(sessionId)) await provider.forgetSession(sessionId);
        const session = gone ? await openToRead(provider, sessionId, gone) : await provider.loadSession(sessionId, next, builder ? { rules: sessionRules(next) } : {});
        if (!session) throw new Error("Session did not load");
        if (session.status === "idle") clearSessionError(session.id);
        // The index keeps the folder that is gone, so the chat stays marked until it moves.
        if (gone) store.goneFolders.set(session.id, gone);
        else {
          store.goneFolders.delete(session.id);
          providers.remember(session, provider);
        }
        if (!current()) {
          sendJson(res, 200, { open: store.snapshot.open, overtaken: true });
          return;
        }
        if (body.replaceId) desk.replaceSlot(body.replaceId, session.id);
        else if (body.beside) desk.add(session.id);
        else desk.replace(session.id);
        try {
          followOpenSessions();
        } catch {
          // The opened copy still shows if the session log cannot be read.
        }
        publish({ open: presentedOpen(), cwd: builder ? next : store.snapshot.cwd, ...catalogSnapshot(), ...activity(), error: null });
        sendJson(res, 200, { open: store.snapshot.open });
      },
    }),
    route({
      method: "POST",
      // Continues a chat whose folder is gone: in a new worktree of its checkout, in that checkout, or in a folder.
      path: "/api/relocate",
      body: SessionBody.extend({ to: z.enum(["worktree", "checkout", "folder"]), cwd: Cwd }),
      handle: onDesk(async ({ res, body, sessionId }) => {
        const gone = store.goneFolders.get(sessionId);
        if (!gone) {
          sendJson(res, 400, { error: "This chat's folder is still there" });
          return;
        }
        if (holderOf(sessionId).getSession(sessionId)?.status === "running") {
          sendJson(res, 409, { error: "Wait for the turn to end before the chat moves" });
          return;
        }
        const { to } = body;
        if (to !== "folder" && !(gone.home && isDirectory(gone.home))) {
          sendJson(res, 400, { error: "The checkout this worktree came from is gone too" });
          return;
        }
        if (to === "folder" && !isDirectory(path.resolve(body.cwd))) {
          sendJson(res, 400, { error: "Folder does not exist" });
          return;
        }
        const provider = holderOf(sessionId);
        let next = to === "folder" ? canonicalCwd(path.resolve(body.cwd)) : String(gone.home);
        try {
          if (to === "worktree") {
            const gitRef = await latestMain(next).catch(() => "HEAD");
            const listed = store.snapshot.projects.flatMap((project) => project.sessions).find((session) => session.id === sessionId);
            next = (await createWorktree(next, gitRef, provider.id, { name: listed?.title || providers.catalogTitle(sessionId) || "" })).path;
          }
          await ensureProvider(provider);
          // The harness loads a session once, so it lets go of the copy in the stand-in folder first.
          await provider.forgetSession(sessionId);
          provider.moveSession?.(sessionId, next);
          const session = await provider.loadSession(sessionId, next, { rules: sessionRules(next) });
          if (!session) throw new Error("Session did not load");
          store.goneFolders.delete(sessionId);
          providers.remember(session, provider);
        } catch (error) {
          // The chat stays readable, with its card, so the person can try again. A failed load can leave a partial copy.
          await provider.forgetSession(sessionId).catch(() => {});
          await openToRead(provider, sessionId, gone).catch(() => null);
          publish({ open: presentedOpen(), ...catalogSnapshot() });
          sendJson(res, 400, { error: messageOf(error) || "The chat could not move" });
          return;
        }
        changeSidebar((state) => showProject(state, sidebarHome(next)));
        publish({ open: presentedOpen(), cwd: next, sessions: safeSessions(next), ...catalogSnapshot(), ...activity(), error: null });
        sendJson(res, 200, { cwd: next });
      }),
    }),
    route({
      method: "POST",
      path: "/api/delete",
      body: z.object({ sessionId: SessionId, worktree: z.boolean().optional(), discard: z.boolean().optional() }),
      async handle({ res, body }) {
        const { sessionId } = body;
        const listed = [...store.snapshot.projects.flatMap((project) => project.sessions), ...store.snapshot.chats].find((session) => session.id === sessionId);
        const worktreeRoot = canonicalCwd(paths.worktrees);
        // A routine run stays out of the sidebar, so its record names its worktree.
        const worktree = body.worktree !== true ? null : listed?.ownWorktree ? appWorktreeOf(listed.cwd, worktreeRoot) : host.routines.worktreeOf(sessionId);
        const changes = worktree && !body.discard ? await worktreeChanges(worktree, sessionId, host.chatRows(), worktreeRoot) : null;
        if (changes) {
          sendJson(res, 200, { changes });
          return;
        }
        // A switch still running would write the chat back. It stops first, or finishes if it is past undoing, and
        // the messages held for it go nowhere.
        const run = store.switching.get(sessionId);
        if (run) {
          run.held.length = 0;
          if (!run.view.committing) cancelSwitch(sessionId, run);
          await run.done?.catch(() => {});
        }
        const provider = holderOf(sessionId);
        const liveHarness = providers.ids.toHarness(sessionId);
        const earlier = [...new Map((chatRecords.get(sessionId)?.stretches ?? []).map((stretch) => [stretch.harnessId, stretch])).values()].filter(
          (stretch) => stretch.harnessId !== liveHarness,
        );
        // What the harness could not delete of its own copy. The session still leaves the app.
        let kept = "";
        try {
          // The sessions a switched chat ran on before go with it.
          for (const stretch of earlier) {
            const harness = providers.harness(stretch.provider);
            const view = providers.get(stretch.provider);
            if (!harness || !view) continue;
            try {
              if (harness.deleteSession) await deleteOwnCopy(view, harness, stretch.harnessId);
              if (harness.getSession(stretch.harnessId)) await harness.forgetSession(stretch.harnessId);
            } catch (error) {
              kept = `${view.label} could not delete its own copy of the session: ${messageOf(error)}`;
            }
          }
          await stopWork(provider, sessionId);
          // A harness that stores its own sessions deletes a live one itself, before the app lets go of it.
          if (provider.deleteSession) {
            try {
              await deleteOwnCopy(provider, provider, sessionId);
            } catch (error) {
              kept = `${provider.label} could not delete its own copy of the session: ${messageOf(error)}`;
            }
          }
          if (provider.getSession(sessionId) || provider.catalog.has(sessionId)) {
            await provider.forgetSession(sessionId);
          }
          for (const harnessId of [liveHarness, ...earlier.map((stretch) => stretch.harnessId)]) fs.rmSync(ownBtwDir(harnessId, paths.btw), { recursive: true, force: true });
          providers.index.drop(sessionId);
          chatRecords.drop(sessionId);
        } catch (error) {
          publish({ open: presentedOpen(), ...catalogSnapshot(), ...activity(), error: messageOf(error) });
          sendJson(res, 500, { error: messageOf(error) });
          return;
        }
        store.deletedIds.add(sessionId);
        store.goneFolders.delete(sessionId);
        surfaces.drop(sessionId);
        store.unreadIds.delete(sessionId);
        store.runningIds.delete(sessionId);
        store.mentions.delete(sessionId);
        host.hostTools.forget(sessionId);
        host.browser.forget(sessionId);
        host.terminals.endSession(sessionId);
        try {
          host.suggestions.dropSession(sessionId);
        } catch {
          // A suggestions file that does not read keeps the entry. The session is gone either way.
        }
        // Another chat can start in the worktree while the harness deletes this one.
        if (worktree) kept = [kept, await removeChatWorktree(worktree, sessionId, host.chatRows(), worktreeRoot, body.discard)].filter(Boolean).join(" ");
        host.routines.sessionDeleted(sessionId);
        changeSidebar((state) => dropSession(state, sessionId));
        const tickets = readTickets(paths.tickets);
        const remaining = dropSessionLinks(tickets, sessionId);
        if (remaining.links.length !== tickets.links.length) writeTickets(remaining, paths.tickets);
        publish({
          open: presentedOpen(),
          sessions: safeSessions(store.snapshot.cwd),
          ...catalogSnapshot(),
          ...activity(),
          error: kept || null,
        });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/leave",
      body: z.object({ sessionId: SessionId.optional() }),
      handle({ res, body }) {
        if (body.sessionId) {
          desk.remove(body.sessionId);
          store.mentions.delete(body.sessionId);
        } else {
          desk.clear();
          store.mentions.clear();
        }
        publish({ open: presentedOpen(), sessions: safeSessions(store.snapshot.cwd), ...activity() });
        sendJson(res, 200, { ok: true });
      },
    }),
    {
      method: "GET",
      path: "/api/btw",
      handle: withSession(({ res, sessionId, provider }) => {
        sendJson(res, 200, { entries: provider.sideHistory?.(sessionId) ?? [] });
      }),
    },
    {
      method: "DELETE",
      path: "/api/btw",
      handle: withSession(({ res, sessionId, provider }) => {
        provider.clearSideHistory?.(sessionId);
        sendJson(res, 200, { entries: [] });
      }),
    },
    route({
      method: "POST",
      path: "/api/btw",
      body: SessionBody.extend({ question: Text }),
      handle: withSession(async ({ res, body, sessionId, provider }) => {
        const question = body.question.trim();
        if (!question) {
          sendJson(res, 400, { error: "Ask a question first" });
          return;
        }
        if (!provider.sideQuestion) {
          sendJson(res, 400, { error: `${provider.label} has no side questions yet` });
          return;
        }
        try {
          sendJson(res, 200, await provider.sideQuestion(sessionId, question));
        } catch (error) {
          sendJson(res, 502, { error: messageOf(error) || "Side question failed" });
        }
      }),
    }),
    route({
      method: "POST",
      path: "/api/prompt",
      maxBody: MAX_PROMPT_BYTES,
      body: SessionBody.extend({ text: z.string().optional(), attachments: Attachments }),
      handle: onDeskOrUnsent(({ res, body, sessionId }) => {
        try {
          composePrompt(body.text, body.attachments);
        } catch (error) {
          sendJson(res, statusOf(error, 400), { error: messageOf(error) });
          return;
        }
        if (store.goneFolders.has(sessionId)) {
          sendJson(res, 409, { error: "This chat's folder is gone. Continue it in another folder first." });
          return;
        }
        // A message sent while the chat moves to another provider waits for the new model.
        const run = store.switching.get(sessionId);
        if (run) {
          run.held.push({ text: body.text, attachments: body.attachments });
          changeSidebar((state) => notePrompt(state, sessionId));
          publish({ open: presentedOpen(), ...catalogSnapshot() });
          sendJson(res, 202, { ok: true });
          return;
        }
        const provider = holderOf(sessionId);
        if (!providers.isEnabled(provider)) {
          sendJson(res, 409, { error: offMessage(provider) });
          return;
        }
        store.unsent.delete(sessionId);
        changeSidebar((state) => notePrompt(state, sessionId));
        publish({ ...catalogSnapshot(), ...activity() });
        sendJson(res, 202, { ok: true });
        void sendPrompt(sessionId, body.text, body.attachments);
      }),
    }),
    route({
      method: "POST",
      path: "/api/steer",
      maxBody: MAX_PROMPT_BYTES,
      body: SessionBody.extend({ text: Text, attachments: Attachments, at: z.enum(["now", "next"]).default("now") }),
      handle: onDesk(({ res, body, sessionId }) => {
        let hasFiles: boolean;
        try {
          hasFiles = composePrompt(body.text, body.attachments).attachments.length > 0;
        } catch (error) {
          sendJson(res, statusOf(error, 400), { error: messageOf(error) });
          return;
        }
        const text = body.text.trim();
        const attachments = body.attachments;
        const provider = holderOf(sessionId);
        if (!providers.isEnabled(provider)) {
          sendJson(res, 409, { error: offMessage(provider) });
          return;
        }
        changeSidebar((state) => notePrompt(state, sessionId));
        publish({ ...catalogSnapshot(), ...activity() });
        const current = provider.getSession(sessionId);
        if (current?.status !== "running") {
          sendJson(res, 202, { ok: true });
          ensureProvider(provider)
            .then(() => provider.prompt(sessionId, text, attachments).catch(sessionError(sessionId, provider)))
            .catch((error: unknown) => providerError(provider, error));
          return;
        }
        sendJson(res, 202, { ok: true });
        // A provider that cannot steer this message queues it behind the turn instead.
        const { capabilities } = provider;
        const steerable = capabilities.steer && (!hasFiles || capabilities.steerAttachments);
        const steered = provider.steer && steerable ? provider.steer(sessionId, text, { at: body.at, attachments }) : provider.followUp(sessionId, text, attachments);
        steered.catch(sessionError(sessionId, provider));
      }),
    }),
    route({
      method: "POST",
      path: "/api/steer/now",
      body: SessionBody.extend({ id: z.string() }),
      handle: onDesk(({ res, body, sessionId }) => {
        const provider = holderOf(sessionId);
        sendJson(res, 202, { ok: true });
        provider.sendSteerNow?.(sessionId, body.id).catch(sessionError(sessionId, provider));
      }),
    }),
    route({
      method: "POST",
      path: "/api/steer/remove",
      body: SessionBody.extend({ id: z.string() }),
      handle: onDesk(({ res, body, sessionId }) => {
        const provider = holderOf(sessionId);
        sendJson(res, 202, { ok: true });
        provider.removeSteer?.(sessionId, body.id).catch(sessionError(sessionId, provider));
      }),
    }),
    route({
      method: "POST",
      path: "/api/queue/edit",
      body: QueueBody.extend({ text: Text }),
      handle: onDesk(({ res, body, sessionId }) => {
        const text = body.text.trim();
        if (!text) {
          sendJson(res, 400, { error: "Write a prompt first" });
          return;
        }
        holderOf(sessionId).editQueued(sessionId, body.id, text, body.version ?? 0);
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/queue/send",
      body: SessionBody.extend({ id: z.string() }),
      handle: onDesk(async ({ res, body, sessionId }) => {
        const provider = holderOf(sessionId);
        if (!providers.isEnabled(provider)) {
          sendJson(res, 409, { error: offMessage(provider) });
          return;
        }
        await provider.sendQueuedNow(sessionId, body.id);
        publish({ open: presentedOpen() });
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/queue/remove",
      body: QueueBody,
      handle: onDesk(({ res, body, sessionId }) => {
        holderOf(sessionId).removeQueued(sessionId, body.id, body.version ?? 0);
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/skills",
      body: z.object({ cwd: Cwd, provider: z.string().optional() }),
      handle({ res, body }) {
        const folder = body.cwd.trim();
        const known = folder && isDirectory(folder);
        sendJson(res, 200, {
          skills: known ? listFolderSkills(folder) : [],
          // What the provider's harness reported last, for a new chat that has no session yet.
          commands: known && body.provider ? harnessCommands.read(body.provider, folder) : [],
        });
      },
    }),
    route({
      method: "POST",
      path: "/api/mentions",
      body: SessionBody.extend({ query: Text, hidden: z.boolean().optional(), searchId: Text }),
      handle: withSession(async ({ res, body, sessionId, current }) => {
        const { query } = body;
        const hidden = Boolean(body.hidden);
        const searchId = body.searchId || `search-${Date.now().toString(36)}`;
        // Searches can finish out of order. Only the latest one, not closed since, shows its matches.
        const search = (store.mentionSearch.get(sessionId) ?? 0) + 1;
        store.mentionSearch.set(sessionId, search);
        const matches = await searchFolder(current.cwd, query, hidden).catch(() => []);
        if (store.mentionSearch.get(sessionId) === search) {
          store.mentions.set(sessionId, matches);
          publish({ open: presentedOpen() });
        }
        sendJson(res, 200, { searchId, matches });
      }),
    }),
    route({
      method: "POST",
      path: "/api/mentions/close",
      body: SessionBody,
      async handle({ res, body }) {
        const { sessionId } = body;
        store.mentionSearch.set(sessionId, (store.mentionSearch.get(sessionId) ?? 0) + 1);
        if (store.mentions.delete(sessionId) && desk.has(sessionId)) publish({ open: presentedOpen() });
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/plan",
      body: SessionBody.extend({ outcome: z.string() }),
      handle: onDeskOrWaiting(({ res, body, sessionId }) => {
        const provider = holderOf(sessionId);
        if (!provider.answerPlan) {
          sendJson(res, 400, { error: "No plan is waiting" });
          return;
        }
        provider.answerPlan(sessionId, body.outcome);
        publish({ open: presentedOpen(), ...activity() });
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/permission",
      body: SessionBody.extend({ optionId: z.string(), id: RequestId.optional() }),
      handle: onDeskOrWaiting(({ res, body, sessionId }) => {
        const { optionId } = body;
        if (!host.browser.answer(sessionId, optionId)) {
          const pending = holderOf(sessionId).getSession(sessionId)?.pendingPermission;
          if (!pending || String(pending.rpcId) !== String(body.id)) {
            sendJson(res, 409, { error: "That request is no longer waiting" });
            return;
          }
          holderOf(sessionId).answerPermission(sessionId, optionId);
        }
        publish({ open: presentedOpen(), ...activity() });
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/question",
      body: SessionBody.extend({ id: RequestId, action: z.string(), content: FormAnswers.optional() }),
      handle: onDeskOrWaiting(({ res, body, sessionId }) => {
        const pending = holderOf(sessionId).getSession(sessionId)?.pendingElicitation;
        if (!pending || String(pending.rpcId) !== String(body.id)) {
          sendJson(res, 409, { error: "That question is no longer waiting" });
          return;
        }
        holderOf(sessionId).answerElicitation(sessionId, body.action, body.content);
        publish({ open: presentedOpen(), ...activity() });
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/cancel",
      body: SessionBody,
      handle({ res, body }) {
        const { sessionId } = body;
        const provider = holderOf(sessionId);
        host.browser.cancel(sessionId);
        if (desk.has(sessionId) && provider.getSession(sessionId)) provider.cancel(sessionId);
        sendJson(res, 200, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/warm",
      body: z.object({ provider: z.string().optional() }),
      // A draft is about to send: start its provider now, so the first message does not wait for it.
      handle({ res, body }) {
        const provider = body.provider ? providers.get(body.provider) : providers.defaultProvider();
        if (!provider) {
          sendJson(res, 400, { error: "Unknown provider" });
          return;
        }
        const waiting = provider.status === "idle" || provider.status === "failed" || provider.status === "stopped";
        if (waiting && providers.isEnabled(provider)) ensureProvider(provider).catch(() => {});
        sendJson(res, 202, { ok: true });
      },
    }),
    route({
      method: "POST",
      path: "/api/task/stop",
      body: SessionBody.extend({ taskId: z.string() }),
      // A background task the provider can stop on its own is stopped. Anything else in the task
      // panel (a subagent, a Grok task) ends with the turn, as the panel did before.
      handle: onDesk(async ({ res, body, sessionId }) => {
        const provider = holderOf(sessionId);
        const { taskId } = body;
        const background = provider.getSession(sessionId)?.backgroundTasks.some((task) => task.id === taskId);
        if (background && provider.stopTask) await provider.stopTask(sessionId, taskId);
        else if (provider.getSession(sessionId)) provider.cancel(sessionId);
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/switch/preview",
      body: SwitchBody,
      handle: onDesk(({ res, body, sessionId }) => {
        try {
          sendJson(res, 200, previewSwitch(switchDeps, switchRequest(sessionId, body)));
        } catch (error) {
          sendJson(res, statusOf(error, 500), { error: messageOf(error) });
        }
      }),
    }),
    route({
      method: "POST",
      path: "/api/switch",
      body: SwitchBody,
      handle: onDesk(({ res, body, sessionId }) => {
        const request = switchRequest(sessionId, body);
        if (store.switching.has(sessionId)) {
          sendJson(res, 409, { error: "This chat is already moving to another model." });
          return;
        }
        let preview;
        try {
          preview = previewSwitch(switchDeps, request);
        } catch (error) {
          sendJson(res, statusOf(error, 500), { error: messageOf(error) });
          return;
        }
        const target = providers.get(request.provider)!;
        const run: SwitchRun = {
          view: {
            from: holderOf(sessionId).id,
            fromModel: preview.from,
            to: target.id,
            toModel: preview.to,
            startedAt: Date.now(),
            summarizing: false,
            committing: false,
          },
          at: providers.getSession(sessionId)?.transcript.length ?? 0,
          cancelled: false,
          held: [],
        };
        store.switching.set(sessionId, run);
        publish({ open: presentedOpen() });
        sendJson(res, 202, { ok: true });
        const control = {
          summarizing() {
            run.view = { ...run.view, summarizing: true };
            publish({ open: presentedOpen() });
          },
          committing() {
            run.view = { ...run.view, committing: true };
            publish({ open: presentedOpen() });
          },
          get cancelled() {
            return run.cancelled;
          },
        };
        // The run stays until its held messages are out, so one sent meanwhile still waits its turn behind them.
        run.done = switchChat(switchDeps, request, control)
          .then(
            async () => {
              run.settled = true;
              clearSessionError(sessionId);
              publish({ open: presentedOpen(), sessions: safeSessions(store.snapshot.cwd), ...catalogSnapshot(), ...activity(), error: null });
              await sendHeld(sessionId, run);
            },
            async (error: unknown) => {
              run.settled = true;
              await sendHeld(sessionId, run);
              if (!(error instanceof SwitchCancelled)) sessionError(sessionId, target)(error);
              publish({ open: presentedOpen(), ...activity() });
            },
          )
          .finally(() => store.switching.delete(sessionId));
      }),
    }),
    route({
      method: "POST",
      path: "/api/switch/cancel",
      body: SessionBody,
      handle: onDesk(({ res, sessionId }) => {
        const run = store.switching.get(sessionId);
        if (!run) {
          sendJson(res, 409, { error: "This chat is not moving to another model." });
          return;
        }
        if (run.view.committing) {
          sendJson(res, 409, { error: `${providers.get(run.view.to)?.label ?? "The new model"} is about to continue this chat.` });
          return;
        }
        cancelSwitch(sessionId, run);
        sendJson(res, 202, { ok: true });
      }),
    }),
    {
      method: "GET",
      path: "/api/handoff",
      handle: onDesk(({ res, url, sessionId }) => {
        const text = chatRecords.get(sessionId)?.handoffs[url.searchParams.get("stretch") || ""];
        if (text === undefined) {
          sendJson(res, 404, { error: "Nothing was handed over there" });
          return;
        }
        sendJson(res, 200, { text });
      }),
    },
    route({
      method: "POST",
      path: "/api/mode",
      body: SessionBody.extend({ modeId: z.string() }),
      handle: onDesk(async ({ res, body, sessionId }) => {
        const modeId = body.modeId;
        const provider = holderOf(sessionId);
        if (!isMode(modeId) || !provider.modes.some((choice) => choice.id === modeId)) {
          sendJson(res, 400, { error: "Unknown approval mode" });
          return;
        }
        await provider.setMode(sessionId, modeId);
        publish({ open: presentedOpen() });
        sendJson(res, 200, { ok: true });
      }),
    }),
    route({
      method: "POST",
      path: "/api/config",
      body: SessionBody.extend({ configId: z.string(), value: z.string() }),
      handle: onDesk(async ({ res, body, sessionId }) => {
        await holderOf(sessionId).setConfig(sessionId, body.configId, body.value);
        publish({ open: presentedOpen() });
        sendJson(res, 200, { open: store.snapshot.open });
      }),
    }),
  ];
}

// One compressor for the page's whole stream: a 16 MB window still holds the previous snapshot, so a
// change costs about its own size. Each event is flushed so it reaches the page at once.
function brotliPage(res: ServerResponse) {
  const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_LGWIN, BROTLI_PARAM_MODE, BROTLI_MODE_TEXT } = zlib.constants;
  const compressor = zlib.createBrotliCompress({
    params: { [BROTLI_PARAM_QUALITY]: 5, [BROTLI_PARAM_LGWIN]: 24, [BROTLI_PARAM_MODE]: BROTLI_MODE_TEXT },
  });
  compressor.on("error", () => res.destroy());
  compressor.pipe(res);
  res.on("close", () => compressor.destroy());
  return {
    write(chunk: string) {
      if (compressor.destroyed) return;
      compressor.write(chunk);
      compressor.flush();
    },
  };
}
