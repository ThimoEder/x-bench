import { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch } from "react";
import type { SidebarProject, SidebarSession, Surface, TicketLink } from "../server/snapshot.ts";
import type { Opening, ShownSession } from "./dock/deskView.ts";
import { DESK, ROUTINES, type NavAction, type Page, type View } from "./navigation.ts";
import type { RoutineSeed } from "./routines/routineForm.ts";
import type { SettingsTab } from "./settings/Settings.tsx";
import type { chatOpener } from "./sidebar/chatOpener.ts";
import type { PageSnapshot } from "./useSnapshot.ts";

interface DeskActionOptions {
  snapshot: PageSnapshot;
  ready: boolean;
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  clearNotice: () => void;
  view: View;
  navigate: Dispatch<NavAction>;
  opener: ReturnType<typeof chatOpener>;
  dropDraft: () => void;
  forgetBoardSite: () => void;
  setFocusId: (sessionId: string) => void;
  requestSurface: (mode: Surface) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function useDeskActions({ snapshot, ready, call, clearNotice, view, navigate, opener, dropDraft, forgetBoardSite, setFocusId, requestSurface }: DeskActionOptions) {
  const [createBoard, setCreateBoard] = useState<Pick<SidebarProject, "cwd" | "name"> | null>(null);
  const [routineSeed, setRoutineSeed] = useState<RoutineSeed | null>(null);
  // The reveal the page last acted on, so a snapshot that repeats it does not open the run again.
  const revealed = useRef<number | null>(null);

  // Going to a page drops the draft and any chat still opening. Leaving one for the desk keeps them.
  function go(to: Page, settingsAtStart?: SettingsTab | null) {
    navigate({ type: "go", to, settingsAtStart });
    dropDraft();
    opener.cancel();
  }
  const leave = () => navigate({ type: "leave" });

  const showSettingsTab = useCallback((tab: SettingsTab | null) => navigate({ type: "settings", tab }), [navigate]);
  const closeSettings = useCallback(() => navigate({ type: "settings", tab: null }), [navigate]);
  const selectTask = useCallback((taskId: unknown) => navigate({ type: "task", taskId }), [navigate]);

  function showSettings(tab: SettingsTab = "general") {
    setCreateBoard(null);
    showSettingsTab(tab);
  }

  function showRoutines(seed: RoutineSeed | null = null) {
    go(ROUTINES);
    setCreateBoard(null);
    if (seed) setRoutineSeed(seed);
  }

  function selectSurface(mode: Surface) {
    if (mode !== "builder" && mode !== "chat") return undefined;
    go(DESK);
    return requestSurface(mode);
  }

  // Opens a routine's run, from its page or its notification: on the surface its chat belongs to.
  // The page stays on Routines until the run has loaded, so a run that cannot open is never mistaken for the chat
  // behind the page.
  async function openRun(sessionId: string, cwd: string, chat: boolean) {
    const surface = chat ? "chat" : "builder";
    const settingsAtStart = view.settings;
    // The surface switch cancels opens in progress at once, so the claim comes after it starts.
    const switching = surface !== snapshot.surface ? selectSurface(surface) : undefined;
    // The switch closes Routines, which stays up over the other surface until the run has loaded.
    if (switching) navigate({ type: "go", to: ROUTINES });
    const current = opener.claim();
    try {
      await switching;
      if (!current()) return;
      const loaded = await call("/api/load", { sessionId, cwd });
      if (!current()) return;
      if (isRecord(loaded) && loaded.overtaken) throw new Error("overtaken");
    } catch {
      // The banner says why.
      if (current()) navigate({ type: "go", to: ROUTINES, settingsAtStart });
      return;
    }
    // Settings opened while the run loaded stay open.
    go(DESK, settingsAtStart);
    setFocusId(sessionId);
  }

  const openRevealed = useEffectEvent(openRun);
  useEffect(() => {
    const reveal = snapshot.reveal;
    if (!ready || !reveal || revealed.current === reveal.nonce) return;
    revealed.current = reveal.nonce;
    // A page that opens long after the click leaves it.
    if (Date.now() - reveal.at > 15_000) return;
    openRevealed(reveal.sessionId, reveal.cwd, reveal.chat).catch(() => {});
  }, [ready, snapshot.reveal]);

  // Switches to the chat at once. Until the host has loaded it, the pane shows the chat's stored copy where the
  // host keeps one, else a skeleton. A failed load leaves the desk as it was.
  function openChat(sessionId: string, cwd: string | null, place: Opening<ShownSession>["place"] = "replace") {
    const listed = [...snapshot.chats, ...snapshot.projects.flatMap((project) => project.sessions)].find((row) => row.id === sessionId);
    clearNotice();
    setFocusId(sessionId);
    opener.open({ id: sessionId, cwd: cwd || listed?.cwd || "", title: listed?.title, provider: listed?.provider }, cwd, place);
  }

  function openSession(session: SidebarSession) {
    go(DESK);
    openChat(session.id, session.cwd);
  }

  function openLinkedSession(sessionId: string) {
    const folder = view.page === "board" ? view.cwd : null;
    leave();
    openChat(sessionId, folder);
  }

  function openProject(cwd: string, taskId: TicketLink["taskId"] | null = null) {
    go({ page: "board", cwd, taskId: taskId || null });
    forgetBoardSite();
  }

  async function removeBoard(project: SidebarProject) {
    await call("/api/board/boards", { cwd: project.cwd }, "DELETE");
    navigate({ type: "leave", board: project.cwd });
  }

  return {
    go, leave, showSettings, showSettingsTab, closeSettings, selectTask, showRoutines, selectSurface, openRun,
    openChat, openSession, openLinkedSession, openProject, removeBoard,
    createBoard, setCreateBoard, routineSeed, clearRoutineSeed: () => setRoutineSeed(null),
  };
}
