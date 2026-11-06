import { useSyncExternalStore } from "react";
import type { Attachment } from "./attachments.ts";

export interface ComposerDraft {
  text: string;
  attachments: Attachment[];
}

const EMPTY_FILES: Attachment[] = [];
const EMPTY: ComposerDraft = { text: "", attachments: EMPTY_FILES };
const drafts = new Map<string, ComposerDraft>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeComposerDrafts(listener: () => void): () => boolean {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readComposerDraft(id: string | null | undefined): ComposerDraft {
  if (!id) return EMPTY;
  return drafts.get(id) || EMPTY;
}

// The revision stays put when the write changes nothing, so a failed send can
// tell a newer draft from the optimistic clear it is allowed to undo.
export function writeComposerDraft(id: string | null | undefined, draft: Partial<ComposerDraft> = {}): number {
  // Nothing is ever stored under an empty id.
  if (!id) return 0;
  const text = typeof draft.text === "string" ? draft.text : "";
  const attachments = Array.isArray(draft.attachments) && draft.attachments.length ? draft.attachments : EMPTY_FILES;
  const prev = drafts.get(id);
  const revision = revisions.get(id) || 0;
  if (!text && attachments === EMPTY_FILES) {
    if (!prev) return revision;
    drafts.delete(id);
    revisions.set(id, revision + 1);
    emit();
    return revision + 1;
  }
  if (prev && prev.text === text && prev.attachments === attachments) return revision;
  drafts.set(id, { text, attachments });
  revisions.set(id, revision + 1);
  emit();
  return revision + 1;
}

export function restoreComposerDraft(
  id: string | null | undefined,
  draft: Partial<ComposerDraft>,
  revision: number,
): boolean {
  if (!id || (revisions.get(id) || 0) !== revision) return false;
  writeComposerDraft(id, draft);
  return true;
}

export function useComposerDraft(id: string | null | undefined): ComposerDraft {
  return useSyncExternalStore(
    subscribeComposerDrafts,
    () => readComposerDraft(id),
    () => EMPTY,
  );
}

export function resetComposerDrafts(): void {
  if (drafts.size === 0 && revisions.size === 0) return;
  drafts.clear();
  revisions.clear();
  emit();
}
