import { useState } from "react";
import type { TicketLink } from "../../server/snapshot.ts";
import type { SessionCall, TranscriptSession } from "../chat/Transcript.tsx";
import { useDesk } from "../deskContext.ts";
import { CloseIcon } from "../icons.tsx";
import { ticketNumber } from "./TicketCreate.tsx";
import { statusKey } from "./ticketStatus.ts";

export interface TicketDoneProps {
  session: TranscriptSession;
  // A turn still runs, and archiving would stop it.
  running: boolean;
  act: SessionCall;
}

export function doneTicket(links: readonly TicketLink[] | undefined): TicketLink | null {
  const rows = links ?? [];
  return rows.every((link) => statusKey(link.status) === "done") ? (rows.find((link) => link.cleanup) ?? null) : null;
}

// A row in the shelf once the chat's ticket moved from Review to Done: archive the chat, with the worktree it has to itself, or keep it.
export function TicketDone({ session, running, act }: TicketDoneProps) {
  const { tickets, projects, call } = useDesk();
  const [busy, setBusy] = useState<"" | "archive" | "keep">("");
  const link = doneTicket(tickets?.bySession?.[session.id]);
  if (!link || running || session.archived) return null;
  const ownWorktree = projects.some((project) => project.sessions.some((item) => item.id === session.id && item.ownWorktree));

  // The archive route clears the flag itself, after the archive went through.
  async function answer(archive: boolean) {
    setBusy(archive ? "archive" : "keep");
    try {
      if (archive) {
        await act("/api/archive", ownWorktree ? { worktree: true } : {});
        await act("/api/leave");
      } else {
        await call("/api/board/links/cleanup", { sessionId: session.id }, "DELETE");
      }
    } catch {
      // The banner shows what failed.
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="shelf-notice ticket-done" role="status">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m3.5 8.3 3 3 6-6.6" />
      </svg>
      <span className="shelf-notice-text">
        <b>{ticketNumber(link) ?? link.title}</b> · Done · {ownWorktree ? "Archive this chat and its worktree?" : "Archive this chat?"}
      </span>
      <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void answer(true)}>
        {busy === "archive" ? "Archiving…" : "Archive"}
      </button>
      <button type="button" className="icon" disabled={Boolean(busy)} aria-label="Keep this chat" title="Keep this chat" onClick={() => void answer(false)}>
        <CloseIcon />
      </button>
    </div>
  );
}
