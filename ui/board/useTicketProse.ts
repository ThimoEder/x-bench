import { useEffect, useMemo, useState } from "react";
import type { BoardCall } from "./boardData.ts";
import { embedFiles, fileRefs, pendingFile, ticketFiles, ticketImageSrc, ticketVideoSrc, type TicketFile } from "./ticketEmbeds.ts";

// How a ticket's text is drawn, with the pictures and clips it shows from the ticket's files.
export interface TicketProse {
  text: (value: string) => string;
  imageSrc: (filePath: string) => string | null;
  imagePending: (filePath: string) => boolean;
  videoSrc: (filePath: string) => string | null;
}

// The ticket's files are loaded only once its texts show a picture or clip, which only their list resolves.
// byName is the board's embedsByName capability.
export function useTicketProse(taskId: unknown, texts: string[], call: BoardCall, byName: boolean): TicketProse {
  const refs = fileRefs(texts.join("\n"), byName).join("\n");
  const key = `${String(taskId)}\n${refs}`;
  // A list read for another ticket, or before the texts named these files, does not count yet.
  const [loaded, setLoaded] = useState<{ key: string; files: TicketFile[] } | null>(null);
  const files = loaded?.key === key ? loaded.files : null;
  useEffect(() => {
    if (!refs) return;
    let live = true;
    const settle = (list: TicketFile[]) => live && setLoaded({ key, files: list });
    call(`/api/board/tasks/${String(taskId)}/files`, null, "GET", { silent: true, quiet: true })
      .then((data) => settle(ticketFiles(data)))
      .catch(() => settle([]));
    return () => {
      live = false;
    };
  }, [taskId, refs, key, call]);
  return useMemo(() => ({
    text: (value) => embedFiles(value, taskId, files, byName),
    imageSrc: ticketImageSrc,
    imagePending: (filePath) => files === null && filePath === pendingFile(taskId),
    videoSrc: ticketVideoSrc,
  }), [taskId, files, byName]);
}
