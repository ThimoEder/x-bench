import { useRef, useState } from "react";
import type { RefObject } from "react";
import type { PresentedMention } from "../../../server/present.ts";
import { applyMention, mentionQuery, relativeTo } from "./mentions.ts";
import type { SessionCall, TranscriptSession } from "../Transcript.tsx";

export interface MentionsOptions {
  session: Pick<TranscriptSession, "cwd" | "mentions">;
  act: SessionCall;
  // A draft or a chat has no file search.
  drafting: boolean;
  plain: boolean;
  box: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  cursor: number;
  setDraft: (text: string) => void;
  setCursor: (cursor: number) => void;
}

// @ file mentions: a file search for the word at the caret, and the pick that replaces it.
export function useMentions({ session, act, drafting, plain, box, draft, cursor, setDraft, setCursor }: MentionsOptions) {
  const [mentioning, setMentioning] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const searchId = useRef<unknown>("");
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = mentioning ? mentionQuery(draft, cursor) : null;
  const mentions = token ? session.mentions ?? [] : [];

  function syncMention(value: string, nextCursor: number) {
    if (drafting || plain) {
      setMentioning(false);
      return;
    }
    const next = mentionQuery(value, nextCursor);
    if (!next) {
      setMentioning(false);
      if (searchId.current) {
        const id = searchId.current;
        searchId.current = "";
        act("/api/mentions/close", { searchId: id }).catch(() => {});
      }
      return;
    }
    setMentioning(true);
    setMentionIndex(0);
    clearTimeout(mentionTimer.current ?? undefined);
    mentionTimer.current = setTimeout(() => {
      act("/api/mentions", { query: next.query, hidden: next.hidden, searchId: searchId.current })
        .then((result) => {
          if (isRecord(result) && result.searchId) searchId.current = result.searchId;
        })
        .catch(() => {});
    }, 80);
  }

  // Types @ or / at the caret, which opens the file search or the slash menu.
  function insertMark(mark: "@" | "/") {
    const el = box.current;
    const at = el ? el.selectionStart : cursor;
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    const prefix = before.length === 0 || before.endsWith(" ") ? mark : ` ${mark}`;
    const next = `${before}${prefix}${after}`;
    const nextCursor = before.length + prefix.length;
    setDraft(next);
    setCursor(nextCursor);
    syncMention(next, nextCursor);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function chooseMention(match: PresentedMention) {
    const path = relativeTo(session.cwd, match.path as string);
    const next = applyMention(draft, cursor, path);
    setDraft(next.text);
    setCursor(next.cursor);
    setMentioning(false);
    if (searchId.current) {
      const id = searchId.current;
      searchId.current = "";
      act("/api/mentions/close", { searchId: id }).catch(() => {});
    }
  }

  return { mentions, mentionIndex, setMentionIndex, setMentioning, syncMention, insertMark, chooseMention };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
