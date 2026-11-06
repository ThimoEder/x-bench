import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import path from "node:path";
import { IMAGE_MIME, imageExtension } from "../../ui/git/imageDiff.ts";
import { insideFolder } from "../folder/files.ts";
import { mainBase, type DiffBase } from "./localGit.ts";
import { findSessionDir } from "../../bridge/grok/sessionFiles.ts";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Indexed with any extension imageExtension accepts.
const MIME_TYPES: Record<string, string> = IMAGE_MIME;

export interface ReviewImage {
  mimeType: string;
  body: Buffer;
}

export type ReviewGit = (args: string[], options?: { buffer?: boolean }) => Promise<string | Buffer>;

export interface ReviewImageRequest {
  cwd?: string | null;
  filePath?: string;
  side?: "before" | "after";
  // The before side comes from the last commit, or from where the branch left main.
  base?: DiffBase;
  read?: (file: string) => Promise<string | Buffer>;
  locate?: (file: string) => Promise<string>;
  git?: ReviewGit;
  maxBytes?: number;
}

// The part of child_process.execFile gitAt calls.
type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; encoding: "buffer" | "utf8"; maxBuffer: number },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

interface GitAtOptions {
  buffer?: boolean;
  maxBytes?: number;
  run?: ExecFile;
}

export function repoRelative(root: string, filePath: string | null | undefined): string {
  const raw = String(filePath || "").replaceAll("\\", "/").trim();
  // eslint-disable-next-line no-control-regex -- reject a path that contains an ASCII control character
  if (!raw || raw.length > 500 || /[\u0000-\u001f]/.test(raw)) return "";
  const base = String(root || "").replaceAll("\\", "/").replace(/\/+$/, "");
  let rel = raw;
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    if (!base || (raw !== base && !raw.startsWith(`${base}/`))) return "";
    rel = raw === base ? "" : raw.slice(base.length + 1);
  }
  if (!rel || rel.split("/").some((part) => !part || part === "." || part === "..")) return "";
  if (!imageExtension(rel)) return "";
  return rel;
}

