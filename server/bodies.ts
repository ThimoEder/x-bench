// Request body schemas that several route groups share.

import { z } from "zod";

// Path-safe, since harnesses keep files by a chat's id.
export const SessionId = z.string().regex(/^[\w-]{1,80}$/, "Unknown session");

export const Cwd = z.string().default("");

export const Text = z.string().default("");

export const Maybe = z.string().nullish();

export const RequestId = z.union([z.string(), z.number()]);

export const SessionBody = z.object({ sessionId: SessionId });

export function issueText(error: z.ZodError): string {
  const [issue] = error.issues;
  return issue?.path.length ? `${issue.path.join(".")}: ${issue.message}` : (issue?.message ?? "Invalid body");
}
