import { useState } from "react";
import type { SidebarProject, SidebarSession, Surface } from "../../server/snapshot.ts";
import { useDesk } from "../deskContext.ts";
import { PaneBoundary } from "../dock/PaneBoundary.tsx";
import type { SettingsTab } from "../settings/Settings.tsx";
import type { Layout } from "../useLayout.ts";
import { useStableCallback } from "../useStableCallback.ts";
import { persistShowArchived, readShowArchived } from "./archiveView.ts";
import { Sidebar, type SidebarProps } from "./Sidebar.tsx";

export interface SidebarActions {
  openDraft: (folder?: string) => void;
  startChat: () => void;
  selectSurface: (mode: Surface) => unknown;
  openSession: (session: SidebarSession) => void;
  openProject: (cwd: string) => void;
  createBoard: (project: SidebarProject) => void;
  removeBoard: (project: SidebarProject) => Promise<void>;
  showSettings: (tab?: SettingsTab) => void;
  showRoutines: () => void;
  showNeeds: () => void;
}

export interface SidebarColumnProps extends Pick<SidebarProps, "snapshot" | "busy" | "draftCwd" | "routinesOpen" | "needsOpen" | "shownIds" | "phone"> {
  layout: Layout;
  actions: SidebarActions;
}

export function SidebarColumn({ snapshot, busy, draftCwd, routinesOpen, needsOpen, shownIds, phone, layout, actions }: SidebarColumnProps) {
  const { call } = useDesk();
  const { sidebarOpen, setSidebarOpen, sidebarWidth, setSidebarWidth, dragging, beginResize, onSeparatorKey } = layout;
  const [showArchived, setShowArchived] = useState(() => readShowArchived());

  // The sidebar is memoised, so what it calls keeps its identity (useStableCallback).
  // Below 860px the sidebar lies over the chat, so picking something in it closes it, as a phone app's list does.
  function fromSidebar<A extends unknown[]>(run: (...args: A) => void) {
    return (...args: A) => {
      if (window.matchMedia?.("(max-width: 860px)").matches) setSidebarOpen(false);
      run(...args);
    };
  }
  const onNew = useStableCallback(fromSidebar(actions.openDraft));
  const onStartChat = useStableCallback(fromSidebar(actions.startChat));
  const onSurface = useStableCallback(actions.selectSurface);
  const onCollapse = useStableCallback(() => setSidebarOpen(false));
  const onOpen = useStableCallback(fromSidebar(actions.openSession));
  const onOpenProject = useStableCallback(fromSidebar(actions.openProject));
  const onCreateBoard = useStableCallback(actions.createBoard);
  const onToggleArchived = useStableCallback(() => setShowArchived((current) => persistShowArchived(!current)));
  const onOpenSetup = useStableCallback(fromSidebar(() => actions.showSettings()));
  const onOpenRemote = useStableCallback(fromSidebar(() => actions.showSettings("remote")));
  const onOpenRoutines = useStableCallback(fromSidebar(actions.showRoutines));
  const onOpenNeeds = useStableCallback(fromSidebar(actions.showNeeds));
  const onRemoveBoard = useStableCallback((project: SidebarProject) => {
    actions.removeBoard(project).catch(() => {});
  });

  return (
    <>
      <PaneBoundary label="The sidebar">
        <Sidebar
          snapshot={snapshot}
          busy={busy}
          onNew={onNew}
          onChat={onNew}
          onStartChat={onStartChat}
          onSurface={onSurface}
          draftCwd={draftCwd}
          open={sidebarOpen}
          width={sidebarWidth}
          onCollapse={onCollapse}
          onOpen={onOpen}
          onOpenProject={onOpenProject}
          onCreateBoard={onCreateBoard}
          showArchived={showArchived}
          onToggleArchived={onToggleArchived}
          onOpenSetup={onOpenSetup}
          onOpenRemote={onOpenRemote}
          onRemoveBoard={onRemoveBoard}
          onOpenRoutines={onOpenRoutines}
          routinesOpen={routinesOpen}
          onOpenNeeds={onOpenNeeds}
          needsOpen={needsOpen}
          call={call}
          shownIds={shownIds}
          phone={phone}
        />
      </PaneBoundary>
      <div
        className={["splitter", dragging === "sidebar" ? "is-dragging" : "", sidebarOpen ? "" : "is-closed"].filter(Boolean).join(" ")}
        inert={sidebarOpen ? undefined : true}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={240}
        aria-valuemax={440}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={(event) => beginResize(event, "sidebar")}
        onKeyDown={(event) => onSeparatorKey("sidebar", event)}
        onDoubleClick={() => setSidebarWidth(280)}
      />
    </>
  );
}
