import type { Image } from "../../bridge/protocol.ts";

// The parts of a session toolImage reads. A SessionState fits.
export interface ImageSession {
  transcript?: readonly ImageHolder[];
}

interface ImageHolder {
  type: string;
  id?: string;
  toolCallId?: string;
  images?: readonly Image[];
}

export interface ImageBody {
  mimeType: string;
  body: Buffer;
}

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

export function toolImage(session: ImageSession | null | undefined, id: string, index: number): ImageBody | null {
  if (!session || typeof id !== "string" || !Number.isInteger(index) || index < 0) return null;
  const tool = session.transcript?.find((item) => item.type === "tool" && item.toolCallId === id);
  const message = session.transcript?.find((item) => item.type === "user" && item.id === id);
  const image = (tool || message)?.images?.[index];
  if (!image || !RASTER.has(image.mimeType) || typeof image.data !== "string" || !image.data) return null;
  const body = Buffer.from(image.data, "base64");
  if (!body.length) return null;
  return { mimeType: image.mimeType, body };
}
