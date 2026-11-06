import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SidebarProject, SidebarSession } from "../../server/snapshot.ts";
import { ChatRow } from "./ChatRow.tsx";
import { FloatingMenu } from "./FloatingMenu.tsx";
import type { MenuPlace } from "./FloatingMenu.tsx";
import { FolderGroup } from "./FolderGroup.tsx";
import { BoardIcon, CaretIcon, ComposeIcon, MoreIcon } from "./icons.tsx";
import { renderPages } from "./paging.tsx";
import { chatLimit, isGroup, sidebarRows } from "./projectRows.ts";
import type { SidebarList } from "./sidebarList.ts";
import type { ProjectDrag, ProjectDragging } from "./useProjectDrag.ts";

interface ProjectActions {
  onChat?: (cwd: string) => void;
  onOpenProject?: (cwd: string) => void;
  onCreateBoard?: (project: SidebarProject) => void;
  onRemoveBoard?: (project: SidebarProject) => void;
}

interface ProjectSectionProps extends ProjectActions {
  project: SidebarProject;
  // The project's chats the sidebar lists, the search's matches while it runs.
  sessions: SidebarSession[];
  searching: boolean;
  boarded: boolean;
  busy: boolean;
  dragging: ProjectDragging;
  list: SidebarList;
}

export function ProjectSection({ project, sessions, searching, boarded, busy, dragging, list, ...actions }: ProjectSectionProps) {
  const { folding, drop, menu } = list;
  const [removing, setRemoving] = useState(false);
  const removed = useRef(false);
  const collapsed = folding.isCollapsed(project);
  const dropEdge = dragging.dropEdge(project.cwd);
  const menuOpen = menu?.kind === "project" && menu.id === project.cwd;

  function commitRemove() {
    if (removed.current) return;
    removed.current = true;
    folding.forget(project.cwd);
    list.call?.("/api/projects/remove", { cwd: project.cwd }).catch(() => {
      removed.current = false;
      setRemoving(false);
    });
  }

  function remove() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      commitRemove();
      return;
    }
    setRemoving(true);
    window.setTimeout(commitRemove, 320);
  }

  return (
    <section
      data-cwd={project.cwd}
      className={["project", removing ? "removing" : "", dragging.drag?.cwd === project.cwd ? "is-drag-source" : "", dropEdge ? `is-drop-${dropEdge}` : ""].filter(Boolean).join(" ")}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
        if (removing) commitRemove();
      }}
    >
      <div className="project-clip">
        <div className={drop.target === `project:${project.cwd}` ? "project-head is-drop" : "project-head"} {...drop.zone(`project:${project.cwd}`, project, null)}>
          <button
            type="button"
            className={collapsed ? "project-toggle collapsed" : "project-toggle"}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${project.name}` : `Minimize ${project.name}`}
            onClick={(event) => {
              event.stopPropagation();
              folding.toggleProject(project);
            }}
          >
            <CaretIcon />
          </button>
          {boarded ? (
            <button
              type="button"
              className="project-title"
              data-testid="project-open"
              title={project.cwd}
              onPointerDown={(event) => dragging.track(event, project, true)}
              onClick={(event) => {
                if (!dragging.endsDrag(event)) actions.onOpenProject?.(project.cwd);
              }}
            >
              <span className="project-name">{project.name}</span>
              <span className="project-board-mark" data-testid="project-board-icon">
                <BoardIcon />
              </span>
            </button>
          ) : (
            <div className="project-title" title={project.cwd} onPointerDown={(event) => dragging.track(event, project, false)}>
              <span className="project-name">{project.name}</span>
            </div>
          )}
          <div className={menuOpen ? "project-tools is-open" : "project-tools"}>
            <button
              type="button"
              className="project-tool"
              aria-label={`Project actions for ${project.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                list.toggleMenu({ kind: "project", id: project.cwd, place: { x: rect.right, y: rect.bottom + 2, above: rect.top - 2, alignEnd: true } });
              }}
            >
              <MoreIcon />
            </button>
            <button
              type="button"
              className="project-tool"
              data-testid="project-chat"
              aria-label={`New chat in ${project.name}`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                list.closeMenu();
                actions.onChat?.(project.cwd);
              }}
            >
              <ComposeIcon />
            </button>
            {menuOpen ? <ProjectMenu project={project} boarded={boarded} place={menu.place} onClose={list.closeMenu} onRemove={remove} {...actions} /> : null}
          </div>
        </div>
        <div
          className={["project-chats", !searching && collapsed ? "collapsed" : "", folding.snapCwd === project.cwd ? "snap" : ""].filter(Boolean).join(" ")}
          ref={folding.chatList(project.cwd)}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
            if (folding.isCollapsed(project)) folding.hideExtra(project.cwd);
          }}
        >
          <div className="project-chats-body">
            <ul>
              {/* A search lists its matches flat, folders left out. */}
              {searching
                ? sessions.map((session) => <ChatRow key={session.id} project={project} session={session} list={list} />)
                : renderPages(project.cwd, sidebarRows(project, sessions), chatLimit, folding, (row, paging) =>
                    isGroup(row) ? (
                      <FolderGroup key={`folder-${row.folder.id}`} project={project} row={row} outer={paging} list={list} />
                    ) : (
                      <ChatRow key={row.id} project={project} session={row} paging={paging} list={list} />
                    ),
                  )}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

interface ProjectMenuProps extends ProjectActions {
  project: SidebarProject;
  boarded: boolean;
  place: MenuPlace;
  onClose: () => void;
  onRemove: () => void;
}

function ProjectMenu({ project, boarded, place, onClose, onRemove, onOpenProject, onCreateBoard, onRemoveBoard }: ProjectMenuProps) {
  const item = (label: string, action: () => void, props: { className?: string; "data-testid"?: string } = {}) => (
    <button
      type="button"
      role="menuitem"
      {...props}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
    </button>
  );
  return (
    <FloatingMenu place={place} onClose={onClose}>
      {boarded ? (
        <>
          {item("Open board", () => onOpenProject?.(project.cwd))}
          {item("Remove board", () => onRemoveBoard?.(project))}
        </>
      ) : (
        item("Create board", () => onCreateBoard?.(project), { "data-testid": "create-board" })
      )}
      {item("Delete", onRemove, { className: "danger" })}
    </FloatingMenu>
  );
}

export function DragGhost({ drag }: { drag: ProjectDrag }) {
  return createPortal(
    <div className="project-drag-ghost" data-testid="project-drag-ghost" style={{ left: drag.left, width: drag.width, top: drag.y - drag.offsetY }}>
      <span className="project-name">{drag.name}</span>
      {drag.boarded ? (
        <span className="project-board-mark">
          <BoardIcon />
        </span>
      ) : null}
    </div>,
    document.body,
  );
}
