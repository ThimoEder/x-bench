export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  py: "text/x-python",
  yaml: "text/yaml",
  yml: "text/yaml",
};

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

// The parts of a DataTransfer (clipboard or drop) these helpers read.
export interface TransferSource<F extends FileLike = File> {
  files?: Iterable<F> | null;
  items?: Iterable<{ kind: string; getAsFile?: () => F | null }> | null;
  types?: Iterable<string> | null;
  getData?: (format: string) => string;
}

export type AttachmentKind = "image" | "file";

interface AttachmentBase {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  // A small data: URL thumbnail the composer adds to images.
  preview?: string;
}

export interface DataAttachment extends AttachmentBase {
  data: string;
  previewUrl: string;
  path?: undefined;
}

export interface PathAttachment extends AttachmentBase {
  path: string;
  data?: undefined;
  previewUrl?: undefined;
}

export type Attachment = DataAttachment | PathAttachment;

export type AttachmentResult = { error: string; attachment?: undefined } | { attachment: DataAttachment; error?: undefined };

// What the page posts for one file.
export interface WireAttachment {
  name: string;
  mimeType: string;
  data?: string;
  path?: string;
  preview?: string;
}

export function filesFromDataTransfer<F extends FileLike>(dataTransfer: TransferSource<F> | null | undefined): F[] {
  const found: F[] = [];
  const seen = new Set<F | string>();
  const add = (file: F | null | undefined) => {
    if (!file) return;
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(file) || seen.has(key)) return;
    seen.add(file);
    seen.add(key);
    found.push(file);
  };
  if (dataTransfer?.files) {
    for (const file of dataTransfer.files) add(file);
  }
  if (dataTransfer?.items) {
    for (const item of dataTransfer.items) {
      if (item.kind === "file") add(item.getAsFile?.());
    }
  }
  return found;
}

export function pathsFromDataTransfer(dataTransfer: TransferSource<FileLike> | null | undefined): string[] {
  const raw = dataTransfer?.getData?.("text/uri-list") || "";
  const paths: string[] = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const filePath = fileUrlToPath(trimmed);
    if (filePath) paths.push(filePath);
  }
  return paths;
}

export function hasFileDrag(dataTransfer: TransferSource<FileLike> | null | undefined): boolean {
  const types = dataTransfer?.types ? [...dataTransfer.types] : [];
  return types.includes("Files");
}

export function bytesToBase64(bytes: Uint8Array | ArrayBuffer | ArrayLike<number>): string {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < buffer.length; index += chunk) {
    binary += String.fromCharCode(...buffer.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export interface AttachmentSource {
  name?: string | null;
  mimeType?: string | null;
  bytes?: Uint8Array | ArrayBuffer | null;
  id: string;
}

export function attachmentRecord({ name, mimeType, bytes, id }: AttachmentSource): AttachmentResult {
  const size = bytes?.byteLength ?? 0;
  const type = mimeType || mimeForName(name) || "application/octet-stream";
  const safe = safeName(name) || fallbackName(type);
  if (!bytes || !size) return { error: `${safe} is empty.` };
  if (size > MAX_ATTACHMENT_BYTES) return { error: `${safe} is larger than 8 MB.` };
  const data = bytesToBase64(bytes);
  const kind = RASTER.has(type) ? "image" : "file";
  return {
    attachment: {
      id,
      name: safe,
      mimeType: type,
      kind,
      size,
      data,
      previewUrl: kind === "image" ? `data:${type};base64,${data}` : "",
    },
  };
}

export function mergeAttachments(
  current: readonly Attachment[],
  incoming: readonly Attachment[],
): { attachments: Attachment[]; error: string } {
  const next = [...current];
  let error = "";
  for (const item of incoming) {
    if (next.length >= MAX_ATTACHMENTS) {
      error = `You can attach up to ${MAX_ATTACHMENTS} files.`;
      break;
    }
    const total = next.reduce((sum, file) => sum + file.size, 0) + item.size;
    if (total > MAX_TOTAL_BYTES) {
      error = "Those files are larger than 20 MB together.";
      break;
    }
    if (next.some((file) => sameAttachment(file, item))) continue;
    next.push({ ...item, name: uniqueName(item.name, next) });
  }
  return { attachments: next, error };
}

export function withoutAttachment(current: readonly Attachment[], id: string): Attachment[] {
  return current.filter((file) => file.id !== id);
}

export function wireAttachments(current: readonly Attachment[]): WireAttachment[] {
  return current.map((file) => {
    const body: WireAttachment = file.data
      ? { name: file.name, mimeType: file.mimeType, data: file.data }
      : { name: file.name, mimeType: file.mimeType, path: file.path };
    if (typeof file.preview === "string" && file.preview.startsWith("data:image/") && file.preview.length <= 150000) {
      body.preview = file.preview;
    }
    return body;
  });
}

export function attachmentFromPath({ filePath, id }: { filePath: string; id: string }): PathAttachment {
  const name = safeName(filePath) || "Pasted file";
  const mimeType = mimeForName(name) || "application/octet-stream";
  return {
    id,
    name,
    mimeType,
    kind: RASTER.has(mimeType) ? "image" : "file",
    size: 0,
    path: filePath,
  };
}

export function mimeForName(name: string | null | undefined): string {
  const base = safeName(name).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return MIME_BY_EXT[base.slice(dot + 1)] || "";
}

function sameAttachment(left: Attachment, right: Attachment) {
  if (left.data && right.data && left.data === right.data) return true;
  if (left.path && right.path && left.path === right.path) return true;
  return false;
}

function uniqueName(name: string, existing: readonly Attachment[]) {
  if (!existing.some((file) => file.name === name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let count = 2;
  while (existing.some((file) => file.name === `${stem} ${count}${ext}`)) count += 1;
  return `${stem} ${count}${ext}`;
}

function safeName(name: string | null | undefined) {
  const base = (String(name || "")
    .split(/[/\\]/)
    .pop() ?? "")
    // eslint-disable-next-line no-control-regex -- strip ASCII control characters from a file name
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  return base.slice(0, 180);
}

function fallbackName(mimeType: string) {
  if (mimeType === "image/png") return "Pasted image.png";
  if (mimeType === "image/jpeg") return "Pasted image.jpg";
  if (mimeType === "image/gif") return "Pasted image.gif";
  if (mimeType === "image/webp") return "Pasted image.webp";
  return "Pasted file";
}

function fileUrlToPath(value: string) {
  if (!value.startsWith("file:")) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return "";
    return decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
}

// The short type badge on a file chip: its extension, or FILE.
export function fileBadge(name: string) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "file";
  return ext.slice(0, 4).toUpperCase();
}
