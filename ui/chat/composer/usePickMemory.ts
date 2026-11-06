import { useEffect, useRef, useState } from "react";
import type { OpenSession } from "../../../server/snapshot.ts";
import { storedFlag } from "../../stored.ts";
import { effortStamp, noteEffort, rememberEffort, withMemory, type DraftPicks, type EffortMemory } from "./draftConfig.ts";

// Whether the last new session was sent with its worktree box ticked. A new draft starts that way.
const WORKTREE_KEY = "x-bench-worktree";

export function usePickMemory(open: OpenSession[], focusId: string | null) {
  const [effortMemory, setEffortMemory] = useState<EffortMemory>({ seeded: false, seen: {}, last: "" });
  const [lastModel, setLastModel] = useState("");
  const [worktreeLast, setWorktreeLast] = useState(() => storedFlag(WORKTREE_KEY, false));
  const openEfforts = effortStamp(open);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    setEffortMemory((memory) => rememberEffort(memory, openRef.current, focusId));
  }, [openEfforts, focusId]);

  function rememberPick(id: string, value: string) {
    if (id === "effort") setEffortMemory((memory) => noteEffort(memory, value));
    if (id === "model") setLastModel(value);
  }

  function rememberWorktree(on: boolean) {
    setWorktreeLast(on);
    try {
      localStorage.setItem(WORKTREE_KEY, on ? "1" : "0");
    } catch {
      // Private mode can block storage. The choice still holds until the app reloads.
    }
  }

  return {
    remembered: (picks: DraftPicks | undefined) => withMemory(picks, effortMemory.last, lastModel),
    rememberPick,
    worktreeLast,
    rememberWorktree,
  };
}

export type PickMemory = ReturnType<typeof usePickMemory>;
