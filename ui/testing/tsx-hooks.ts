import { readFile } from "node:fs/promises";
import type { LoadHook } from "node:module";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";

// Node strips types from .ts files but cannot read JSX. Component tests register this hook,
// which compiles each .tsx file with the Oxc transform Vite uses for the page.
// A stylesheet the page imports (KaTeX's) is an empty module here.
export const load: LoadHook = async (url, context, nextLoad) => {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  // transformWithOxc throws on a syntax error.
  const result = await transformWithOxc(await readFile(file, "utf8"), file, { lang: "tsx", jsx: { runtime: "automatic" } });
  return { format: "module", source: result.code, shortCircuit: true };
};
