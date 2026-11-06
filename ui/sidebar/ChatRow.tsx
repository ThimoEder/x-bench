import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ProviderView, SidebarProject, SidebarSession } from "../../server/snapshot.ts";
import { RevealTitle } from "../chat/RevealTitle.tsx";
import { ProviderMark } from "../chat/messages/providerMark.tsx";
import { statusTone, ticketStatus } from "../board/ticketStatus.ts";
import { FloatingMenu } from "./FloatingMenu.tsx";
import { ArchiveIcon, PinIcon, WorktreeIcon } from "./icons.tsx";
import { PageFade } from "./paging.tsx";
import type { Paging } from "./paging.tsx";
import { SESSION_DRAG } from "./sidebarList.ts";
import type { Menu, SidebarList } from "./sidebarList.ts";

// The ring spins in CSS, off the main thread. Every ring's animation starts at the page clock's
// zero, so a ring that appears later, or restarts after being hidden, turns in step with the rest.
function alignSpin(node: HTMLElement | null) {
  for (const animation of node?.getAnimations() ?? []) animation.startTime = 0;
}

export function WorkingMark() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => alignSpin(ref.current), []);
  return (
    <span
      ref={ref}
      className="status-dot working"
      aria-label="Working"
      onAnimationStart={(event) => alignSpin(event.currentTarget)}
    />
  );
}

interface ChatRowProps {
  project: SidebarProject | null;
  session: SidebarSession;
  paging?: Paging;
  list: SidebarList;
}

export function ChatRow({ project, session, paging, list }: ChatRowProps) {
  const { attention, working, unread, rename, menu, pattern, providerShown } = list;
  const mark = attention.has(session.id) ? "attention" : working.has(session.id) ? "working" : unread.has(session.id) ? "unread" : "";
  const links = list.tickets?.[session.id] || [];
  const tone = statusTone(ticketStatus(links));
  const rowClass = ["session-row", mark, links.length ? "ticket" : "", session.archived ? "is-archived" : "", session.pinned ? "is-pinned" : ""].filter(Boolean).join(" ");
  const linkClass = ["session-link", list.openIds.has(session.id) ? "active" : "", session.archived ? "is-archived" : "", session.gone ? "is-gone" : ""].filter(Boolean).join(" ");
  const renaming = rename.id === session.id;
  const menuOpen = menu?.kind === "chat" && menu.id === session.id;

  return (
    <li
      className={rowClass}
      style={tone ? { "--ticket": tone } : undefined}
      onContextMenu={(event) => {
        if (renaming) return;
        event.preventDefault();
        event.stopPropagation();
        list.openMenu({ kind: "chat", id: session.id, place: { x: event.clientX, y: event.clientY, above: event.clientY, alignEnd: false } });
      }}
    >
      {renaming ? (
        <form
          className="session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            rename.commit(session);
          }}
        >
          <input
            autoFocus
            aria-label={`Rename ${session.title}`}
            value={rename.value}
            maxLength={80}
            onChange={(event) => rename.setValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={() => rename.commit(session)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              rename.cancel();
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          draggable
          title={session.worktree ? `${session.worktree} · ${session.title}` : session.title}
          className={linkClass}
          onClick={() => list.onOpen(session)}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.setData(
              SESSION_DRAG,
              JSON.stringify({ id: session.id, cwd: session.cwd }),
            );
            event.dataTransfer.effectAllowed = "copy";
          }}
        >
          {mark === "working" ? (
            <WorkingMark />
          ) : mark ? (
            <span className={`status-dot ${mark}`} aria-label={mark === "attention" ? "Needs you" : "Ready to read"} />
          ) : null}
          {session.archived ? <ArchiveIcon /> : null}
          {pattern ? (
            <span className="session-title">{highlight(session.title, pattern)}</span>
          ) : (
            <RevealTitle className="session-title" text={session.title} />
          )}
          {session.provider && providerShown !== "none" ? (
            <span
              className={providerShown === "label" ? "provider-tag is-label" : "provider-tag"}
              data-testid="provider-tag"
              title={providerTrail(session, list.providers)}
            >
              {providerShown === "label" ? providerLabel(session.provider, list.providers) : <ProviderMark provider={session.provider} />}
            </span>
          ) : null}
          {session.worktree ? <WorktreeIcon name={session.worktree} /> : null}
          {session.pinned ? <PinIcon /> : null}
        </button>
      )}
      {renaming ? null : (
        <>
          <PageFade paging={paging} />
          <button
            type="button"
            className="session-more"
            aria-label={`Chat actions for ${session.title}`}
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              list.toggleMenu({ kind: "chat", id: session.id, place: { x: rect.right, y: rect.bottom + 2, above: rect.top - 2, alignEnd: true } });
            }}
          >
            …
          </button>
          {menuOpen ? <ChatMenu project={project} session={session} menu={menu} list={list} /> : null}
        </>
      )}
    </li>
  );
}

