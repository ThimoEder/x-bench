import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";
import type { FileNode } from "../../server/folder/files.ts";
import type { PresentedSession } from "../../server/present.ts";
import type { CallOptions } from "../launchToken.ts";

export interface FileTreeProps {
  session: Pick<PresentedSession, "id" | "cwd">;
  call: (path: string, body: Record<string, unknown>, method?: string, options?: CallOptions) => Promise<unknown>;
  onPick: (node: FileNode) => void;
  // The file open below the tree.
  picked?: string;
}

interface TreeNodesProps {
  nodes: FileNode[];
  depth: number;
  open: string[];
  childrenByPath: Record<string, FileNode[]>;
  onToggle: (node: FileNode) => void;
  picked?: string;
  changed: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNode(value: unknown): value is FileNode {
  return isRecord(value) && typeof value.path === "string" && (value.type === "directory" || value.type === "file");
}

// The host answers { nodes: FileNode[] }; a body that failed to parse arrives as {}.
function listedNodes(data: unknown): FileNode[] {
  const nodes = isRecord(data) ? data.nodes : undefined;
  return Array.isArray(nodes) && nodes.every(isFileNode) ? nodes : [];
}

// The full paths of the uncommitted changes in /api/git's answer, whose paths are relative to its root.
export function changedPaths(data: unknown): Set<string> {
  if (!isRecord(data) || typeof data.root !== "string" || !data.root || !Array.isArray(data.files)) return new Set();
  const root = data.root;
  return new Set(data.files.flatMap((file: unknown) => (isRecord(file) && typeof file.path === "string" ? [`${root}/${file.path}`] : [])));
}

export function FileTree({ session, call, onPick, picked }: FileTreeProps) {
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  // shortcut: read once as the tree opens, so a file changed while it stays open gets its M on the next open; watch git if that matters.
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<string[]>([]);
  const [error, setError] = useState("");

  const read = useEffectEvent(call);
  useEffect(() => {
    let cancel = false;
    setChildren({});
    setOpen([session.cwd]);
    setError("");
    read("/api/files", { path: session.cwd })
      .then((data) => {
        if (!cancel) setChildren({ [session.cwd]: listedNodes(data) });
      })
      .catch((loadError: unknown) => {
        if (!cancel) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    setChanged(new Set());
    read("/api/git", { base: "head" }, "POST", { quiet: true })
      .then((data) => {
        if (!cancel) setChanged(changedPaths(data));
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [session.id, session.cwd]);

  async function toggle(node: FileNode) {
    if (node.type !== "directory") {
      onPick(node);
      return;
    }
    const shown = open.includes(node.path);
    setOpen(shown ? open.filter((item) => item !== node.path) : [...open, node.path]);
    if (shown || children[node.path]) return;
    const data = await call("/api/files", { path: node.path });
    setChildren((current) => ({ ...current, [node.path]: listedNodes(data) }));
  }

  return (
    <nav className="file-tree" data-testid="file-tree" aria-label="Files">
      {error ? <p className="muted">{error}</p> : null}
      <TreeNodes nodes={children[session.cwd] ?? []} depth={0} open={open} childrenByPath={children} onToggle={toggle} picked={picked} changed={changed} />
    </nav>
  );
}

function TreeNodes({ nodes, depth, open, childrenByPath, onToggle, picked, changed }: TreeNodesProps) {
  return nodes.map((node) => {
    const dir = node.type === "directory";
    const expanded = dir && open.includes(node.path);
    const className = ["tree-row", dir ? "dir" : "", expanded ? "is-open" : "", node.path === picked ? "is-picked" : ""].filter(Boolean).join(" ");
    return (
      <div key={node.path}>
        <button
          type="button"
          className={className}
          style={{ "--depth": depth }}
          aria-expanded={dir ? expanded : undefined}
          aria-current={node.path === picked ? "true" : undefined}
          onClick={() => onToggle(node)}
        >
          <span className="twist">{dir ? <ChevronIcon /> : null}</span>
          {dir ? <FolderIcon /> : <FileIcon />}
          <span className="tree-name">{node.name as ReactNode}</span>
          {!dir && changed.has(node.path) ? <span className="tree-mod" aria-label="Changed">M</span> : null}
        </button>
        {expanded ? (
          <TreeNodes
            nodes={childrenByPath[node.path] ?? []}
            depth={depth + 1}
            open={open}
            childrenByPath={childrenByPath}
            onToggle={onToggle}
            picked={picked}
            changed={changed}
          />
        ) : null}
      </div>
    );
  });
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9z" />
      <path d="M14 3.5V9h5.5" />
    </svg>
  );
}
