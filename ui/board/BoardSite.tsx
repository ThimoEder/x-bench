import { useEffect, useRef } from "react";
import { BackIcon, ExternalIcon } from "./boardIcons.tsx";
import { usePaneBounds } from "../browser/browserPane.ts";

export interface BoardSitePage {
  // The board folder it opened for. It shows only over that board.
  cwd: string;
  owner: string;
  href: string;
  source: string;
  title: string;
}

// A page the board asks to open: a ticket's, or the board's own for a null taskId.
export type BoardSiteRequest = Pick<BoardSitePage, "href" | "source" | "title"> & { taskId: unknown };

export function BoardSite({ page, onBack }: { page: BoardSitePage; onBack: () => void }) {
  const slot = useRef<HTMLDivElement | null>(null);
  usePaneBounds(slot, page.owner, true);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <section className="board-site" aria-label={page.source}>
      <div className="board-site-bar">
        <button type="button" className="text-button" onClick={onBack}>
          <BackIcon />
          Board
        </button>
        <span className="board-site-title">
          {page.source}
          <span>{` · ${page.title}`}</span>
        </span>
        <a className="text-button" href={page.href} target="_blank" rel="noreferrer">
          <ExternalIcon />
          Open in browser
        </a>
      </div>
      <div className="board-site-slot" ref={slot} />
    </section>
  );
}
