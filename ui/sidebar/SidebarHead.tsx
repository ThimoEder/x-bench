import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { RoutinesView, Surface } from "../../server/snapshot.ts";
import { copyName, devBuild, devLabel } from "../devBuild.ts";
import { slideThumb, useThumb } from "../useThumb.ts";
import { BuilderIcon, ChatIcon, ClockIcon, CloseIcon, HandIcon, PanelIcon, PlusIcon, SearchIcon } from "./icons.tsx";

interface BrandProps {
  surface: Surface;
  onSurface?: (surface: Surface) => void;
  // A phone's switch sits in the footer.
  phone: boolean;
  onCollapse: () => void;
}

export function Brand({ surface, onSurface, phone, onCollapse }: BrandProps) {
  const [appName] = useState(copyName);
  return (
    <div className="brand">
      <span className="brand-name">
        {devBuild ? (
          <span className="brand-dev-name" role="img" aria-label="X Bench Dev">
            <span className="brand-x" />
            <span className="brand-dev" />
          </span>
        ) : appName ? (
          <span className="brand-copy-name">{appName}</span>
        ) : (
          <span className="brand-mark" role="img" aria-label="X Bench" />
        )}
      </span>
      {devLabel ? (
        <span className="brand-label" title={devLabel}>
          {devLabel}
        </span>
      ) : null}
      {phone ? null : <SurfaceSwitch surface={surface} onSurface={onSurface} />}
      <span className="brand-tools">
        <button type="button" className="icon" aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelIcon />
        </button>
      </span>
    </div>
  );
}

export function SurfaceSwitch({ surface, onSurface }: Pick<BrandProps, "surface" | "onSurface">) {
  const switchRef = useRef<HTMLDivElement>(null);
  useThumb(switchRef, "x", `[data-surface="${surface}"]`);
  return (
    <div
      ref={switchRef}
      className="surface-switch"
      role="tablist"
      aria-label="Workspace"
      onPointerDown={(event) => slideThumb(event, "x", ":scope > button", (button) => onSurface?.(button.dataset.surface === "chat" ? "chat" : "builder"))}
    >
      <button type="button" role="tab" data-surface="chat" data-testid="surface-chat" aria-label="Chat" title="Chat" aria-selected={surface === "chat"} onClick={() => onSurface?.("chat")}>
        <ChatIcon />
      </button>
      <button type="button" role="tab" data-surface="builder" data-testid="surface-builder" aria-label="Builder" title="Builder" aria-selected={surface === "builder"} onClick={() => onSurface?.("builder")}>
        <BuilderIcon />
      </button>
      <span className="surface-switch-thumb" data-thumb aria-hidden="true" />
    </div>
  );
}

interface RoutinesButtonProps {
  routines: RoutinesView | undefined;
  runIds: Set<string>;
  unread: Set<string>;
  open: boolean;
  onOpen: () => void;
}

export function RoutinesButton({ routines, runIds, unread, open, onOpen }: RoutinesButtonProps) {
  const waiting = (routines?.list ?? []).reduce((count, routine) => count + routine.runs.filter((run) => run.state === "waiting").length, 0);
  // The dot names unread runs not yet seen on the Routines page. A seen run that leaves unread is forgotten, so its next reply brings the dot back.
  const unreadRunIds = [...runIds].filter((id) => unread.has(id));
  const [seenRuns, setSeenRuns] = useState<string[]>([]);
  const nextSeen = open ? unreadRunIds : seenRuns.filter((id) => unread.has(id));
  if (nextSeen.join(" ") !== seenRuns.join(" ")) setSeenRuns(nextSeen);
  const unreadRuns = !open && unreadRunIds.some((id) => !nextSeen.includes(id));
  return (
    <button
      className={open ? "sidebar-new sidebar-routines is-active" : "sidebar-new sidebar-routines"}
      data-testid="open-routines"
      type="button"
      aria-current={open ? "page" : undefined}
      onClick={() => onOpen()}
    >
      <ClockIcon />
      <span>Routines</span>
      {waiting ? (
        <span className="routine-count" aria-label={`${waiting} waiting for you`}>
          {waiting}
        </span>
      ) : unreadRuns ? (
        <span className="status-dot unread routine-unread" aria-label="Runs to read" />
      ) : null}
    </button>
  );
}

export function NeedsYouButton({ count, open, onOpen }: { count: number; open: boolean; onOpen: () => void }) {
  return (
    <button className={open ? "sidebar-new sidebar-needs is-active" : "sidebar-new sidebar-needs"} data-testid="open-needs" type="button" aria-current={open ? "page" : undefined} onClick={() => onOpen()}>
      <HandIcon />
      <span>Needs you</span>
      {count ? (
        <span className="needs-count" aria-label={`${count} waiting for you`}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function useSearch(open: boolean) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      openSearch();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The field is inert until the row turns into it, so it takes focus only after that render.
  function openSearch() {
    flushSync(() => setSearchOpen(true));
    field.current?.focus();
  }

  function closeSearch() {
    setQuery("");
    setSearchOpen(false);
  }

  return { query, setQuery, searchOpen, field, openSearch, closeSearch };
}

interface SearchRowProps {
  search: ReturnType<typeof useSearch>;
  chatting: boolean;
  busy: boolean;
  onNew: () => void;
}

// New chat or New session, which turns into the search field while a search runs.
export function SearchRow({ search, chatting, busy, onNew }: SearchRowProps) {
  const { query, searchOpen, closeSearch } = search;
  return (
    <div className={["sidebar-new-row", chatting ? "is-chat" : "", searchOpen ? "is-searching" : ""].filter(Boolean).join(" ")}>
      <button
        className="sidebar-new"
        data-testid={chatting ? "new-chat" : "new-session"}
        type="button"
        disabled={busy}
        inert={searchOpen ? true : undefined}
        onClick={onNew}
      >
        <PlusIcon />
        <span>{chatting ? "New chat" : "New session"}</span>
      </button>
      <button
        type="button"
        className="icon sidebar-search-open"
        data-testid="sidebar-search-open"
        aria-label="Search"
        title="Search (⌘F)"
        inert={searchOpen ? true : undefined}
        onClick={search.openSearch}
      >
        <SearchIcon />
      </button>
      <label className="sidebar-search" inert={searchOpen ? undefined : true}>
        <SearchIcon />
        <input
          ref={search.field}
          type="search"
          data-testid="sidebar-search"
          placeholder="Search"
          aria-label={chatting ? "Search chats" : "Search sessions"}
          value={query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeSearch();
          }}
          onBlur={() => {
            if (!query.trim()) closeSearch();
          }}
        />
        <button type="button" className="sidebar-search-close" aria-label="Close search" onClick={closeSearch}>
          <CloseIcon />
        </button>
      </label>
    </div>
  );
}
