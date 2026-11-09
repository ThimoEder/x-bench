import { useState } from "react";
import type { SidebarProject } from "../../server/snapshot.ts";
import type { TranscriptSession } from "../chat/Transcript.tsx";
import { useDesk } from "../deskContext.ts";
import { BoardIcon } from "../sidebar/icons.tsx";
import { storedFlag } from "../stored.ts";

const DECLINED_KEY = "x-bench-board-offer:";

export function boardOfferDue(project: SidebarProject, boarded: boolean, sessionId: string): boolean {
  const [only, ...rest] = project.sessions;
  return !boarded && only?.id === sessionId && rest.length === 0 && !storedFlag(DECLINED_KEY + project.cwd, false);
}

export function BoardOffer({ session }: { session: TranscriptSession }) {
  const { tickets, projects, createBoard } = useDesk();
  const [declined, setDeclined] = useState("");
  const project = projects.find((item) => item.sessions.some((row) => row.id === session.id));
  const replied = !session.loading && session.transcript.some((item) => item.type === "assistant");
  if (!project || !replied || declined === project.cwd || !boardOfferDue(project, Boolean(tickets?.boards?.includes(project.cwd)), session.id)) return null;
  const { cwd, name } = project;

  // Create board only opens the sheet: the card goes once the folder has a board, and stays when the sheet is cancelled.
  function decline() {
    setDeclined(cwd);
    try {
      localStorage.setItem(DECLINED_KEY + cwd, "1");
    } catch {
      // Without storage the card stays hidden until the app restarts.
    }
  }

  return (
    <section className="board-offer" data-testid="board-offer" aria-label={`Give ${name} a board`}>
      <span className="board-offer-icon"><BoardIcon /></span>
      <span className="board-offer-text">
        <b>Give {name} a board</b>
        <span>Then agents can file tickets, link chats to them and move them as they work.</span>
      </span>
      <button type="button" onClick={decline}>Not now</button>
      <button type="button" className="primary" onClick={() => createBoard({ cwd, name })}>Create board</button>
    </section>
  );
}
