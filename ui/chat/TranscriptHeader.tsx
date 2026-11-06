import { useState } from "react";
import type { ShellView } from "../../server/snapshot.ts";
import { RevealTitle } from "./RevealTitle.tsx";
import { TaskControl } from "../board/TaskControl.tsx";
import { TicketDone } from "../board/TicketDone.tsx";
import { TicketChips } from "../board/TicketCreate.tsx";
import { BranchMenu } from "../git/BranchMenu.tsx";
import type { WorktreePlan } from "../folder/draftWorktree.ts";
import { FolderMenu } from "../folder/FolderMenu.tsx";
import { ShelfDiff, TerminalToggle } from "../terminal/Terminal.tsx";
import { useDesk } from "../deskContext.ts";
import { ServiceNotices } from "../ServiceNotices.tsx";
import { PullChip, PullNotice, usePullRequest } from "../git/PullRequest.tsx";
import { CloseIcon } from "../icons.tsx";
import { PlanShelf } from "./PlanShelf.tsx";
import type { SessionCall, TranscriptSession } from "./Transcript.tsx";

export interface TranscriptHeaderProps {
  session: TranscriptSession;
  plain: boolean;
  act: SessionCall;
}

// The bar over a pane in a split desk: ticket chips, title, close.
export function TranscriptHeader({ session, plain, act }: TranscriptHeaderProps) {
  const { tickets, openProject, call } = useDesk();
  return (
    <header className="pane-bar">
      {plain ? null : <TicketChips session={session} tickets={tickets} onOpen={openProject} call={call} />}
      <RevealTitle
        key={session.id}
        as="p"
        className="pane-title"
        tooltip={plain ? undefined : session.cwd}
        text={session.title || (plain ? "New chat" : "New session")}
      />
      <button type="button" className="icon" aria-label="Close session" onClick={() => act("/api/leave")}>
        <CloseIcon />
      </button>
    </header>
  );
}

export interface SessionShelfProps {
  session: TranscriptSession;
  plain: boolean;
  drafting: boolean;
  running: boolean;
  act: SessionCall;
  onCwd?: (cwd: string | undefined) => void;
  onOpenFolder?: (sessionId: string, path: string | undefined) => void | Promise<unknown>;
  worktree?: WorktreePlan;
  onWorktree?: (plan: WorktreePlan) => void;
  // The session's shells, and whether the dock shows them.
  shells?: ShellView[];
  terminalOpen?: boolean;
}

// The shelf over the composer: folder and branch for a draft, the terminal, branch, pull request, diff count and the agent's plan for a session.
export function SessionShelf({ session, plain, drafting, running, act, onCwd, onOpenFolder, worktree, onWorktree, shells, terminalOpen = false }: SessionShelfProps) {
  const { call, projects, platform, openReview, toggleTerminal, notices, dismissNotice } = useDesk();
  const [branch, setBranch] = useState("");
  const { pr, refresh: refreshPull } = usePullRequest(act, running, !plain && !drafting && Boolean(branch), `${session.cwd}\n${branch}`);
  return (
    <div className="composer-shelf">
      {plain ? null : <div className="shelf-top">
        {drafting ? (
          <div className="shelf-picks">
            <FolderMenu
              cwd={session.cwd}
              projects={projects}
              platform={platform}
              call={call}
              onChange={(next) => onCwd?.(next)}
            />
            <BranchMenu
              call={call}
              cwd={session.cwd}
              unscoped
              worktree={worktree}
              onWorktree={onWorktree}
              onOpenFolder={(next) => onCwd?.(next)}
            />
          </div>
        ) : (
          <div className="shelf-picks">
            <TerminalToggle shells={shells} open={terminalOpen} onToggle={() => toggleTerminal(session.id)} />
            <BranchMenu call={act} cwd={session.cwd} onOpenFolder={(next) => onOpenFolder?.(session.id, next)} onBranch={setBranch} />
            {pr ? <PullChip pr={pr} /> : null}
          </div>
        )}
        {drafting ? null : (
          <span className="shelf-end">
            <TaskControl session={session} onEnd={(task) => act("/api/task/stop", { taskId: task.id ?? "" })} />
            <ShelfDiff
              call={act}
              running={running}
              onOpen={() => openReview(session.id)}
            />
          </span>
        )}
      </div>}
      {drafting ? null : <PlanShelf key={session.id} sessionId={session.id} steps={session.plan ?? []} running={running} />}
      {pr ? <PullNotice pr={pr} running={running} act={act} onStale={refreshPull} /> : null}
      {plain || drafting ? null : <TicketDone session={session} running={running} act={act} />}
      <ServiceNotices notices={notices} onDismiss={dismissNotice} />
    </div>
  );
}
