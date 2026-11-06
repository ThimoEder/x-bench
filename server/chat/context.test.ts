import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySession, type SessionState } from "../../bridge/reducer.ts";
import { contextWindows } from "./context.ts";
import { presentSession } from "../present.ts";

function session(overrides: Partial<SessionState>): SessionState {
  return { ...emptySession({ id: "s", cwd: "/work" }), ...overrides };
}

test("a model cache supplies the context window and a missing model hides it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-context-"));
  const file = path.join(dir, "models_cache.json");
  writeFileSync(file, JSON.stringify({
    models: {
      "grok-4.7": { info: { context_window: 500000, auto_compact_threshold_percent: 80 } },
      "later": { info: { context_window: 200000, auto_compact_threshold_percent: 90 } },
      "plain": { info: { context_window: 128000 } },
      "broken": { info: { context_window: 0 } },
    },
  }));
  const windows = contextWindows(file);
  assert.deepEqual(windows, {
    "grok-4.7": { size: 500000, compactAt: 80 },
    later: { size: 200000, compactAt: 90 },
    plain: { size: 128000, compactAt: 80 },
  });
  assert.equal(contextWindows(file), windows);

  const shown = presentSession(session({ modelId: "grok-4.7", contextUsed: 119796 }), windows);
  assert.deepEqual(shown.context, { used: 119796, size: 500000, compactAt: 80 });
  const atLimit = presentSession(session({ modelId: "grok-4.7", contextUsed: 400000 }), windows);
  assert.equal(atLimit.context?.compactAt, 80);
  const fresh = presentSession(session({ modelId: "grok-4.7" }), windows);
  assert.deepEqual(fresh.context, { used: 0, size: 500000, compactAt: 80 });
  const unknown = presentSession(session({ modelId: "other", contextUsed: 10 }), windows);
  assert.equal(unknown.context, null);
  rmSync(dir, { recursive: true, force: true });
});
