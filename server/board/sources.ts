// Every board source by its provider id, with the parts that work without its connection.

import type { BoardTicket } from "./sharedRules.ts";
import { sakSource, type SakBinding } from "./sak/sakSource.ts";
import { trelloSource, type TrelloBinding } from "./trello/trelloSource.ts";
import { jiraSource, type JiraBinding } from "./jira/jiraSource.ts";

export type BoardBinding = SakBinding | TrelloBinding | JiraBinding;

export type BoardProvider = BoardBinding["provider"];

export interface BoardSource<B extends BoardBinding> {
  // A binding from tickets.json or a new bind, checked and clipped. null when it is malformed.
  binding(input: unknown): B | null;
  rules(origin: string, binding: B, ticket: BoardTicket | null | undefined, tokenFile: string): string;
}

const sources: { [P in BoardProvider]: BoardSource<Extract<BoardBinding, { provider: P }>> } = {
  sak: sakSource,
  trello: trelloSource,
  jira: jiraSource,
};

// A binding or bind request without a known provider is SAK's: older bindings in tickets.json and the page's SAK bind carry none.
export function providerOf(value: unknown): BoardProvider {
  return Object.keys(sources).find((id): id is BoardProvider => id === value) ?? "sak";
}

export function sourceOf(provider: BoardProvider): BoardSource<BoardBinding> {
  return sources[provider];
}