interface ChatMenuProps {
  project: SidebarProject | null;
  session: SidebarSession;
  menu: Menu;
  list: SidebarList;
}

function ChatMenu({ project, session, menu: { page, name: folderName = "", confirm, place }, list }: ChatMenuProps) {
  const { call, closeMenu, updateMenu } = list;
  const deleting = list.deleting.id === session.id;

  function archive(worktree: boolean) {
    closeMenu();
    call?.(session.archived ? "/api/unarchive" : "/api/archive", worktree ? { sessionId: session.id, worktree } : { sessionId: session.id }).catch(() => {});
  }

  function copySessionId() {
    const write = session.id ? navigator.clipboard?.writeText?.(session.id) : undefined;
    write?.then(closeMenu).catch(() => {});
  }

  return (
    <FloatingMenu page={page ?? "main"} place={place} onClose={closeMenu}>
      {page === "folders" && project ? (
        <>
          {(project.folders ?? []).map((folder) => (
            <button key={folder.id} type="button" role="menuitem" disabled={session.folder === folder.id} onClick={() => list.moveChats([session.id], folder.id)}>
              {folder.name}
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => updateMenu({ page: "name", name: "" })}>
            New folder…
          </button>
        </>
      ) : page === "name" && project ? (
        <form
          className="session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const name = folderName.trim();
            if (!name) return;
            closeMenu();
            call?.("/api/folders/create", { cwd: project.cwd, name, sessionIds: [session.id] }).catch(() => {});
          }}
        >
          <input autoFocus aria-label="New folder name" placeholder="Folder name" value={folderName} maxLength={80} onChange={(event) => updateMenu({ name: event.target.value })} />
        </form>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={() => list.rename.start(session)}>
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              call?.("/api/pin", { sessionId: session.id, pinned: !session.pinned }).catch(() => {});
            }}
          >
            {session.pinned ? "Unpin" : "Pin to top"}
          </button>
          {project ? (
            <button type="button" role="menuitem" onClick={() => updateMenu(project.folders?.length ? { page: "folders" } : { page: "name", name: "" })}>
              Move to folder…
            </button>
          ) : null}
          {project && session.folder ? (
            <button type="button" role="menuitem" onClick={() => list.moveChats([session.id], null)}>
              Remove from folder
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={copySessionId}>
            Copy session id
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (session.ownWorktree && !session.archived && confirm !== "archive") updateMenu({ confirm: "archive" });
              else archive(false);
            }}
          >
            {session.archived ? "Unarchive" : confirm === "archive" ? "Archive this chat" : "Archive"}
          </button>
          {confirm === "archive" ? (
            <button type="button" role="menuitem" className="danger" onClick={() => archive(true)}>
              Delete the worktree too
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={deleting}
            onClick={() => {
              if (confirm === "delete") list.deleting.remove(session, false);
              else updateMenu({ confirm: "delete" });
            }}
          >
            {deleting ? "Deleting…" : confirm === "delete" ? "Delete this chat" : "Delete"}
          </button>
          {confirm === "delete" && session.ownWorktree && !deleting ? (
            <button type="button" role="menuitem" className="danger" onClick={() => list.deleting.remove(session, true)}>
              Delete the worktree too
            </button>
          ) : null}
        </>
      )}
    </FloatingMenu>
  );
}

// pattern holds one capturing group, so split puts every match at an odd index.
function highlight(title: string, pattern: RegExp): ReactNode[] {
  return title.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

function providerLabel(id: string, providers: readonly Pick<ProviderView, "id" | "label">[]) {
  return providers.find((provider) => provider.id === id)?.label || id;
}

// The provider a row runs on, after the ones a switched chat ran on before, as "A, then B".
export function providerTrail(session: Pick<SidebarSession, "provider" | "earlierProviders">, providers: readonly Pick<ProviderView, "id" | "label">[]): string {
  const label = (id: string) => providers.find((provider) => provider.id === id)?.label || id;
  const trail = [...(session.earlierProviders ?? []), session.provider ?? ""].filter(Boolean).map(label);
  return trail.filter((name, index) => index === 0 || name !== trail[index - 1]).join(", then ");
}
