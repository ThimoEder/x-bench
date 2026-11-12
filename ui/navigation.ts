import { useEffect, useEffectEvent, useReducer } from "react";
import { boardSearch, boardTarget } from "../server/board/boardLink.ts";
import { routineSearch, routinesTarget } from "./routines/routineLink.ts";
import type { SettingsTab } from "./settings/Settings.tsx";

// What covers the desk. ProjectBoard selects a task id as the board sent it.
export type Page = { page: "desk" } | { page: "board"; cwd: string; taskId: unknown } | { page: "routines" } | { page: "needs" };

export type View = Page & { settings: SettingsTab | null };

export type NavAction =
  // Settings close, except ones opened after settingsAtStart was read.
  | { type: "go"; to: Page; settingsAtStart?: SettingsTab | null }
  // Back to the desk. With board, only from that folder's board.
  | { type: "leave"; board?: string }
  | { type: "settings"; tab: SettingsTab | null }
  | { type: "task"; taskId: unknown };

export const DESK: Page = { page: "desk" };
export const ROUTINES: Page = { page: "routines" };
export const NEEDS: Page = { page: "needs" };

export function navigate(view: View, action: NavAction): View {
  switch (action.type) {
    case "go": {
      const keep = action.settingsAtStart !== undefined && view.settings !== action.settingsAtStart;
      return { ...action.to, settings: keep ? view.settings : null };
    }
    case "leave":
      if (action.board !== undefined && (view.page !== "board" || view.cwd !== action.board)) return view;
      return { ...DESK, settings: null };
    case "settings":
      return { ...view, settings: action.tab };
    case "task":
      return view.page === "board" ? { ...view, taskId: action.taskId } : view;
  }
}

export function pageFromSearch(search: string): Page {
  const board = boardTarget(search);
  if (board.cwd) return { page: "board", cwd: board.cwd, taskId: board.taskId };
  if (new URLSearchParams(search).has("needs")) return NEEDS;
  return routinesTarget(search) ? ROUTINES : DESK;
}

export function viewFromSearch(search: string): View {
  return { ...pageFromSearch(search), settings: null };
}

export function searchFor(page: Page): string {
  if (page.page === "routines") return routineSearch();
  if (page.page === "needs") return "?needs";
  return page.page === "board" ? boardSearch({ cwd: page.cwd, taskId: page.taskId }) : "";
}

// Mirrors the view in the address. Back and Forward call onPop with the page the address names.
export function useNavigation(onPop: (page: Page) => void) {
  const [view, dispatch] = useReducer(navigate, window.location.search, viewFromSearch);
  const search = searchFor(view);
  useEffect(() => {
    if (search === window.location.search) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [search]);

  const popped = useEffectEvent(() => onPop(pageFromSearch(window.location.search)));
  useEffect(() => {
    const pop = () => popped();
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  return [view, dispatch] as const;
}
