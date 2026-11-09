import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";
import type { ProviderView, SidebarProject, SidebarSession, TicketLink } from "../../server/snapshot.ts";
import { isRecord } from "../../bridge/lenient.ts";
import { dockPlaces } from "../dock/dockMemory.ts";
import type { WorktreeBody, WorktreeGuard } from "../git/WorktreeDiscard.tsx";
import type { ApiCall } from "../launchToken.ts";
import type { MenuPlace } from "./FloatingMenu.tsx";
import type { SidebarProvider } from "./sidebarProvider.ts";
import type { Folding } from "./useFolding.ts";

export const SESSION_DRAG = "application/x-grok-session";

export interface Menu {
  kind: "chat" | "project" | "folder";
  // The chat's or folder's id, or the project's cwd.
  id: string;
  place: MenuPlace;
  // The page past the first, the name typed on it, and the action waiting for a second click. They live here, so
  // a row that moves to another page of the list keeps them.
  page?: "folders" | "name";
  name?: string;
  confirm?: "archive" | "delete";
}

export type MenuDraft = Pick<Menu, "page" | "name" | "confirm">;

export interface SidebarList {
  call?: ApiCall;
  onOpen: (session: SidebarSession) => void;
  attention: Set<string>;
  working: Set<string>;
  unread: Set<string>;
  openIds: Set<string>;
  tickets: Record<string, TicketLink[]> | undefined;
  providers: ProviderView[];
  providerShown: SidebarProvider;
  pattern: RegExp | null;
  // The open menu, while its row shows.
  menu: Menu | null;
  openMenu: (menu: Menu) => void;
  toggleMenu: (menu: Menu) => void;
  closeMenu: () => void;
  updateMenu: (draft: MenuDraft) => void;
  moveChats: (sessionIds: string[], folderId: string | null) => void;
  rename: Rename;
  deleting: Deleting;
  guardWorktree: WorktreeGuard;
  drop: ChatDrop;
  folding: Folding;
}

export function useMenu(rootRef: RefObject<HTMLElement | null>) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleMenu = useCallback((next: Menu) => setMenu((current) => (current?.kind === next.kind && current.id === next.id ? null : next)), []);
  const updateMenu = useCallback((draft: MenuDraft) => setMenu((current) => current && { ...current, ...draft }), []);
  const opened = menu !== null;

  useEffect(() => {
    if (!opened) return undefined;
    function close(event: PointerEvent) {
      const target = event.target as Element;
      if (target.closest?.(".session-menu") || target.closest?.(".session-more") || target.closest?.(".project-tools")) return;
      closeMenu();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }
    function onScroll(event: Event) {
      if (rootRef.current?.contains(event.target as Node | null)) closeMenu();
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [opened, closeMenu, rootRef]);

  return { menu, openMenu: setMenu, toggleMenu, closeMenu, updateMenu };
}

export function useRename(call: ApiCall | undefined, closeMenu: () => void) {
  const [id, setId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const renaming = useRef<string | null>(null);

  function start(session: SidebarSession) {
    closeMenu();
    renaming.current = session.id;
    setId(session.id);
    setValue(session.title || "");
  }

  function cancel() {
    renaming.current = null;
    setId(null);
  }

  function commit(session: SidebarSession) {
    if (renaming.current !== session.id) return;
    renaming.current = null;
    const title = value.trim().replace(/\s+/g, " ");
    setId(null);
    if (!title || title === session.title) return;
    call?.("/api/rename", { sessionId: session.id, title }).catch(() => {});
  }

  return { id, value, setValue, start, cancel, commit };
}

export type Rename = ReturnType<typeof useRename>;

export function useDeleting(call: ApiCall | undefined, closeMenu: () => void, guardWorktree: WorktreeGuard) {
  const [id, setId] = useState<string | null>(null);

  function remove(session: SidebarSession, worktree: boolean) {
    if (!call) return;
    setId(session.id);
    const send = (body: WorktreeBody) => call("/api/delete", { sessionId: session.id, ...body });
    (worktree ? guardWorktree("delete", send, closeMenu) : send({ worktree: false }).then(() => true))
      .then((gone) => {
        if (!gone) return;
        dockPlaces.forget(session.id);
        closeMenu();
      })
      .catch(() => {})
      .finally(() => setId(null));
  }

  return { id, remove };
}

export type Deleting = ReturnType<typeof useDeleting>;

// A chat dragged from this project, to drop on one of its folders or on its head.
function draggedChat(event: DragEvent, project: SidebarProject): string | null {
  const raw = event.dataTransfer.getData(SESSION_DRAG);
  try {
    const item: unknown = JSON.parse(raw);
    const id = isRecord(item) ? String(item.id) : "";
    return project.sessions.some((session) => session.id === id) ? id : null;
  } catch {
    return null;
  }
}

export function useChatDrop(moveChats: SidebarList["moveChats"]) {
  const [target, setTarget] = useState<string | null>(null);

  function zone(key: string, project: SidebarProject, folderId: string | null) {
    return {
      onDragOver(event: DragEvent) {
        if (![...event.dataTransfer.types].includes(SESSION_DRAG)) return;
        event.preventDefault();
        setTarget(key);
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget((current) => (current === key ? null : current));
      },
      onDrop(event: DragEvent) {
        setTarget(null);
        const id = draggedChat(event, project);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        moveChats([id], folderId);
      },
    };
  }

  return { target, zone };
}

export type ChatDrop = ReturnType<typeof useChatDrop>;
