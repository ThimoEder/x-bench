import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fields, maybe } from "../../bridge/lenient.ts";

// One node of a folder listing (localFiles.ts), in the shape Grok's _x.ai/fs/list had.
const FsNode = fields({
  name: z.unknown().optional(),
  path: maybe(z.string()),
  type: z.unknown().optional(),
});

type ListedNode = z.output<typeof FsNode>;

export interface FileNode {
  // Forwarded as listFolder named it.
  name: unknown;
  path: string;
  type: "directory" | "file";
}

export function directChildren(directory: string, nodes: readonly unknown[] | null | undefined): FileNode[] {
  const root = path.resolve(directory);
  return (nodes ?? [])
    .map((node) => FsNode.parse(node))
    .filter((node) => inDirectory(node, root))
    .map((node): FileNode => ({
      name: node.name,
      path: path.resolve(node.path),
      type: node.type === "directory" ? "directory" : "file",
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
}

function inDirectory(node: ListedNode, root: string): node is ListedNode & { path: string } {
  return node.path ? path.dirname(path.resolve(node.path)) === root : false;
}

export function insideFolder(root: string, directory: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(directory);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

// insideFolder after following symlinks, so a link in the folder cannot reach a file outside it.
export function reallyInsideFolder(root: string, target: string): boolean {
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return insideFolder(root, target) && insideFolder(real(root), real(target));
}

// The file as a path under root, when it really lies in root: after resolving .. and following symlinks on
// both sides, so /tmp/x and /private/tmp/x are the same place on macOS. null when it lies elsewhere.
export function folderPathOf(root: string, target: string): string | null {
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  const realRoot = real(root);
  const realTarget = real(path.resolve(root, target));
  if (!insideFolder(realRoot, realTarget)) return null;
  return path.join(path.resolve(root), path.relative(realRoot, realTarget));
}

export function resolveInFolder(root: string, target: unknown): string {
  const file = String(target || "").trim();
  if (!file) return "";
  return path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
}
