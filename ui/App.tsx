import { useEffect, useMemo, useRef, useState } from "react";
import type { SidebarProject, SidebarSession } from "../server/snapshot.ts";
import { AboutButton } from "./about/About.tsx";
import { CreateBoard } from "./board/CreateBoard.tsx";
import { BoardPage } from "./board/BoardPage.tsx";
import { useBoardSite } from "./board/useBoardSite.ts";
import { DeskPanes } from "./chat/DeskPanes.tsx";
import { catalogFor } from "./chat/composer/draftConfig.ts";
import { usePickMemory } from "./chat/composer/usePickMemory.ts";
import { useDraftSession } from "./chat/useDraftSession.ts";
import { DeskContext, type Desk } from "./deskContext.ts";
import { IdleRail } from "./dock/Dock.tsx";
import { DockSlot } from "./dock/DockSlot.tsx";
import { deskWithOpening, sessionsForDesk, withFirstMessage, type ShownSession } from "./dock/deskView.ts";
import { PaneBoundary } from "./dock/PaneBoundary.tsx";
import { useDock } from "./dock/useDock.ts";
import { remotePage } from "./launchToken.ts";
import { useNavigation } from "./navigation.ts";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { dropTapsOnRoot } from "./phone/sheetTaps.ts";
import { usePanelDrags } from "./phone/usePanelDrags.ts";
import { Routines } from "./routines/Routines.tsx";
import { composerRoutine } from "./routines/routineLink.ts";
import { useNotices } from "./ServiceNotices.tsx";
import { Settings } from "./settings/Settings.tsx";
import { useChatOpener } from "./sidebar/chatOpener.ts";
import { SidebarColumn } from "./sidebar/SidebarColumn.tsx";
import { useCall } from "./useCall.ts";
import { useDeskActions } from "./useDeskActions.ts";
import { useLayout } from "./useLayout.ts";
import { useMediaMatch } from "./useMediaMatch.ts";
import { usePresence } from "./usePresence.ts";
import { useSnapshot } from "./useSnapshot.ts";
import { SpeechModel } from "./voice/SpeechModel.tsx";
import { WorkspaceBar } from "./WorkspaceBar.tsx";

const NO_IDS: readonly string[] = [];

function withSidebarRow<T extends ShownSession>(
  session: T,
  projects: readonly SidebarProject[] | null | undefined,
  chats: readonly SidebarSession[] | null | undefined,
): T {
  if (!session) return session;
  const row = [...(chats ?? []), ...(projects ?? []).flatMap((project) => project.sessions)].find((item) => item.id === session.id);
  const title = row?.title || session.title;
  return title === session.title && row?.archived === session.archived ? session : { ...session, title, archived: row?.archived };
}

