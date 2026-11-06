import { createContext, useContext } from "react";
import type { ServiceNotice, SidebarProject, TicketLink, TicketLinks } from "../server/snapshot.ts";
import type { CallOptions } from "./launchToken.ts";

export interface Desk {
  call: (path: string, body?: unknown, method?: string, options?: CallOptions) => Promise<unknown>;
  notices: ServiceNotice[];
  dismissNotice: (id: string) => void;
  tickets: TicketLinks;
  projects: SidebarProject[];
  platform: string;
  openFile: (sessionId: string, filePath: string) => void;
  openReview: (sessionId: string) => void;
  toggleTerminal: (sessionId: string) => void;
  openProject: (cwd: string, taskId?: TicketLink["taskId"] | null) => void;
}

export const DeskContext = createContext<Desk | null>(null);

export function useDesk(): Desk {
  const desk = useContext(DeskContext);
  if (!desk) throw new Error("useDesk is called outside DeskContext");
  return desk;
}
