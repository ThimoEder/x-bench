import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ProviderUsage, ProviderView, RemoteState, RoutinesView, SidebarProject, SidebarSession, Snapshot, Surface } from "../../server/snapshot.ts";
import { useWorktreeDiscard } from "../git/WorktreeDiscard.tsx";
import type { ApiCall } from "../launchToken.ts";
import { UpdateCard, updateBridge, useWaitingUpdate } from "../updater/UpdateCard.tsx";
import { visibleSessions } from "./archiveView.ts";
import { ChatRow } from "./ChatRow.tsx";
import { GearMenu } from "./GearMenu.tsx";
import { DragGhost, ProjectSection } from "./ProjectSection.tsx";
import { isGroup, shownRows } from "./projectRows.ts";
import type { ProjectRow } from "./projectRows.ts";
import { RemoteDot } from "./RemoteDot.tsx";
import { Brand, NeedsYouButton, RoutinesButton, SearchRow, SurfaceSwitch, useSearch } from "./SidebarHead.tsx";
import { useChatDrop, useDeleting, useMenu, useRename } from "./sidebarList.ts";
import type { SidebarList } from "./sidebarList.ts";
import { useSidebarProvider } from "./sidebarProvider.ts";
import { UsageRow } from "./UsageRow.tsx";
import { useFolding } from "./useFolding.ts";
import { useProjectDrag } from "./useProjectDrag.ts";

export { providerTrail } from "./ChatRow.tsx";

const NO_USAGE: ProviderUsage[] = [];
const NO_PROJECTS: SidebarProject[] = [];
const NO_PROVIDERS: ProviderView[] = [];

export interface SidebarProps {
  // The page's first snapshot has no usage yet.
  snapshot: Pick<Snapshot, "open" | "tickets" | "working" | "attention" | "unread" | "projects" | "chats" | "surface"> & {
    usage?: ProviderUsage[] | null;
    remote?: RemoteState;
    // The page's first snapshot has no providers yet.
    providers?: ProviderView[];
    routines?: RoutinesView;
    needsYou?: readonly unknown[];
  };
  busy: boolean;
  onNew: () => void;
  onOpen: (session: SidebarSession) => void;
  onChat?: (cwd: string) => void;
  onStartChat?: () => void;
  onSurface?: (surface: Surface) => void;
  onOpenProject?: (cwd: string) => void;
  onCreateBoard?: (project: SidebarProject) => void;
  onRemoveBoard?: (project: SidebarProject) => void;
  onOpenSetup?: () => void;
  // Opens Settings on the Remote tab.
  onOpenRemote?: () => void;
  onToggleArchived?: () => void;
  onOpenRoutines?: () => void;
  routinesOpen?: boolean;
  onOpenNeeds?: () => void;
  needsOpen?: boolean;
  showArchived: boolean;
  draftCwd?: string | null;
  open: boolean;
  width: number;
  onCollapse: () => void;
  call?: ApiCall;
  // The chats the desk shows, one the page is still loading included. Defaults to the host's desk.
  shownIds?: readonly string[];
  // A phone's chat list: the switch sits in the footer and the usage in the gear's menu.
  phone?: boolean;
}

