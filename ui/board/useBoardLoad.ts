import { useEffect, useRef, useState } from "react";
import { watchGit } from "../git/gitWatch.ts";
import { keepBoard, keptBoard, reloadKept } from "./boardCache.ts";
import { addressOf, boardView, canDo, isRecord, messageOf, sourceName, UNREADABLE_BOARD, withSettings, type BoardCall, type BoardView } from "./boardData.ts";
import type { BoardLink } from "./ProjectBoard.tsx";

interface BoardLoadOptions {
  cwd: string;
  query: string;
  call: BoardCall;
  refreshKey?: unknown;
  reload: number;
  onLink?: (link: BoardLink | null) => void;
}

export function useBoardLoad({ cwd, query, call, refreshKey, reload, onLink }: BoardLoadOptions) {
  const [board, setBoard] = useState<BoardView | null>(() => keptBoard(cwd));
  const [failure, setFailure] = useState("");
  const [address, setAddress] = useState("");
  const [poll, setPoll] = useState(0);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [reloading, setReloading] = useState(false);
  // A board for this folder and search is on screen, and a failed load leaves it there.
  const loaded = useRef(false);
  const activity = useRef<unknown>("");
  const loads = useRef(0);

  // A write through this host reloads the board through refreshKey, so polling only picks up edits made elsewhere.
  const local = canDo(board, "local");
  useEffect(() => watchGit(() => setPoll((value) => value + 1), local ? 10_000 : 60_000, 60_000), [local, cwd]);

  // Only the board without a search is kept, so a search starts without a stamp.
  useEffect(() => {
    const kept = query ? null : keptBoard(cwd);
    loaded.current = kept !== null;
    activity.current = kept?.activity || "";
    if (kept) setBoard(kept);
  }, [cwd, query]);

  const hasBoard = board !== null;
  const siteUrl = typeof board?.url === "string" ? board.url : "";
  const siteSource = sourceName(board);
  const signedIn = canDo(board, "signedInPages");
  useEffect(() => {
    if (hasBoard) onLink?.(siteUrl ? { url: siteUrl, source: siteSource, signedIn } : null);
  }, [hasBoard, siteUrl, siteSource, signedIn, onLink]);

  useEffect(() => {
    function onFocus() {
      setPoll((value) => value + 1);
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let cancel = false;
    loads.current += 1;
    const load = loads.current;
    if (!loaded.current) setFailure("");
    const params = new URLSearchParams({ cwd });
    if (query) params.set("search", query);
    async function savedFirst() {
      if (query || keptBoard(cwd)) return;
      const saved = boardView(await call(`/api/board/board?${new URLSearchParams({ cwd, saved: "1" })}`, null, "GET", { quiet: true }).catch(() => null));
      if (!saved || cancel || loaded.current) return;
      loaded.current = true;
      keepBoard(cwd, saved);
      setBoard(saved);
    }
    savedFirst()
      .then(() => {
        if (cancel) return null;
        if (activity.current) params.set("activity", String(activity.current));
        return call(`/api/board/board?${params}`, null, "GET", { quiet: true });
      })
      .then((data) => {
        const view = boardView(data);
        const unchanged = isRecord(data) && data.unchanged === true;
        // The settings can change while the board stays as it is.
        const settings = isRecord(data) ? data.settings : undefined;
        // The newest load is kept even when it ends after the page left the board.
        if (!query && load === loads.current) {
          const kept = unchanged ? keptBoard(cwd) : null;
          const next = view ?? (kept && withSettings(kept, settings));
          if (next && next !== kept) keepBoard(cwd, next);
        }
        if (cancel) return;
        setReloading(false);
        if (isRecord(data) && unchanged) {
          setBoard((current) => current && withSettings(current, settings));
          setCheckedAt(new Date());
          loaded.current = true;
          activity.current = data.activity || activity.current;
          return;
        }
        if (!view) throw new Error(UNREADABLE_BOARD);
        loaded.current = true;
        activity.current = view.activity || "";
        setCheckedAt(new Date());
        setBoard(view);
      })
      .catch((error: unknown) => {
        if (cancel) return;
        setReloading(false);
        if (loaded.current) return;
        setBoard(null);
        setFailure(messageOf(error));
        setAddress(addressOf(error));
      });
    return () => {
      cancel = true;
    };
  }, [cwd, query, refreshKey, reload, poll, call]);

  function reloadAll() {
    activity.current = "";
    reloadKept();
    setReloading(true);
    setPoll((value) => value + 1);
  }

  return { board, setBoard, failure, address, poll, checkedAt, reloading, reloadAll };
}
