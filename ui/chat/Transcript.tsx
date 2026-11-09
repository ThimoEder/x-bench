import { useEffect, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { ComposerCatalog, OpenSession, ProviderView, ShellView, TaskSuggestion } from "../../server/snapshot.ts";
import type { TaskStart } from "../../server/board/taskStart.ts";
import type { WorktreePlan } from "../folder/draftWorktree.ts";
import type { CallOptions } from "../launchToken.ts";
import { useDesk } from "../deskContext.ts";
import { SessionShelf, TranscriptHeader } from "./TranscriptHeader.tsx";
import { MessageList, TurnCards } from "./messages/MessageList.tsx";
import { Queue } from "./Queue.tsx";
import { BoardOffer } from "../board/BoardOffer.tsx";
import { TaskCards } from "../board/TaskCards.tsx";
import { Composer } from "./composer/Composer.tsx";
import { FolderGone } from "../folder/FolderGone.tsx";
import type { ComposerSeed, DraftCommit } from "./composer/Composer.tsx";
import { BtwWindow } from "./BtwWindow.tsx";
import { SwitchConfirm } from "./composer/SwitchConfirm.tsx";
import type { SwitchChoice } from "./composer/switchModels.ts";

// A new-session draft (App's draftSession) carries only these fields of an open session.
type DraftFields = "id" | "cwd" | "title" | "transcript" | "status" | "configOptions" | "queue" | "revision" | "modeId";

// loading: the page shows the chat while the host loads it.
export type TranscriptSession = Pick<OpenSession, DraftFields> & Partial<Omit<OpenSession, DraftFields>> & { loading?: boolean; archived?: true };

// An ApiCall bound to the pane's session.
export type SessionCall = (path: string, body?: Record<string, unknown>, method?: string, options?: CallOptions) => Promise<unknown>;

export interface TranscriptProps {
  session: TranscriptSession;
  // Every enabled provider's models, for a chat's model menu to offer a switch.
  catalog?: Partial<ComposerCatalog> | null;
  // Every provider the host runs. The pane uses the one its session runs on.
  providers?: ProviderView[];
  solo?: boolean;
  canSplit?: boolean;
  plain?: boolean;
  onFocus?: (sessionId: string) => void;
  onDropSession?: (session: TranscriptSession, event: ReactDragEvent<HTMLElement>) => void;
  // The session's shells, and whether the dock shows them.
  shells?: ShellView[];
  terminalOpen?: boolean;
  onOpenFolder?: (sessionId: string, path: string | undefined) => void | Promise<unknown>;
  live?: boolean;
  hotkey?: boolean;
  onCommit?: (draft: DraftCommit) => void | Promise<unknown>;
  onConfig?: (id: string, value: string) => void;
  onWarm?: () => void;
  onCwd?: (cwd: string | undefined) => void;
  worktree?: WorktreePlan;
  onWorktree?: (plan: WorktreePlan) => void;
  seed?: ComposerSeed | null;
  onSeedApplied?: () => void;
  focusComposerId?: string | null;
  focusTick?: number;
  // The app opened on this new session: its line says welcome first.
  welcome?: boolean;
  // Where a ticket for a suggested task goes, or null when the chat's folder has no board.
  taskBoard?: string | null;
  onStartTask?: (session: TranscriptSession, suggestion: TaskSuggestion, where: TaskStart) => Promise<unknown> | void;
  onRoutine?: (session: TranscriptSession, prompt: string) => void;
}

export function Transcript({ session, catalog = null, providers = [], solo, canSplit, plain = false, onFocus, onDropSession, shells, terminalOpen = false, onOpenFolder, live = false, hotkey = true, onCommit, onConfig, onWarm, onCwd, worktree, onWorktree, seed, onSeedApplied, focusComposerId, focusTick = 0, welcome = false, taskBoard = null, onStartTask, onRoutine }: TranscriptProps) {
  const { call, openFile: openInDock, openProject } = useDesk();
  const [dropEdge, setDropEdge] = useState(false);
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwSeed, setBtwSeed] = useState("");
  const [btwTick, setBtwTick] = useState(0);
  const [switchTo, setSwitchTo] = useState<SwitchChoice | null>(null);
  const [sentTick, setSentTick] = useState(0);

  const running = session.status === "running";
  const loading = Boolean(session.loading);
  // A chat moving to another provider shows its own line while the old model works.
  const remote = Boolean(live) && !running && !session.switching;
  const queue = session.queue ?? [];
  const drafting = Boolean(onCommit);

  useEffect(() => {
    setBtwOpen(false);
    setBtwSeed("");
    setSwitchTo(null);
  }, [session.id]);

  const provider = providers.find((item) => item.id === (session.provider || "grok")) ?? providers[0] ?? null;
  const providerLabel = (id: string) => providers.find((item) => item.id === id)?.label || id;

  function act(path: string, body?: Record<string, unknown>, method?: string, options?: CallOptions) {
    return call(path, { sessionId: session.id, ...body }, method, options);
  }

  // A file in the session folder opens in the review dock. The chat surface has no dock, and the dock shows
  // only the session folder, so any other file (a screenshot under /tmp, say) is shown in Finder instead.
  // The host decides, resolving .. and symlinks the way the dock's file route does.
  function openFile(sessionId: string, filePath: string) {
    act("/api/file/open", { path: filePath, dock: !plain && !drafting })
      .then((data) => {
        if (isRecord(data) && data.opened === "dock" && typeof data.path === "string") openInDock(sessionId, data.path);
      })
      .catch(() => {});
  }

  function openBtw(question: string) {
    setBtwSeed(question || "");
    setBtwTick((tick) => tick + 1);
    setBtwOpen(true);
  }

  return (
    <main
      className={dropEdge ? "session drop-edge" : "session"}
      data-testid="pane"
      data-draft={drafting ? "true" : undefined}
      onMouseDown={() => onFocus?.(session.id)}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("application/x-grok-session")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropEdge(Boolean(canSplit) && event.clientX > rect.left + rect.width * 0.62);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropEdge(false);
      }}
      onDrop={(event) => {
        setDropEdge(false);
        onDropSession?.(session, event);
      }}
    >
      {solo ? null : <TranscriptHeader session={session} plain={plain} act={act} />}
      <MessageList
        session={session}
        plain={plain}
        drafting={drafting}
        welcome={welcome}
        followTick={sentTick}
        onOpenFile={openFile}
        onOpenBoard={openProject}
        onSendNow={(id) => act("/api/steer/now", { id })}
        onRemoveSteer={(id) => act("/api/steer/remove", { id })}
        providerLabel={providerLabel}
        onCancelSwitch={() => void act("/api/switch/cancel").catch(() => {})}
        onStopTask={(taskId) => void act("/api/task/stop", { taskId }).catch(() => {})}
        act={act}
        agentLabel={provider?.label}
        footer={plain || drafting || running ? null : <BoardOffer session={session} />}
      />
      <div className="composer-stack">
        <TurnCards session={session} providerLabel={session.errorProvider ? providerLabel(session.errorProvider) : provider?.label} agentLabel={provider?.label} running={running} remote={remote} act={act} />
        <Queue queue={queue} act={act} />
        {session.folderGone ? (
          <FolderGone gone={session.folderGone} archived={Boolean(session.archived)} running={running} act={act} call={call} />
        ) : (
          <>
            <TaskCards
              suggestions={session.suggestions ?? []}
              board={taskBoard}
              git={!plain}
              call={call}
              act={act}
              onStart={onStartTask ? (suggestion, where) => onStartTask(session, suggestion, where) : undefined}
            />
            {/* The host answers the shelf's folder questions only once the chat is loaded, so the shelf asks again then. */}
            <SessionShelf
              key={loading ? "loading" : "loaded"}
              session={session}
              plain={plain}
              drafting={drafting}
              running={running}
              act={act}
              onCwd={onCwd}
              worktree={worktree}
              onWorktree={onWorktree}
              onOpenFolder={onOpenFolder}
              shells={shells}
              terminalOpen={terminalOpen}
            />
            <Composer
              session={session}
              provider={provider}
              catalog={catalog}
              onSwitch={drafting ? undefined : setSwitchTo}
              plain={plain}
              hotkey={hotkey}
              act={act}
              onCommit={onCommit}
              onConfig={onConfig}
              onWarm={onWarm}
              onOpenBtw={openBtw}
              {...(onRoutine ? { onRoutine: (prompt: string) => onRoutine(session, prompt) } : {})}
              onSent={() => setSentTick((tick) => tick + 1)}
              seed={seed}
              onSeedApplied={onSeedApplied}
              focusComposerId={focusComposerId}
              focusTick={focusTick}
            />
          </>
        )}
      </div>
      {switchTo ? <SwitchConfirm choice={switchTo} fromLabel={provider?.label || "the current model"} act={act} onClose={() => setSwitchTo(null)} /> : null}
      {btwOpen ? (
        <BtwWindow
          sessionId={session.id}
          cwd={session.cwd}
          ready={!drafting}
          question={btwSeed}
          seed={btwTick}
          onClose={() => setBtwOpen(false)}
        />
      ) : null}
    </main>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
