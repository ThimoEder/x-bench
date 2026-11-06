import { useEffect, useRef, useState } from "react";
import { useCloseOutside } from "../useCloseOutside.ts";
import type { KeyboardEvent } from "react";
import type { SidebarProject } from "../../server/snapshot.ts";
import { remotePage, type ApiCall } from "../launchToken.ts";
import { OptionCheck } from "../OptionMenu.tsx";
import { CaretIcon } from "../icons.tsx";
import { leaveRef } from "../leaveRef.ts";

export interface FolderMenuProps {
  cwd?: string | null;
  projects?: readonly Pick<SidebarProject, "cwd" | "name">[] | null;
  platform?: string;
  call: ApiCall;
  onChange?: (cwd: string | undefined) => void;
}

interface FolderRow {
  cwd: string;
  name: string;
  current: boolean;
  typed?: boolean;
}

export function FolderMenu({ cwd, projects, platform, call, onChange }: FolderMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const root = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  const rows = folderChoices(projects, cwd, query);
  const highlighted = rows[Math.min(index, Math.max(rows.length - 1, 0))] || null;

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useCloseOutside(open, root, () => setOpen(false));

  function toggle() {
    setError("");
    setQuery("");
    setIndex(0);
    setOpen((current) => !current);
  }

  async function choose(row: FolderRow | null) {
    if (!row || busy) return;
    setError("");
    setBusy("Checking…");
    try {
      const data = folderReply(await call("/api/folder", { cwd: row.cwd }));
      onChange?.(data.cwd);
      setOpen(false);
      setQuery("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "");
    } finally {
      setBusy("");
    }
  }

  async function browse() {
    if (busy) return;
    setError("");
    setBusy("Opening Finder…");
    try {
      const picked = folderReply(await call("/api/browse", { pick: true }));
      if (!picked.cwd) return;
      const data = folderReply(await call("/api/folder", { cwd: picked.cwd }));
      onChange?.(data.cwd);
      setOpen(false);
      setQuery("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "");
    } finally {
      setBusy("");
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => (rows.length ? (current + 1) % rows.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => (rows.length ? (current - 1 + rows.length) % rows.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(highlighted);
    }
  }

  const label = folderName(cwd) || "Folder";

  return (
    <div className={open ? "branch-menu folder-menu open" : "branch-menu folder-menu"} ref={root}>
      <button
        type="button"
        className="branch-trigger"
        data-testid="folder-menu"
        aria-label="Folder"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={cwd || "Choose a folder"}
        onClick={toggle}
      >
        <FolderIcon />
        <span className="branch-name">{label}</span>
        <CaretIcon />
      </button>
      {open ? (
        <div ref={leaveRef} className="branch-popover folder-popover" role="dialog" aria-label="Folders">
          <input
            ref={search}
            data-testid="folder-search"
            value={query}
            spellCheck="false"
            placeholder="Search folders"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={onSearchKey}
          />
          {error ? <p className="branch-error">{error}</p> : null}
          <div className="branch-scroll">
            {rows.length ? (
              <ul className="branch-list">
                {rows.map((row, rowIndex) => (
                  <li key={row.cwd}>
                    <button
                      type="button"
                      className={highlighted?.cwd === row.cwd ? "active" : ""}
                      title={row.cwd}
                      onMouseEnter={() => setIndex(rowIndex)}
                      onClick={() => choose(row)}
                    >
                      <span>{row.typed ? `Use ${row.name}` : row.name}</span>
                      <span className={row.current ? "muted branch-current" : "muted"}>{row.current ? "current" : row.typed ? "path" : ""}</span>
                      {row.current ? <OptionCheck /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="branch-empty">No matching folders</p>
            )}
          </div>
          {platform === "darwin" && !remotePage() ? (
            <button type="button" className="branch-create" data-testid="folder-browse" disabled={Boolean(busy)} onClick={browse}>
              {busy || "Browse…"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function folderChoices(projects: FolderMenuProps["projects"], cwd: FolderMenuProps["cwd"], query: string): FolderRow[] {
  const needle = String(query || "").trim().toLowerCase();
  const seen = new Set<string>();
  const rows: FolderRow[] = [];
  for (const project of projects || []) {
    const folder = cleanPath(project?.cwd);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    const name = project.name || folderName(folder);
    if (needle && !`${name} ${folder}`.toLowerCase().includes(needle)) continue;
    rows.push({ cwd: folder, name, current: samePath(folder, cwd) });
  }
  const selected = cleanPath(cwd);
  if (selected && !rows.some((row) => samePath(row.cwd, selected)) && (!needle || `${folderName(selected)} ${selected}`.toLowerCase().includes(needle))) {
    rows.unshift({ cwd: selected, name: folderName(selected), current: true });
  }
  const typed = String(query || "").trim();
  if (typed.startsWith("/") && !rows.some((row) => samePath(row.cwd, typed))) {
    rows.push({ cwd: cleanPath(typed), name: folderName(typed), typed: true, current: samePath(typed, cwd) });
  }
  return rows;
}

function samePath(left: unknown, right: unknown): boolean {
  return cleanPath(left) === cleanPath(right);
}

function cleanPath(folder: unknown): string {
  return String(folder || "").replace(/[/\\]+$/, "");
}

function folderName(folder: unknown): string {
  const trimmed = cleanPath(folder);
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

// The /api/folder and /api/browse replies carry the chosen folder as cwd.
function folderReply(value: unknown): { cwd?: string } {
  return isRecord(value) && typeof value.cwd === "string" ? { cwd: value.cwd } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function FolderIcon() {
  return (
    <svg className="folder-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.8 4.4c0-.8.6-1.4 1.4-1.4h3.2l1.3 1.5h5.1c.8 0 1.4.6 1.4 1.4v6.1c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4V4.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
