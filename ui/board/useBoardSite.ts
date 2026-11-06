import { useCallback, useState } from "react";
import { desktopBridge } from "../browser/browserPane.ts";
import type { BoardSitePage, BoardSiteRequest } from "./BoardSite.tsx";
import type { BoardLink } from "./ProjectBoard.tsx";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function useBoardSite(call: (path: string, body?: unknown, method?: string, options?: { silent?: boolean }) => Promise<unknown>, cwd: string | null) {
  const [boardLink, setBoardLink] = useState<BoardLink | null>(null);
  const [sitePage, setSitePage] = useState<BoardSitePage | null>(null);
  const closeSite = useCallback(() => setSitePage(null), []);

  // A page of the board's own site opens over the board, signed in, in the desktop app; elsewhere it opens in
  // the browser.
  async function openBoardSite({ taskId, href, source, title }: BoardSiteRequest) {
    const outside = () => window.open(href, "_blank", "noreferrer");
    if (!desktopBridge() || !cwd) {
      outside();
      return;
    }
    try {
      const opened = await call("/api/board/open", { cwd, ...(taskId === null ? {} : { taskId }) }, "POST", { silent: true });
      const owner = isRecord(opened) && typeof opened.owner === "string" ? opened.owner : "";
      if (owner) setSitePage({ cwd, owner, href, source, title });
      else outside();
    } catch {
      outside();
    }
  }

  function forget() {
    setBoardLink(null);
    setSitePage(null);
  }

  return { boardLink, setBoardLink, sitePage: sitePage?.cwd === cwd ? sitePage : null, closeSite, openBoardSite, forget };
}
