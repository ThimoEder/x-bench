import type { DragEvent as ReactDragEvent } from "react";
import type { TaskStart } from "../../server/board/taskStart.ts";
import type { TaskSuggestion } from "../../server/snapshot.ts";
import { boardFolder, projectFolder } from "../board/suggestedTask.ts";
import { useDesk } from "../deskContext.ts";
import { deskReply, slotOf, type Opening, type ShownSession } from "../dock/deskView.ts";
import { PaneBoundary } from "../dock/PaneBoundary.tsx";
import { remotePage } from "../launchToken.ts";
import { ServiceNotices } from "../ServiceNotices.tsx";
import { TerminalPanel } from "../terminal/TerminalPanel.tsx";
import { openTerminalLink, type TerminalPlace } from "../terminal/terminalPlace.ts";
import type { Layout } from "../useLayout.ts";
import type { PageSnapshot } from "../useSnapshot.ts";
import { catalogFor } from "./composer/draftConfig.ts";
import { Transcript, type TranscriptSession } from "./Transcript.tsx";
import type { useDraftSession } from "./useDraftSession.ts";

export interface DeskPanesProps {
  snapshot: PageSnapshot;
  chatting: boolean;
  // A page lies over the desk, which stays mounted under it.
  covered: boolean;
  draft: ReturnType<typeof useDraftSession>;
  sessions: ShownSession[];
  focusId: string | undefined;
  layout: Layout;
  terminalShown: (sessionId: string) => boolean;
  moveTerminal: (sessionId: string, to: TerminalPlace) => void;
  opening: Opening<ShownSession> | null;
  setFocusId: (sessionId: string) => void;
  leave: () => void;
  openChat: (sessionId: string, cwd: string | null, place: Opening<ShownSession>["place"]) => void;
  onRoutine: (session: TranscriptSession, prompt: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function DeskPanes({ snapshot, chatting, covered, draft, sessions, focusId, layout, terminalShown, moveTerminal, opening, setFocusId, leave, openChat, onRoutine }: DeskPanesProps) {
  const { call, notices, dismissNotice, toggleTerminal } = useDesk();
  const { splitRatio, setSplitRatio, dragging, beginResize, onSeparatorKey, terminalPlace, terminalHeight, setTerminalHeight } = layout;
  const [firstOpen, secondOpen] = sessions;
  const focus = sessions.find((session) => session.id === focusId);
  const below = focus && !focus.loading && !focus.folderGone && !remotePage() && !chatting && !covered && terminalShown(focus.id) && terminalPlace === "bottom" ? focus : null;

  function dropSession(pane: TranscriptSession, event: ReactDragEvent<HTMLElement>) {
    const raw = event.dataTransfer.getData("application/x-grok-session");
    if (!raw) return;
    event.preventDefault();
    leave();
    const item: unknown = JSON.parse(raw);
    if (!isRecord(item)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nearEdge = event.clientX > rect.left + rect.width * 0.62;
    const alreadyOpen = snapshot.open.some((session) => session.id === item.id);
    if (typeof item.id !== "string" || typeof item.cwd !== "string") return;
    if (snapshot.surface !== "chat" && nearEdge && snapshot.open.length < 2 && !alreadyOpen) {
      openChat(item.id, item.cwd, "beside");
      return;
    }
    openChat(item.id, item.cwd, slotOf(pane.id, opening));
  }

  async function openFolder(paneId: string, nextCwd: string | undefined) {
    leave();
    const existing = snapshot.open.find((session) => session.cwd === nextCwd);
    if (existing) {
      setFocusId(existing.id);
      return;
    }
    const beside = snapshot.open.length < 2;
    const data = deskReply(await call(
      "/api/session",
      beside ? { cwd: nextCwd, beside: true } : { cwd: nextCwd, replaceId: paneId },
    ));
    const opened = (data.open || []).find((session) => session.cwd === nextCwd) || data.open?.at?.(-1);
    if (opened?.id) setFocusId(opened.id);
  }

  async function startSuggestedTask(session: TranscriptSession, suggestion: TaskSuggestion, where: TaskStart) {
    const cwd = where === "folder" ? session.cwd : projectFolder(session, snapshot.projects, snapshot.routines.list);
    await call("/api/suggestions/start", { sessionId: session.id, id: suggestion.id, cwd, where });
  }

  function renderPane(session: TranscriptSession, { solo, canSplit, hotkey }: { solo: boolean; canSplit: boolean; hotkey: boolean }) {
    const paneProps = session === draft.session ? draft.paneProps : {
      catalog: catalogFor({ composer: snapshot.composer, providers: snapshot.providers }),
      live: snapshot.working.includes(session.id),
      onFocus: setFocusId,
      onDropSession: dropSession,
      shells: snapshot.terminals[session.id],
      terminalOpen: terminalShown(session.id),
      onOpenFolder: openFolder,
      taskBoard: boardFolder(session, snapshot.tickets, snapshot.projects, snapshot.routines.list),
      onStartTask: startSuggestedTask,
    };
    return (
      <PaneBoundary key={session.id} label="This session">
        <Transcript
          {...paneProps}
          providers={snapshot.providers}
          session={session}
          solo={solo}
          canSplit={canSplit}
          plain={chatting}
          hotkey={hotkey}
          seed={draft.seed}
          onSeedApplied={draft.clearSeed}
          focusComposerId={draft.focusComposerId}
          focusTick={draft.focusTick}
          onRoutine={onRoutine}
        />
      </PaneBoundary>
    );
  }

  return (
    <>
      <div className="desk-layer" hidden={covered || undefined} inert={covered ? true : undefined}>
        {draft.session ? (
          <div className="desk">
            {renderPane(draft.session, { solo: true, canSplit: false, hotkey: true })}
          </div>
        ) : sessions.length ? (
          <div className={sessions.length > 1 ? "desk two" : "desk"}>
            {sessions.length > 1 && firstOpen && secondOpen ? (
              <>
                <div className="pane-slot" style={{ flex: `${splitRatio} 1 0` }}>
                  {renderPane(firstOpen, { solo: false, canSplit: false, hotkey: firstOpen.id === focusId })}
                </div>
                <div
                  className={dragging === "split" ? "splitter is-dragging" : "splitter"}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize sessions"
                  aria-valuemin={28}
                  aria-valuemax={72}
                  aria-valuenow={Math.round(splitRatio * 100)}
                  tabIndex={0}
                  onPointerDown={(event) => beginResize(event, "split")}
                  onKeyDown={(event) => onSeparatorKey("split", event)}
                  onDoubleClick={() => setSplitRatio(0.5)}
                />
                <div className="pane-slot" style={{ flex: `${1 - splitRatio} 1 0` }}>
                  {renderPane(secondOpen, { solo: false, canSplit: false, hotkey: secondOpen.id === focusId })}
                </div>
              </>
            ) : firstOpen ? (
              // The same tree as a split, so opening a second chat keeps this pane mounted.
              <>
                <div className="pane-slot" style={{ flex: "1 1 0" }}>
                  {renderPane(firstOpen, { solo: true, canSplit: !chatting, hotkey: true })}
                </div>
              </>
            ) : null}
          </div>
        ) : chatting ? (
          <div className="welcome">
            <h1>What should we talk about?</h1>
            <p className="lede">Start a chat, or pick one from the sidebar.</p>
            <ServiceNotices notices={notices} onDismiss={dismissNotice} />
            <button className="primary" type="button" disabled={draft.busy} onClick={() => draft.startChat()}>
              New chat
            </button>
          </div>
        ) : null}
      </div>
      {below ? (
        <PaneBoundary resetKey={below.id} label="The terminal">
          <TerminalPanel
            sessionId={below.id}
            cwd={below.cwd}
            shells={snapshot.terminals[below.id] ?? []}
            call={(path, body) => call(path, { sessionId: below.id, ...body })}
            height={terminalHeight}
            onHeight={setTerminalHeight}
            onMove={() => moveTerminal(below.id, "dock")}
            onHide={() => toggleTerminal(below.id)}
            onLink={(event, uri) => openTerminalLink(event, uri, below.id, snapshot.browser.available)}
          />
        </PaneBoundary>
      ) : null}
    </>
  );
}
