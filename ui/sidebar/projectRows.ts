import type { SidebarFolder, SidebarProject, SidebarSession } from "../../server/snapshot.ts";

export const chatLimit = 10;
export const folderLimit = 5;

export interface FolderRow {
  folder: SidebarFolder;
  sessions: SidebarSession[];
}

export type ProjectRow = SidebarSession | FolderRow;

// The project's rows in the order of sessions: each folder takes the place of its first chat, and empty folders come last.
export function sidebarRows(project: SidebarProject, sessions: SidebarSession[]): ProjectRow[] {
  const groups = new Map((project.folders ?? []).map((folder) => [folder.id, { folder, sessions: [] as SidebarSession[] }]));
  const rows: ProjectRow[] = [];
  for (const session of sessions) {
    const group = session.folder ? groups.get(session.folder) : undefined;
    if (!group) rows.push(session);
    else if (group.sessions.push(session) === 1) rows.push(group);
  }
  for (const group of groups.values()) if (!group.sessions.length) rows.push(group);
  return rows;
}

export function isGroup(row: ProjectRow): row is FolderRow {
  return "sessions" in row;
}

// The list in pages of limit items. The first page shows, and the next `extra` pages once revealed.
export function pages<T>(items: T[], limit: number, extra = 0): { items: T[]; revealed: boolean }[] {
  const list: { items: T[]; revealed: boolean }[] = [];
  for (let start = 0; start < items.length; start += limit) list.push({ items: items.slice(start, start + limit), revealed: list.length <= extra });
  return list;
}

// The rows a project shows on its revealed pages, each open folder followed by the chats its own pages show.
export function shownRows(project: SidebarProject, sessions: SidebarSession[], extraPages: Record<string, number>, folderOpen: (folder: SidebarFolder) => boolean): ProjectRow[] {
  const revealed = <T,>(items: T[], limit: number, key: string) => pages(items, limit, extraPages[key]).flatMap((page) => (page.revealed ? page.items : []));
  return revealed(sidebarRows(project, sessions), chatLimit, project.cwd).flatMap((row) =>
    isGroup(row) && folderOpen(row.folder) ? [row, ...revealed(row.sessions, folderLimit, row.folder.id)] : [row],
  );
}