export const Sidebar = memo(function Sidebar({ snapshot, busy, onNew, onOpen, onChat, onStartChat, onSurface, onOpenProject, onCreateBoard, onRemoveBoard, onOpenSetup, onOpenRemote, onToggleArchived, onOpenRoutines, routinesOpen, onOpenNeeds, needsOpen, showArchived, draftCwd, open, width, onCollapse, call, shownIds, phone = false }: SidebarProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [updates] = useState(updateBridge);
  const waitingUpdate = useWaitingUpdate(updates);
  const [updateOpen, setUpdateOpen] = useState(false);
  const boards = new Set(snapshot.tickets?.boards ?? []);
  const working = new Set(snapshot.working ?? []);
  const attention = new Set(snapshot.attention ?? []);
  const unread = new Set(snapshot.unread ?? []);
  // No list shows routine runs, so a run that needs you is not the Builder's.
  const runIds = new Set((snapshot.routines?.list ?? []).flatMap((routine) => routine.runs.flatMap((run) => (run.sessionId ? [run.sessionId] : []))));
  const { menu, openMenu, toggleMenu, closeMenu, updateMenu } = useMenu(rootRef);
  const dragging = useProjectDrag(rootRef, snapshot.projects ?? NO_PROJECTS, call, closeMenu);
  const { projects } = dragging;
  const chats = snapshot.chats ?? [];
  const search = useSearch(open);
  const needle = search.query.trim();
  const pattern = needle ? new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i") : null;
  const matching = <T extends { title: string }>(list: T[]) => (pattern ? list.filter((session) => pattern.test(session.title)) : list);
  const visibleChats = matching(visibleSessions(chats, showArchived));
  const listed = projects.map((project) => ({ project, sessions: matching(visibleSessions(project.sessions, showArchived)) })).filter(({ sessions }) => !needle || sessions.length);
  const surface = snapshot.surface === "chat" ? "chat" : "builder";
  const chatting = surface === "chat";
  const builderWaiting = chatting && (snapshot.attention ?? []).some((id) => !runIds.has(id) && !chats.some((session) => session.id === id));
  const folding = useFolding(call);
  const rename = useRename(call, closeMenu);
  const discard = useWorktreeDiscard();
  const deleting = useDeleting(call, closeMenu, discard.guard);
  const [providerShown] = useSidebarProvider();

  function moveChats(sessionIds: string[], folderId: string | null) {
    closeMenu();
    call?.("/api/folders/move", { sessionIds, folderId }).catch(() => {});
  }
  const drop = useChatDrop(moveChats);

  // The menu floats outside the sidebar, so it closes when its row is hidden: the sidebar closes,
  // the project or folder folds, or the row leaves the list or its revealed pages.
  const rowsShown = (): ProjectRow[] =>
    chatting
      ? visibleChats
      : listed.flatMap(({ project, sessions }) =>
          needle ? sessions : folding.isCollapsed(project) ? [] : shownRows(project, sessions, folding.extraPages, (folder) => !folding.isFolderCollapsed(folder)),
        );
  const holdsMenu = (row: ProjectRow) => (isGroup(row) ? menu?.kind === "folder" && row.folder.id === menu.id : menu?.kind === "chat" && row.id === menu.id);
  const shownMenu = open && menu && (menu.kind === "project" || rowsShown().some(holdsMenu)) ? menu : null;

  useEffect(() => {
    if (menu && !shownMenu) closeMenu();
  }, [menu, shownMenu, closeMenu]);

  const expandProject = useEffectEvent((cwd: string) => {
    const project = projects.find((item) => item.cwd === cwd);
    if (project && folding.isCollapsed(project)) folding.persistCollapsed(cwd, false);
  });
  useEffect(() => {
    if (draftCwd) expandProject(draftCwd);
  }, [draftCwd]);

  const list: SidebarList = {
    call,
    onOpen,
    attention,
    working,
    unread,
    openIds: new Set(shownIds ?? (snapshot.open ?? []).map((session) => session.id)),
    tickets: snapshot.tickets?.bySession,
    providers: snapshot.providers || NO_PROVIDERS,
    providerShown,
    pattern,
    menu: shownMenu,
    openMenu,
    toggleMenu,
    closeMenu,
    updateMenu,
    moveChats,
    rename,
    deleting,
    guardWorktree: discard.guard,
    drop,
    folding,
  };

  return (
    <aside
      ref={rootRef}
      className={open ? "sidebar is-open" : "sidebar"}
      data-testid="sidebar"
      style={{ width: open ? width : 0, "--sidebar-inner": `${width}px` }}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
    >
      {dragging.drag ? <DragGhost drag={dragging.drag} /> : null}
      {discard.dialog}
      <div className="sidebar-inner">
        <Brand surface={surface} onSurface={onSurface} phone={phone} onCollapse={onCollapse} />
        {onOpenRoutines ? <RoutinesButton routines={snapshot.routines} runIds={runIds} unread={unread} open={Boolean(routinesOpen)} onOpen={onOpenRoutines} /> : null}
        {onOpenNeeds ? <NeedsYouButton count={snapshot.needsYou?.length ?? 0} open={Boolean(needsOpen)} onOpen={onOpenNeeds} /> : null}
        <SearchRow search={search} chatting={chatting} busy={busy} onNew={() => (chatting ? onStartChat?.() : onNew())} />
        <div
          className="sidebar-scroll"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !search.searchOpen) return;
            if ((event.target as Element).closest(".session-menu, input")) return;
            search.closeSearch();
          }}
        >
          {chatting ? (
            <>
              {builderWaiting ? (
                <button type="button" className="builder-wait" onClick={() => onSurface?.("builder")}>
                  <span className="status-dot attention" aria-hidden="true" />
                  Builder needs a decision
                </button>
              ) : null}
              {visibleChats.length ? (
                <ul className="chat-list">
                  {visibleChats.map((session) => (
                    <ChatRow key={session.id} project={null} session={session} list={list} />
                  ))}
                </ul>
              ) : (
                <p className="muted sidebar-empty">{needle ? "No chats match." : "No chats yet."}</p>
              )}
            </>
          ) : projects.length === 0 ? (
            <p className="muted sidebar-empty">No sessions yet.</p>
          ) : needle && !listed.length ? (
            <p className="muted sidebar-empty">No sessions match.</p>
          ) : null}
          {chatting
            ? null
            : listed.map(({ project, sessions }) => (
                <ProjectSection
                  key={project.cwd}
                  project={project}
                  sessions={sessions}
                  searching={Boolean(needle)}
                  boarded={boards.has(project.cwd)}
                  busy={busy}
                  dragging={dragging}
                  list={list}
                  onChat={onChat}
                  onOpenProject={onOpenProject}
                  onCreateBoard={onCreateBoard}
                  onRemoveBoard={onRemoveBoard}
                />
              ))}
        </div>
        <div className="sidebar-foot">
          {updates && updateOpen ? <UpdateCard bridge={updates} running={new Set([...working, ...attention]).size} onClose={() => setUpdateOpen(false)} /> : null}
          <RemoteDot remote={snapshot.remote} call={call} onOpenSettings={onOpenRemote} />
          {phone ? <SurfaceSwitch surface={surface} onSurface={onSurface} /> : <UsageRow usage={snapshot.usage || NO_USAGE} />}
          <span className="sidebar-tools">
            <GearMenu
              usage={phone ? snapshot.usage || NO_USAGE : undefined}
              showArchived={showArchived}
              onToggleArchived={onToggleArchived}
              onOpenSetup={onOpenSetup}
              onCheckUpdates={updates ? () => setUpdateOpen(true) : undefined}
              waitingUpdate={waitingUpdate}
              placement="up"
              testId="open-setup"
            />
          </span>
        </div>
      </div>
    </aside>
  );
}, sameSidebarProps);

// The sidebar reads only the ids of the open sessions, whose transcripts change with every streamed
// chunk. Everything else in the snapshot keeps its identity while unchanged (shareEqual in App), and
// App passes callbacks that keep theirs, so a chunk that changes only a transcript skips the sidebar.
function sameSidebarProps(previous: SidebarProps, next: SidebarProps): boolean {
  const keys = Object.keys(next) as (keyof SidebarProps)[];
  if (keys.length !== Object.keys(previous).length) return false;
  for (const key of keys) {
    if (key !== "snapshot" && !Object.is(previous[key], next[key])) return false;
  }
  const before: Record<string, unknown> = previous.snapshot;
  const after: Record<string, unknown> = next.snapshot;
  const fields = Object.keys(after);
  if (fields.length !== Object.keys(before).length) return false;
  for (const field of fields) {
    if (field === "open") continue;
    if (!Object.is(before[field], after[field])) return false;
  }
  return sameIds(previous.snapshot.open, next.snapshot.open);
}

function sameIds(left: readonly { id: string }[] | undefined, right: readonly { id: string }[] | undefined): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}