export async function readReviewImage({
  cwd,
  filePath,
  side,
  base = "head",
  read = readFile,
  locate = realpath,
  git,
  maxBytes = MAX_IMAGE_BYTES,
}: ReviewImageRequest = {}): Promise<ReviewImage | null> {
  if (!cwd) return null;
  const run: ReviewGit = git || ((args, options) => gitAt(cwd, args, { ...options, maxBytes }));
  let root: string;
  try {
    root = await locate(String(await run(["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
  let requested = filePath;
  if (typeof filePath === "string" && path.isAbsolute(filePath)) {
    try {
      requested = await locate(filePath);
    } catch {
      // A deleted picture is no longer on disk. The committed path can still match.
    }
  }
  const rel = repoRelative(root, requested);
  if (!rel) return null;
  const ext = imageExtension(rel);
  try {
    if (side === "before") {
      const ref = base === "main" ? await mainBase((args) => run(args).then(String)) : "HEAD";
      const body = await run(["show", `${ref}:./${rel}`], { buffer: true });
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
      if (!bytes.length || bytes.length > maxBytes) return null;
      return { mimeType: MIME_TYPES[ext] ?? "", body: bytes };
    }
    const abs = path.resolve(root, rel);
    const [realRoot, realFile] = await Promise.all([locate(root), locate(abs)]);
    if (!insideFolder(realRoot, realFile)) return null;
    const body = await read(realFile);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
    if (!bytes.length || bytes.length > maxBytes) return null;
    return { mimeType: MIME_TYPES[ext] ?? "", body: bytes };
  } catch {
    return null;
  }
}

export interface LocalImageOptions {
  read?: (file: string) => Promise<string | Buffer>;
  locate?: (file: string) => Promise<string>;
  size?: (file: string) => Promise<number | null>;
  maxBytes?: number;
}

// A picture anywhere on this machine, by its absolute path: a screenshot an agent put under /tmp and
// names in a reply, which the reply shows inline. Only a file that is a picture by
// its extension, under its real name too, so a link named .png cannot read another kind of file.
// images/<file> in a reply is this chat's picture when the project has no file there.
// The name is one picture file: no folders, so the path cannot leave the session's images directory.
export function sessionImagePath(
  sessionDir: string,
  cwd: string,
  requested: string,
  extension: (file: string) => string = imageExtension,
): string {
  if (!sessionDir || !cwd || !path.isAbsolute(requested)) return "";
  const rel = path.relative(path.resolve(cwd), path.resolve(requested));
  const parts = rel.split(path.sep);
  const name = parts.length === 2 && parts[0] === "images" ? parts[1] : "";
  if (!name || !extension(name)) return "";
  return path.join(sessionDir, "images", name);
}

// The picture a reply names. The path is tried as given, then as this chat's images/<file>.
export async function readReplyImage(
  requested: string,
  { cwd = "", sessionId = "", sessionRoot = "" }: { cwd?: string; sessionId?: string; sessionRoot?: string } = {},
): Promise<ReviewImage | null> {
  const direct = await readLocalImage(requested);
  if (direct) return direct;
  const dir = cwd && sessionId ? findSessionDir(cwd, sessionId, sessionRoot || undefined) : null;
  const alt = dir ? sessionImagePath(dir, cwd, requested) : "";
  return alt ? readLocalImage(alt) : null;
}

export async function readLocalImage(
  filePath: unknown,
  { read = readFile, locate = realpath, size = fileSize, maxBytes = MAX_IMAGE_BYTES }: LocalImageOptions = {},
): Promise<ReviewImage | null> {
  const raw = String(filePath || "");
  // eslint-disable-next-line no-control-regex -- reject a path that contains an ASCII control character
  if (!path.isAbsolute(raw) || raw.length > 1000 || /[\u0000-\u001f]/.test(raw) || !imageExtension(raw)) return null;
  try {
    const real = await locate(raw);
    const ext = imageExtension(real);
    if (!ext) return null;
    const bytes = await size(real);
    if (bytes === null || bytes === 0 || bytes > maxBytes) return null;
    const body = await read(real);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
    if (!buffer.length || buffer.length > maxBytes) return null;
    return { mimeType: MIME_TYPES[ext] ?? "", body: buffer };
  } catch {
    return null;
  }
}

export const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function videoExtension(filePath: unknown): string {
  const name = String(filePath || "").replaceAll("\\", "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return VIDEO_MIME[ext] ? ext : "";
}

export interface LocalVideo {
  file: string;
  size: number;
  mimeType: string;
}

// The video a reply names, under the same rules as a picture. It is streamed, so it has no size limit.
export async function findReplyVideo(
  requested: string,
  { cwd = "", sessionId = "", sessionRoot = "" }: { cwd?: string; sessionId?: string; sessionRoot?: string } = {},
): Promise<LocalVideo | null> {
  const direct = await findLocalVideo(requested);
  if (direct) return direct;
  const dir = cwd && sessionId ? findSessionDir(cwd, sessionId, sessionRoot || undefined) : null;
  const alt = dir ? sessionImagePath(dir, cwd, requested, videoExtension) : "";
  return alt ? findLocalVideo(alt) : null;
}

export async function findLocalVideo(
  filePath: unknown,
  { locate = realpath, size = fileSize }: Pick<LocalImageOptions, "locate" | "size"> = {},
): Promise<LocalVideo | null> {
  const raw = String(filePath || "");
  // eslint-disable-next-line no-control-regex -- reject a path that contains an ASCII control character
  if (!path.isAbsolute(raw) || raw.length > 1000 || /[\u0000-\u001f]/.test(raw) || !videoExtension(raw)) return null;
  try {
    const real = await locate(raw);
    const ext = videoExtension(real);
    if (!ext) return null;
    const bytes = await size(real);
    if (!bytes) return null;
    return { file: real, size: bytes, mimeType: VIDEO_MIME[ext] ?? "" };
  } catch {
    return null;
  }
}

// The bytes a Range header asks for, both ends inclusive. null asks for the whole file, as does a header
// this does not read, such as one with several ranges.
export function byteRange(header: unknown, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : "unsatisfiable";
  }
  const start = Number(match[1]);
  if (match[2] && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 };
}

// Streams the video, or the part of it the request's Range header asks for, so the player can seek.
export function sendVideo(req: IncomingMessage, res: ServerResponse, video: LocalVideo) {
  // The player drops requests while it seeks, often before the file was found.
  if (res.destroyed) return;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  };
  const range = byteRange(req.headers.range, video.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${video.size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: video.size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "Content-Type": video.mimeType,
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${video.size}` } : {}),
  });
  pipeline(createReadStream(video.file, { start, end }), res, () => {});
}

async function fileSize(file: string): Promise<number | null> {
  const info = await stat(file);
  return info.isFile() ? info.size : null;
}

function gitAt(
  cwd: string,
  args: string[],
  { buffer = false, maxBytes = MAX_IMAGE_BYTES, run = execFile }: GitAtOptions = {},
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    run(
      "git",
      ["-C", cwd, ...args],
      { timeout: 20000, encoding: buffer ? "buffer" : "utf8", maxBuffer: maxBytes + 4096 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "Git failed").trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
