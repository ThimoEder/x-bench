import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, mimeForName } from "../ui/chat/composer/attachments.ts";
import { toJpeg } from "./jpeg.ts";
import type { DisplayAttachment } from "./reducer.ts";

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff"]);

const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "html",
  "xml",
  "yaml",
  "yml",
  "csv",
  "svg",
  "sh",
  "py",
  "rb",
  "go",
  "rs",
  "toml",
  "sql",
  "log",
  "mjs",
  "cjs",
]);

export const AttachmentInput = z.object({
  name: z.string().optional(),
  mimeType: z.string().optional(),
  data: z.string().optional(),
  path: z.string().optional(),
  preview: z.string().optional(),
});

type AttachmentInput = z.output<typeof AttachmentInput>;

interface LoadedFile {
  name: string;
  mimeType: string;
  data: string;
  kind: "image" | "file";
  text: string | null;
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text?: string; blob?: string } };

export interface ComposedPrompt {
  text: string;
  blocks: PromptBlock[];
  attachments: DisplayAttachment[];
}

export type PromptError = Error & { status: number };

export function composePrompt(text: unknown, attachments: unknown): ComposedPrompt {
  const files = normalizeAttachments(attachments);
  const trimmed = String(text ?? "").trim();
  if (!trimmed && files.length === 0) throw promptError("Write a prompt first");
  const blocks: PromptBlock[] = [];
  if (trimmed) blocks.push({ type: "text", text: trimmed });
  for (const file of files) blocks.push(contentBlock(file));
  const source = Array.isArray(attachments) ? attachments : [];
  return {
    text: trimmed,
    blocks,
    attachments: files.map((file, index) => displayAttachment(file, asInput(source[index]))),
  };
}

function asInput(value: unknown): AttachmentInput {
  return AttachmentInput.safeParse(value).data ?? {};
}

function displayAttachment(file: LoadedFile, source: AttachmentInput): DisplayAttachment {
  const shown: DisplayAttachment = { name: file.name, kind: file.kind, mimeType: file.mimeType };
  const preview = cleanPreview(source.preview) || (file.kind === "image" ? cleanPreview(`data:${file.mimeType};base64,${file.data}`) : "");
  if (preview) shown.preview = preview;
  return shown;
}

// A large picture copied by path arrives without the thumbnail the page makes for a pasted one.
export async function withThumbnails(composed: ComposedPrompt): Promise<ComposedPrompt> {
  // The image blocks follow the image attachments in the same order.
  const images = composed.blocks.filter((block) => block.type === "image");
  let next = 0;
  const attachments = await Promise.all(
    composed.attachments.map(async (file) => {
      const image = file.kind === "image" ? images[next++] : undefined;
      if (file.preview || !image) return file;
      const preview = await thumbnail(image).catch(() => "");
      return preview ? { ...file, preview } : file;
    }),
  );
  return { ...composed, attachments };
}

async function thumbnail(image: Extract<PromptBlock, { type: "image" }>) {
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
  const jpeg = await toJpeg(Buffer.from(image.data, "base64"), { extension, quality: 85, longest: 320 });
  return cleanPreview(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
}

function cleanPreview(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("data:image/") || value.length > 150000) return "";
  return value;
}

function normalizeAttachments(input: unknown): LoadedFile[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw promptError("Attachments must be a list of files");
  if (input.length > MAX_ATTACHMENTS) throw promptError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
  const files: LoadedFile[] = [];
  let total = 0;
  for (const item of input) {
    const loaded = loadAttachment(asInput(item));
    total += loaded.size;
    if (total > MAX_TOTAL_BYTES) throw promptError("Those files are larger than 20 MB together.");
    files.push({
      name: loaded.name,
      mimeType: loaded.mimeType,
      data: loaded.data,
      kind: RASTER.has(loaded.mimeType) ? "image" : "file",
      text: textOf(loaded.name, loaded.mimeType, loaded.bytes),
    });
  }
  return files;
}

function loadAttachment(item: AttachmentInput) {
  if (item.path?.trim() && !item.data) return readAttachmentPath(item, item.path);
  const name = safeName(item.name);
  const data = item.data ?? "";
  if (!name || !data) throw promptError("One of the attachments is unreadable.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw promptError("One of the attachments is unreadable.");
  const size = decodedSize(data);
  if (!size || size > MAX_ATTACHMENT_BYTES) throw promptError(`${name} is larger than 8 MB.`);
  const mimeType = cleanMime(item.mimeType) || mimeForName(name) || "application/octet-stream";
  return { name, mimeType, data, bytes: Buffer.from(data, "base64"), size };
}

function readAttachmentPath(item: AttachmentInput, itemPath: string) {
  const filePath = path.resolve(itemPath);
  const name = safeName(item.name) || safeName(path.basename(filePath));
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw promptError(`Couldn't read ${name || "that file"}.`);
  }
  if (!stat.isFile()) throw promptError(`${name} is not a file.`);
  if (!stat.size) throw promptError(`${name} is empty.`);
  if (stat.size > MAX_ATTACHMENT_BYTES) throw promptError(`${name} is larger than 8 MB.`);
  const bytes = fs.readFileSync(filePath);
  const mimeType = cleanMime(item.mimeType) || mimeForName(name) || "application/octet-stream";
  return { name, mimeType, data: bytes.toString("base64"), bytes, size: stat.size };
}

function contentBlock(file: LoadedFile): PromptBlock {
  if (file.kind === "image") {
    return { type: "image", mimeType: file.mimeType, data: file.data };
  }
  const resource: { uri: string; mimeType: string; text?: string; blob?: string } = {
    uri: `attachment:${encodeURIComponent(file.name)}`,
    mimeType: file.mimeType,
  };
  if (file.text != null) resource.text = file.text;
  else resource.blob = file.data;
  return { type: "resource", resource };
}

function textOf(name: string, mimeType: string, bytes: Buffer) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const textual = mimeType.startsWith("text/") || mimeType === "application/json" || TEXT_EXT.has(ext);
  if (!textual || bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function decodedSize(data: string) {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length * 3) / 4 - pad;
}

function safeName(name: unknown) {
  return (String(name || "").split(/[/\\]/).pop() ?? "")
    // eslint-disable-next-line no-control-regex -- strip ASCII control characters from a file name
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 180);
}

function cleanMime(mimeType: unknown) {
  const value = (String(mimeType || "")
    .split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(value)) return "";
  return value;
}

function promptError(message: string): PromptError {
  return Object.assign(new Error(message), { status: 400 });
}
