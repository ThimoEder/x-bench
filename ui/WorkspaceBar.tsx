import { useState } from "react";
import type { PresentedContext } from "../server/present.ts";
import type { OpenSession } from "../server/snapshot.ts";
import type { BoardSiteRequest } from "./board/BoardSite.tsx";
import { ExternalIcon } from "./board/boardIcons.tsx";
import type { BoardLink } from "./board/ProjectBoard.tsx";
import { TicketChips } from "./board/TicketCreate.tsx";
import { contextIsFull, contextLabel, formatContext } from "./chat/context.ts";
import { RevealTitle } from "./chat/RevealTitle.tsx";
import { useDesk } from "./deskContext.ts";
import type { View } from "./navigation.ts";
import { updateBridge, useWaitingUpdate } from "./updater/UpdateCard.tsx";

export interface WorkspaceBarProps {
  view: View;
  boardName: string | undefined;
  draftCwd: string | null | undefined;
  drafting: boolean;
  solo: Pick<OpenSession, "id" | "cwd" | "title"> | null;
  chatting: boolean;
  context: PresentedContext | null | undefined;
  boardLink: BoardLink | null;
  onOpenBoardSite: (request: BoardSiteRequest) => void;
  sidebarOpen: boolean;
  onShowSidebar: () => void;
  // The phone's review toggle, while the dock can show.
  dock: { open: boolean; toggle: () => void } | null;
}

export function WorkspaceBar({ view, boardName, draftCwd, drafting, solo, chatting, context, boardLink, onOpenBoardSite, sidebarOpen, onShowSidebar, dock }: WorkspaceBarProps) {
  const { tickets, openProject, call } = useDesk();
  const [updates] = useState(updateBridge);
  const waitingUpdate = useWaitingUpdate(updates);
  return (
    <div className={view.page === "board" ? "workspace-bar is-board" : "workspace-bar"}>
      <div className="bar-side">
        <button
          type="button"
          className={["icon sidebar-toggle", sidebarOpen ? "is-hidden" : "", waitingUpdate ? "has-update" : ""].filter(Boolean).join(" ")}
          aria-label={waitingUpdate ? `Show sidebar, X Bench ${waitingUpdate} is available` : "Show sidebar"}
          aria-hidden={sidebarOpen || undefined}
          tabIndex={sidebarOpen ? -1 : undefined}
          onClick={onShowSidebar}
        >
          <SidebarIcon />
        </button>
      </div>
      {view.page === "board" ? (
        <div className="bar-heading">
          <p className="bar-title" title={view.cwd}>
            Board
            {boardName ? <span className="bar-title-sub">{` · ${boardName}`}</span> : null}
          </p>
        </div>
      ) : view.page === "routines" || view.page === "needs" ? (
        <div className="bar-heading">
          <p className="bar-title">{view.page === "needs" ? "Needs you" : "Routines"}</p>
        </div>
      ) : drafting ? (
        <div className="bar-heading">
          <p className="bar-title" title={draftCwd || "Choose a folder"}>
            New session
          </p>
        </div>
      ) : solo ? (
        <div className="bar-heading">
          <TicketChips
            session={solo}
            tickets={tickets}
            onOpen={openProject}
            call={call}
          />
          <RevealTitle
            key={solo.id}
            as="p"
            className="bar-title"
            tooltip={chatting ? undefined : solo.cwd}
            text={solo.title || (chatting ? "New chat" : "New session")}
          />
        </div>
      ) : (
        <div className="bar-heading" />
      )}
      <div className="bar-side end">
        {context ? (
          <ContextMeter context={context} />
        ) : null}
        {view.page === "board" && boardLink ? (
          <a
            className="text-button board-open"
            href={boardLink.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!boardLink.signedIn) return;
              event.preventDefault();
              onOpenBoardSite({ taskId: null, href: boardLink.url, source: boardLink.source, title: boardName || "Board" });
            }}
          >
            <ExternalIcon />
            {`Open in ${boardLink.source}`}
          </a>
        ) : null}
        {dock ? (
          <button
            type="button"
            className="icon"
            aria-label={dock.open ? "Hide review panel" : "Show review panel"}
            title={dock.open ? "Hide review panel" : "Show review panel"}
            onClick={dock.toggle}
          >
            <SidebarIcon side="right" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ContextMeter({ context }: { context: PresentedContext }) {
  const full = contextIsFull(context);
  const label = contextLabel(context.used, context.size, full);
  return (
    <span
      className={full ? "context-meter is-full" : "context-meter"}
      data-testid="context-window"
      data-level={full ? "full" : undefined}
      title={label}
      aria-label={label}
    >
      {formatContext(context.used, context.size)}
    </span>
  );
}

function SidebarIcon({ side = "left" }: { side?: "left" | "right" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.2" y="3" width="13.6" height="12" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d={side === "right" ? "M11 3.2v11.6" : "M7 3.2v11.6"} stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
