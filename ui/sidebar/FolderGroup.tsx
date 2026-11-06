import type { SidebarFolder, SidebarProject } from "../../server/snapshot.ts";
import { ChatRow, WorkingMark } from "./ChatRow.tsx";
import { FloatingMenu } from "./FloatingMenu.tsx";
import { FolderIcon } from "./icons.tsx";
import { PageFade, renderPages } from "./paging.tsx";
import { folderLimit } from "./projectRows.ts";
import type { Paging } from "./paging.tsx";
import type { FolderRow } from "./projectRows.ts";
import type { Menu, SidebarList } from "./sidebarList.ts";

interface FolderGroupProps {
  project: SidebarProject;
  row: FolderRow;
  // The project's fade when this folder ends a page: on its head while closed, else on its last chat.
  outer: Paging;
  list: SidebarList;
}

export function FolderGroup({ project, row: { folder, sessions }, outer, list }: FolderGroupProps) {
  const { folding, drop, menu } = list;
  const closed = folding.isFolderCollapsed(folder);
  const ids = new Set(sessions.map((session) => session.id));
  const has = (marked: Set<string>) => [...marked].some((id) => ids.has(id));
  const mark = !closed ? "" : has(list.attention) ? "attention" : has(list.working) ? "working" : has(list.unread) ? "unread" : "";
  const menuOpen = menu?.kind === "folder" && menu.id === folder.id;
  return (
    <li className={drop.target === folder.id ? "folder is-drop" : "folder"} {...drop.zone(folder.id, project, folder.id)}>
      <div
        className="session-row folder-head"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          list.openMenu({ kind: "folder", id: folder.id, place: { x: event.clientX, y: event.clientY, above: event.clientY, alignEnd: false } });
        }}
      >
        <button type="button" className="session-link folder-row" aria-expanded={!closed} onClick={() => folding.toggleFolder(folder)}>
          <FolderIcon open={!closed} />
          <span className="session-title">{folder.name}</span>
          {mark === "working" ? <WorkingMark /> : mark ? <span className={`status-dot ${mark}`} aria-label={mark === "attention" ? "Needs you" : "Ready to read"} /> : null}
          <span className="folder-count">{sessions.length}</span>
        </button>
        {closed || !sessions.length ? <PageFade paging={outer} /> : null}
        <button
          type="button"
          className="session-more"
          aria-label={`Folder actions for ${folder.name}`}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            list.toggleMenu({ kind: "folder", id: folder.id, place: { x: rect.right, y: rect.bottom + 2, above: rect.top - 2, alignEnd: true } });
          }}
        >
          …
        </button>
        {menuOpen ? <FolderMenu folder={folder} menu={menu} list={list} /> : null}
      </div>
      {closed ? null : (
        <ul className="folder-chats">
          {renderPages(folder.id, sessions, folderLimit, folding, (session, paging) => (
            <ChatRow key={session.id} project={project} session={session} paging={!paging.fade && session === sessions.at(-1) ? outer : paging} list={list} />
          ))}
        </ul>
      )}
    </li>
  );
}

function FolderMenu({ folder, menu: { page, name = "", place }, list }: { folder: SidebarFolder; menu: Menu; list: SidebarList }) {
  const { call, closeMenu, updateMenu } = list;
  return (
    <FloatingMenu page={page ?? "main"} place={place} onClose={closeMenu}>
      {page === "name" ? (
        <form
          className="session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (!next) return;
            closeMenu();
            if (next !== folder.name) call?.("/api/folders/rename", { folderId: folder.id, name: next }).catch(() => {});
          }}
        >
          <input autoFocus aria-label={`Rename ${folder.name}`} value={name} maxLength={80} onChange={(event) => updateMenu({ name: event.target.value })} onFocus={(event) => event.target.select()} />
        </form>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={() => updateMenu({ page: "name", name: folder.name })}>
            Rename folder
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              closeMenu();
              call?.("/api/folders/remove", { folderId: folder.id }).catch(() => {});
            }}
          >
            Remove folder
          </button>
        </>
      )}
    </FloatingMenu>
  );
}
