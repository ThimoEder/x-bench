import type { ApiCall } from "../launchToken.ts";

// A draft's worktree box: whether sending creates a worktree, and the ref it starts from. An empty gitRef is the
// folder's default branch, which the host fetches first. made marks a draft that already moved into its worktree.
export interface WorktreePlan {
  on: boolean;
  gitRef: string;
  made?: boolean;
}

interface WorktreeDraft {
  cwd: string | undefined;
  chat?: boolean;
  worktree?: WorktreePlan;
}

// Creates the worktree a draft planned, named after text, and returns the draft moved into it with the box
// cleared, so a retried send reuses that folder. A draft with nothing to create, in a folder outside git, or in a
// worktree already comes back as it was.
export async function createDraftWorktree<D extends WorktreeDraft>(draft: D, provider: string | undefined, text: string, call: ApiCall): Promise<D> {
  const plan = draft.worktree;
  if (!plan?.on || draft.chat || !draft.cwd) return draft;
  if (!(await isCheckout(draft.cwd, call))) return draft;
  const data = await call("/api/folder/worktree", { cwd: draft.cwd, name: text, ...(plan.gitRef ? { gitRef: plan.gitRef } : {}), ...(provider ? { provider } : {}) });
  const created = isRecord(data) ? data.path : "";
  if (typeof created !== "string" || !created) throw new Error("Couldn't create the worktree");
  return { ...draft, cwd: created, worktree: { on: false, gitRef: plan.gitRef, made: true } };
}

// The box of a draft moved to another folder: ticked or not as before, from that folder's default branch.
export function keptWorktree(plan: WorktreePlan | undefined): WorktreePlan | undefined {
  return plan ? { on: plan.on || Boolean(plan.made), gitRef: "" } : undefined;
}

// Whether cwd is in a git checkout that is not itself a worktree.
async function isCheckout(cwd: string, call: ApiCall): Promise<boolean> {
  const refs = await call("/api/folder/refs", { cwd });
  return isRecord(refs) && typeof refs.root === "string" && refs.root !== "" && refs.worktree !== true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