export function App() {
  const { call, notice, setNotice, clearNotice } = useCall();
  const { snapshot, ready, live, onboarded, markOnboarded, switching, chatting, requestSurface } = useSnapshot(call);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [railHost, setRailHost] = useState<HTMLDivElement | null>(null);
  // A phone shows the dock full screen, with its rail inside.
  const phone = useMediaMatch("(max-width: 640px)");
  const remote = remotePage();
  const [view, navigate] = useNavigation((page) => actions.go(page));
  const boardCwd = view.page === "board" ? view.cwd : null;
  const boardSite = useBoardSite(call, boardCwd);
  const { notices, dismissNotice } = useNotices(snapshot.notices);
  const { opening, opener } = useChatOpener(call, setNotice, snapshot.open);
  const memory = usePickMemory(snapshot.open, focusId);
  const hostDesk = switching ? [] : deskWithOpening<ShownSession>(snapshot.open, opening);
  const draft = useDraftSession({
    snapshot, call, memory, ready, setFocusId, leave: () => navigate({ type: "leave" }), cancelOpening: opener.cancel,
    landable: ready && !switching && !chatting && view.page === "desk" && !hostDesk.length,
  });
  const actions = useDeskActions({
    snapshot, ready, call, clearNotice, view, navigate, opener, dropDraft: draft.drop, forgetBoardSite: boardSite.forget, setFocusId, requestSurface,
  });
  const shown = <T extends ShownSession>(session: T) => withFirstMessage(withSidebarRow(session, snapshot.projects, snapshot.chats), draft.firstMessage);
  const openSessions = switching ? [] : sessionsForDesk<ShownSession>(hostDesk.map(shown), draft.handoff ? shown(draft.handoff) : null);
  const focus = draft.drafting ? null : (openSessions.find((session) => session.id === focusId) || openSessions[0] || null);
  const layout = useLayout(focus?.id ?? null, view.page === "board");
  const dock = useDock({
    layout, focusId, setFocusId, shownId: focus?.id ?? null, covered: view.page === "board", chatting,
    browserFocus: snapshot.browser?.focus, deviceFocus: snapshot.deviceFocus,
  });
  // While a chat opens, the sidebar marks the desk the page shows. Otherwise it marks the host's.
  const shownKey = opening ? openSessions.map((session) => session.id).join("\n") : "";
  const shownIds = useMemo(() => (shownKey ? shownKey.split("\n") : undefined), [shownKey]);
  const catalog = catalogFor({ composer: snapshot.composer, providers: snapshot.providers });
  const showingPage = view.page !== "desk";
  // The review dock is drawn for a focused builder pane while no page covers the desk.
  const dockVisible = Boolean(focus) && !chatting && !showingPage;
  // The dock stays on its last chat while it slides away, and comes in closed before it opens. The rail does the same
  // as Builder, the board and Routines come and go. A board drops them at once, so its heavy first render never runs during their slide.
  const dockPresence = usePresence(dockVisible, view.page === "board" ? 0 : 550);
  const railPresence = usePresence(!chatting && !phone && !showingPage, view.page === "board" ? 0 : 550);
  const lastDockFocus = useRef(focus);
  if (dockVisible) lastDockFocus.current = focus;
  const dockFocus = dockVisible ? focus : !phone && dockPresence.mounted ? lastDockFocus.current : null;
  const slotOpen = layout.dockOpen && (phone || dockPresence.shown);
  usePanelDrags(Boolean(view.settings), { open: layout.sidebarOpen, setOpen: layout.setSidebarOpen }, dockVisible ? { open: layout.dockOpen, setOpen: layout.setDockOpen } : null);
  useEffect(() => dropTapsOnRoot(), []);

  function finishOnboarding(chat: boolean) {
    markOnboarded();
    // A new session as the sidebar starts one: a chat in Chat, a draft that asks for its folder in Builder.
    if (chat && chatting) draft.startChat();
    else if (chat) draft.openDraft();
  }

  const desk: Desk = {
    call, notices, dismissNotice, tickets: snapshot.tickets, projects: snapshot.projects, platform: snapshot.platform,
    openFile: dock.openFile, openReview: dock.openReview, toggleTerminal: dock.toggleTerminal, openProject: actions.openProject,
    createBoard: actions.setCreateBoard,
  };

  if (!ready) {
    return (
      <div className="app">
        <p className="banner">Loading…</p>
      </div>
    );
  }

  const error = notice || snapshot.error;
  return (
    <DeskContext value={desk}>
      <div className="app">
        {!live ? <p className="banner">Reconnecting to the app…</p> : null}
        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}
        <div className={layout.dragging ? "shell dragging" : "shell"} inert={!onboarded}>
          <button
            type="button"
            className="scrim"
            aria-label="Close panels"
            hidden={!layout.sidebarOpen && !(layout.dockOpen && dockVisible)}
            onClick={() => {
              if (layout.sidebarOpen) layout.setSidebarOpen(false);
              else layout.setDockOpen(false);
            }}
          />
          <SidebarColumn
            snapshot={snapshot}
            busy={draft.busy}
            draftCwd={draft.draft?.cwd || ""}
            routinesOpen={view.page === "routines"}
            shownIds={draft.drafting ? NO_IDS : shownIds}
            phone={phone}
            layout={layout}
            actions={{ ...actions, openDraft: draft.openDraft, startChat: draft.startChat, createBoard: ({ cwd, name }) => actions.setCreateBoard({ cwd, name }), showRoutines: () => actions.showRoutines() }}
          />
          <div className={layout.reaching ? "workspace reaching" : "workspace"} ref={layout.observeWorkspace}>
            <div className="desk-column">
              <WorkspaceBar
                view={view}
                boardName={snapshot.projects.find((project) => project.cwd === boardCwd)?.name}
                draftCwd={draft.shownDraft?.cwd}
                drafting={draft.drafting}
                solo={!draft.drafting && openSessions.length === 1 ? openSessions[0] ?? null : null}
                chatting={chatting}
                context={showingPage ? null : focus?.context}
                boardLink={boardSite.boardLink}
                onOpenBoardSite={boardSite.openBoardSite}
                sidebarOpen={layout.sidebarOpen}
                onShowSidebar={() => layout.setSidebarOpen(true)}
                dock={phone && dockVisible ? { open: layout.dockOpen, toggle: () => layout.setDockOpen((open) => !open) } : null}
              />
              <DeskPanes
                snapshot={snapshot}
                chatting={chatting}
                covered={showingPage}
                draft={draft}
                sessions={openSessions}
                focusId={focus?.id}
                layout={layout}
                terminalShown={dock.terminalShown}
                moveTerminal={dock.moveTerminal}
                opening={opening}
                setFocusId={setFocusId}
                leave={actions.leave}
                openChat={actions.openChat}
                onRoutine={(session, prompt) => actions.showRoutines(composerRoutine(session, prompt, session.id === "draft" ? Boolean(draft.shownDraft?.chat) : chatting, snapshot.projects))}
              />
              {view.page === "board" ? (
                <BoardPage
                  cwd={view.cwd}
                  taskId={view.taskId}
                  snapshot={snapshot}
                  memory={memory}
                  site={boardSite}
                  onOpenSession={actions.openLinkedSession}
                  onSelect={actions.selectTask}
                />
              ) : null}
              {view.page === "routines" ? (
                <PaneBoundary label="Routines">
                  <Routines
                    routines={snapshot.routines}
                    app={snapshot.app}
                    projects={snapshot.projects || []}
                    catalog={catalog}
                    providers={snapshot.providers || []}
                    {...(snapshot.platform ? { platform: snapshot.platform } : {})}
                    call={call}
                    unread={snapshot.unread || []}
                    onOpenRun={(run, chat) => {
                      if (run.sessionId && run.cwd) actions.openRun(run.sessionId, run.cwd, chat).catch(() => {});
                    }}
                    seed={actions.routineSeed}
                    onSeedApplied={actions.clearRoutineSeed}
                  />
                </PaneBoundary>
              ) : null}
            </div>
            {dockFocus ? <DockSlot session={dockFocus} open={slotOpen} layout={layout} dock={dock} snapshot={snapshot} phone={phone} railHost={railHost} /> : null}
          </div>
          {railPresence.mounted ? (
            <div ref={setRailHost} className={railPresence.shown ? "rail-slot" : "rail-slot is-closed"} inert={railPresence.shown ? undefined : true}>
              {dockFocus ? null : <IdleRail browser={!remote && Boolean(snapshot.browser)} terminalInDock={!remote && layout.terminalPlace === "dock"} />}
              <span className="rail-foot">
                <AboutButton />
              </span>
            </div>
          ) : null}
        </div>
        {view.settings ? (
          <Settings
            tab={view.settings}
            call={call}
            providers={snapshot.providers}
            navWidth={layout.sidebarWidth}
            onTab={actions.showSettingsTab}
            onClose={actions.closeSettings}
            app={snapshot.app}
          />
        ) : null}
        <SpeechModel />
        {!onboarded ? (
          <Onboarding call={call} onDone={finishOnboarding} />
        ) : null}
        {actions.createBoard ? (
          <CreateBoard
            cwd={actions.createBoard.cwd}
            name={actions.createBoard.name}
            call={call}
            onClose={() => actions.setCreateBoard(null)}
            onSetup={() => actions.showSettings("boards")}
            onCreated={(cwd) => {
              actions.setCreateBoard(null);
              actions.openProject(cwd);
            }}
          />
        ) : null}
      </div>
    </DeskContext>
  );
}
