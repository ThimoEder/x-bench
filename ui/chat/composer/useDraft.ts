import { useRef, useState } from "react";
import type { Attachment } from "./attachments.ts";
import { useComposerDraft, writeComposerDraft } from "./composerDrafts.ts";

// A session's unsent text and files (kept in composerDrafts.ts) and the caret in the box.
// The refs follow every write, so a handler that awaited still reads the latest draft.
export function useDraft(sessionId: string) {
  const composer = useComposerDraft(sessionId);
  const draft = composer.text;
  const [cursor, setCursor] = useState(0);
  const attachments = composer.attachments;
  const filesRef = useRef<Attachment[]>([]);
  const draftRef = useRef("");
  draftRef.current = draft;
  filesRef.current = attachments;

  function remember(text: string, nextFiles: Attachment[] = filesRef.current) {
    const files = Array.isArray(nextFiles) ? nextFiles : [];
    draftRef.current = String(text ?? "");
    filesRef.current = files;
    return writeComposerDraft(sessionId, { text: draftRef.current, attachments: files });
  }

  function setDraft(text: string) {
    remember(text);
  }

  function replaceAttachments(next: Attachment[]) {
    remember(draftRef.current, next);
  }

  return { draft, attachments, cursor, setCursor, draftRef, filesRef, remember, setDraft, replaceAttachments };
}
