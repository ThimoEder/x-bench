import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Missing key stays on. Grok Build only skips the ghost-text call when this is false.
export function promptSuggestionsEnabled(text: unknown) {
  let section = "";
  let enabled = true;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const table = trimmed.match(/^\[([^\]]+)]$/);
    if (table) {
      section = (table[1] ?? "").trim();
      continue;
    }
    if (section !== "ui") continue;
    const match = trimmed.match(/^prompt_suggestions\s*=\s*(true|false)\b/i);
    if (match) enabled = (match[1] ?? "").toLowerCase() === "true";
  }
  return enabled;
}

export function readPromptSuggestions(file = path.join(os.homedir(), ".grok", "config.toml")) {
  try {
    return promptSuggestionsEnabled(readFileSync(file, "utf8"));
  } catch {
    return true;
  }
}
