import { useEffect, useMemo, useState } from "react";
import type { OpenSession } from "../../server/snapshot.ts";
import { loadingSession, type Opening } from "../dock/deskView.ts";
import type { CallOptions } from "../launchToken.ts";

export type LoadingSession = OpenSession & { loading: true };

// The sidebar row of the chat being opened, which names it until the host's copy arrives.
export interface ChatRow {
  id: string;
  cwd: string;
  title?: string | null;
  provider?: string;
}

export interface ChatOpenerOptions {
  call: (path: string, body?: unknown, method?: string, options?: CallOptions) => Promise<unknown>;
  // Shows the chat on the desk while it loads, or takes it down (null).
  show: (opening: Opening<LoadingSession> | null) => void;
  // Swaps the shown chat for its stored copy, if that chat is still the one shown.
  showStored: (sessionId: string, session: LoadingSession) => void;
  fail: (message: string) => void;
}

// Opens chats so the last one asked for wins: the answers for an earlier open change nothing.
export function chatOpener({ call, show, showStored, fail }: ChatOpenerOptions) {
  let turn = 0;
  return {
    open(row: ChatRow, cwd: string | null, place: Opening<LoadingSession>["place"] = "replace") {
      const mine = ++turn;
      const current = () => turn === mine;
      show({ session: loadingSession(row), place });
      call("/api/preview", { sessionId: row.id, cwd: row.cwd }, "POST", { silent: true })
        .then((data) => {
          const stored = storedChat(data);
          if (stored && current()) showStored(row.id, loadingSession(row, stored));
        })
        .catch(() => {});
      const where = place === "replace" ? {} : place === "beside" ? { beside: true } : { replaceId: place.replaceId };
      call("/api/load", { sessionId: row.id, cwd, ...where }, "POST", { silent: true }).then(
        // A load another page started meanwhile overtook this one, so the host's desk never lists this chat.
        (data) => {
          if (current() && isRecord(data) && data.overtaken) show(null);
        },
        (error: unknown) => {
          if (!current()) return;
          show(null);
          fail(error instanceof Error && error.message ? error.message : "Couldn't open the chat");
        },
      );
    },
    // Takes the turn for an open the page runs itself: current() turns false once another open or a cancel comes.
    claim(): () => boolean {
      const mine = ++turn;
      return () => turn === mine;
    },
    // The page went elsewhere: answers still on their way change nothing.
    cancel() {
      turn += 1;
      show(null);
    },
  };
}

export function useChatOpener(call: ChatOpenerOptions["call"], fail: ChatOpenerOptions["fail"], open: readonly OpenSession[]) {
  const [opening, setOpening] = useState<Opening<LoadingSession> | null>(null);
  const opener = useMemo(
    () =>
      chatOpener({
        call,
        show: setOpening,
        showStored: (sessionId, session) => setOpening((shown) => (shown?.session.id === sessionId ? { ...shown, session } : shown)),
        fail,
      }),
    [call, fail],
  );

  useEffect(() => {
    if (opening && open.some((session) => session.id === opening.session.id)) setOpening(null);
  }, [opening, open]);

  return { opening, opener };
}

// The host builds a stored chat the way it builds the open sessions it publishes.
function isStoredChat(value: unknown): value is OpenSession {
  return isRecord(value) && Array.isArray(value.transcript);
}

// /api/preview answers a chat the host built from its stored log, or null.
function storedChat(data: unknown): OpenSession | null {
  return isRecord(data) && isStoredChat(data.session) ? data.session : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
