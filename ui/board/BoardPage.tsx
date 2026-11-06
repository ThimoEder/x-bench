import { catalogFor } from "../chat/composer/draftConfig.ts";
import type { PickMemory } from "../chat/composer/usePickMemory.ts";
import { useDesk } from "../deskContext.ts";
import { PaneBoundary } from "../dock/PaneBoundary.tsx";
import type { PageSnapshot } from "../useSnapshot.ts";
import { ProjectBoard } from "./ProjectBoard.tsx";
import type { useBoardSite } from "./useBoardSite.ts";

export interface BoardPageProps {
  cwd: string;
  taskId: unknown;
  snapshot: PageSnapshot;
  memory: PickMemory;
  site: ReturnType<typeof useBoardSite>;
  onOpenSession: (sessionId: string) => void;
  onSelect: (taskId: unknown) => void;
}

// A chat started on the board starts from the picks a new draft would.
export function BoardPage({ cwd, taskId, snapshot, memory, site, onOpenSession, onSelect }: BoardPageProps) {
  const { call } = useDesk();
  return (
    <PaneBoundary resetKey={cwd} label="The board">
      <ProjectBoard
        key={cwd}
        cwd={cwd}
        taskId={taskId}
        chats={[...snapshot.chats, ...snapshot.projects.flatMap((project) => project.sessions)]}
        call={call}
        refreshKey={JSON.stringify([snapshot.tickets?.bySession || {}, snapshot.tickets?.changes ?? 0])}
        working={snapshot.working}
        tickets={snapshot.tickets}
        onOpenSession={onOpenSession}
        catalog={catalogFor({ composer: snapshot.composer, providers: snapshot.providers })}
        picks={memory.remembered({})}
        onPick={memory.rememberPick}
        worktree={{ on: memory.worktreeLast, gitRef: "" }}
        onWorktree={memory.rememberWorktree}
        onLink={site.setBoardLink}
        onSelect={onSelect}
        sitePage={site.sitePage}
        onOpenSite={site.openBoardSite}
        onCloseSite={site.closeSite}
      />
    </PaneBoundary>
  );
}
