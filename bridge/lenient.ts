// Helpers for lenient Zod schemas at the edges: agent messages, files on disk,
// the ~/.x-bench config files and board responses. Unknown fields never
// fail a parse, and a field with the wrong type reads as missing.

import { z } from "zod";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A field with the wrong type reads as missing.
export function maybe<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

// Items that do not match are skipped instead of failing the whole list.
export function listOf<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((value) => {
      const parsed = item.safeParse(value);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
}

// Never fails. Anything that is not an object reads as an empty one.
export function fields<T extends z.ZodRawShape>(shape: T) {
  const schema = z.looseObject(shape);
  return schema.catch(() => schema.parse({}));
}
