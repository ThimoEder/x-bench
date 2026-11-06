import type { SidebarProject, SidebarSession } from "../../server/snapshot.ts";

type FolderProject = Pick<SidebarProject, "cwd"> & { sessions: readonly Pick<SidebarSession, "rankedAt" | "archived">[] };

// The folder a new Builder session starts in: the project of the session worked
// on last, by the same rank the sidebar sorts with (rankedAt), not Grok's
// updated_at, which also moves when a session is only loaded or retitled.
// A worktree session is listed under its project, so this is the project
// folder, not the worktree. With no session to go by there is no folder, and
// the draft asks for one instead of guessing.
export function draftFolder(projects: readonly FolderProject[] | null | undefined): string {
  let folder = "";
  let latest = "";
  for (const project of projects ?? []) {
    for (const session of project.sessions) {
      if (session.archived) continue;
      const rank = session.rankedAt || "";
      // The sidebar compares these ISO stamps as strings, so this does too.
      if (!rank || rank <= latest) continue;
      latest = rank;
      folder = project.cwd;
    }
  }
  return folder;
}

// The last part of a folder path, for the draft's line above the composer.
export function folderName(folder: string): string {
  return folder.split(/[/\\]/).filter(Boolean).at(-1) || folder;
}
