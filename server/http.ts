// Small helpers for JSON requests and replies.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "../bridge/lenient.ts";
import { MAX_JSON_BYTES } from "./apiGuard.ts";

// The message of a thrown value, or "" when it has none.
export function messageOf(error: unknown): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : "";
}

// An error a route answers with this status.
export function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

// The HTTP status a thrown value carries, or the fallback.
export function statusOf(error: unknown, fallback: number): number {
  return isRecord(error) && typeof error.status === "number" && error.status ? error.status : fallback;
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Reads a JSON body. A body over max bytes fails with status 413 and stops the upload.
export async function readJson(req: IncomingMessage, max = MAX_JSON_BYTES): Promise<unknown> {
  const body = await readBody(req, max);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw httpError("Request body is not JSON", 400);
  }
}

// A body over max bytes fails with status 413 and stops the upload.
export function readBody(req: IncomingMessage, max: number): Promise<Buffer<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > max) {
        tooBig = true;
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooBig) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
