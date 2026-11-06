import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SidebarFolder, SidebarProject } from "../../server/snapshot.ts";
import type { ApiCall } from "../launchToken.ts";

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function useFolding(call?: ApiCall) {
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const [folderOverride, setFolderOverride] = useState<Record<string, boolean>>({});
  // How many pages each project (by cwd) and each folder (by id) shows past its first page.
  const [extraPages, setExtraPages] = useState<Record<string, number>>({});
  const extraPagesRef = useRef(extraPages);
  extraPagesRef.current = extraPages;
  const [snapCwd, setSnapCwd] = useState<string | null>(null);
  const chatLists = useRef<Map<string, HTMLDivElement>>(new Map());
  const snapFrame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(snapFrame.current), []);

  function isCollapsed(project: SidebarProject) {
    return project.cwd in collapsedOverride ? collapsedOverride[project.cwd] : Boolean(project.collapsed);
  }

  function persistCollapsed(cwd: string, collapsed: boolean) {
    setCollapsedOverride((current) => ({ ...current, [cwd]: collapsed }));
    call?.("/api/projects/collapsed", { cwd, collapsed }).catch(() => setCollapsedOverride((current) => without(current, cwd)));
  }

  function forget(key: string) {
    setExtraPages((current) => (current[key] ? without(current, key) : current));
  }

  // Extra chats are session-only. Snap them shut while the project is closed so the next open starts at 10.
  function hideExtra(cwd: string) {
    if (!extraPagesRef.current[cwd]) return;
    flushSync(() => {
      setSnapCwd(cwd);
      forget(cwd);
    });
    void chatLists.current.get(cwd)?.offsetHeight;
    cancelAnimationFrame(snapFrame.current);
    snapFrame.current = requestAnimationFrame(() => {
      setSnapCwd((current) => (current === cwd ? null : current));
    });
  }

  function toggleProject(project: SidebarProject) {
    const opening = isCollapsed(project);
    if (opening && extraPagesRef.current[project.cwd]) hideExtra(project.cwd);
    persistCollapsed(project.cwd, !opening);
  }

  function reveal(key: string, page: number) {
    setExtraPages((current) => ((current[key] ?? 0) >= page ? current : { ...current, [key]: page }));
  }

  function isFolderCollapsed(folder: SidebarFolder) {
    return folder.id in folderOverride ? folderOverride[folder.id] : folder.collapsed;
  }

  function toggleFolder(folder: SidebarFolder) {
    const collapsed = !isFolderCollapsed(folder);
    setFolderOverride((current) => ({ ...current, [folder.id]: collapsed }));
    if (collapsed) forget(folder.id);
    call?.("/api/folders/collapsed", { folderId: folder.id, collapsed }).catch(() => setFolderOverride((current) => without(current, folder.id)));
  }

  function chatList(cwd: string) {
    return (node: HTMLDivElement | null) => {
      if (node) chatLists.current.set(cwd, node);
      else chatLists.current.delete(cwd);
    };
  }

  return { extraPages, snapCwd, isCollapsed, persistCollapsed, toggleProject, hideExtra, reveal, forget, isFolderCollapsed, toggleFolder, chatList };
}

export type Folding = ReturnType<typeof useFolding>;
