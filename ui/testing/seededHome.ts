// The data a seeded browser test opens on: a project with chats and a bound local board, and a chat on the chat
// surface. The fake agent writes the transcripts from its own scripts, so a prompt with the same word draws the
// same rows live.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_DIALECT, createFakeAgent, emptyStore } from "../../bridge/testing/fakeAgent.ts";
import type { TicketsState } from "../../server/board/tickets.ts";
import type { IndexedSession } from "../../server/chat/sessionIndex.ts";
import type { SidebarState } from "../../server/sidebar/sidebar.ts";
import { startFakeSak, type FakeSakBoard } from "../../server/testing/fakeSak.ts";

const TOKEN = "sak_seeded";

export const SEED = {
  project: "atlas",
  board: "Atlas",
  chats: { tools: "Tidy the shopping list", text: "Table tennis", chat: "Quick question" },
  tickets: { open: "Write the changelog", active: "Wrap long links", parent: "Ship the board", review: "Review the label colors", done: "Sketch the columns", unset: "Someday: dark mode" },
} as const;

const DAY = "2026-01-14T09:00:00.000Z";

const LABELS = [
  { id: 1, project_id: 1, title: "bug", color: "#e5484d" },
  { id: 2, project_id: 1, title: "design", color: "#3e63dd" },
  { id: 3, project_id: 1, title: "docs", color: null },
];

const BOARD: FakeSakBoard = {
  project: { id: 1, title: SEED.board },
  labels: LABELS,
  tasks: [
    ticket(1, SEED.tickets.parent, "active", { description: "The board draws **every column** with its tickets.\n\n- [x] Columns\n- [ ] Labels", relations: [{ task_id: 2, kind: "subtask" }, { task_id: 3, kind: "subtask" }] }),
    ticket(2, SEED.tickets.done, "done", { labels: [2], relations: [{ task_id: 1, kind: "parent" }] }),
    ticket(3, SEED.tickets.review, "review", { labels: [2], relations: [{ task_id: 1, kind: "parent" }, { task_id: 4, kind: "blocked_by" }] }),
    ticket(4, SEED.tickets.active, "active", { labels: [1], description: "A long link runs out of the message bubble.", note: "Seen on a phone first.", relations: [{ task_id: 3, kind: "blocks" }] }),
    ticket(5, SEED.tickets.open, "open", { labels: [3] }),
    ticket(6, SEED.tickets.unset, null),
  ],
  now: "2026-01-15T10:30:00.000Z",
  comments: {
    4: [
      { id: 1, task_id: 4, body: "It also happens in the **queue**.", created_at: "2026-01-14T11:00:00.000Z" },
      { id: 2, task_id: 4, body: "Fixed in the bubble, the queue is next.", created_at: "2026-01-15T08:15:00.000Z" },
    ],
  },
};

function ticket(id: number, title: string, status: string | null, { labels = [], ...rest }: { labels?: number[]; description?: string; note?: string; relations?: { task_id: number; kind: string }[] } = {}): FakeSakBoard["tasks"][number] {
  return { id, reference: null, project_id: 1, title, description: null, note: null, revision: 1, created_at: DAY, updated_at: DAY, attributes: status ? { status } : {}, relations: [], labels: LABELS.filter((label) => labels.includes(label.id)), ...rest };
}

// Runs before the host starts: the fake agent reads its store once, as it starts.
export async function seedHome(home: string): Promise<{ stop(): Promise<void> }> {
  const project = path.join(home, SEED.project);
  const chatHome = path.join(home, ".x-bench", "chat");
  for (const folder of [project, chatHome, path.join(home, ".x-bench", "dev")]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(project, "notes.txt"), "Buy oat milk\nCall Ada\n");

  const chats = [
    { title: SEED.chats.tools, cwd: project, at: "2026-01-15T09:40:00.000Z", prompts: ["Show me your TOOLS on the shopping list."] },
    { title: SEED.chats.text, cwd: project, at: "2026-01-14T16:20:00.000Z", prompts: ["ping", "And once more: ping"] },
    { title: SEED.chats.chat, cwd: chatHome, at: "2026-01-13T08:05:00.000Z", prompts: ["ping"] },
  ];
  const store = emptyStore();
  const agent = createFakeAgent(CLAUDE_DIALECT, store, { send() {}, crash() {} });
  const sessions = chats.map(({ title, cwd, at, prompts }): IndexedSession => {
    const id = `fake-${store.next}`;
    agent({ id: 1, method: "session/new", params: { cwd } });
    for (const text of prompts) agent({ id: 1, method: "session/prompt", params: { sessionId: id, prompt: [{ type: "text", text }] } });
    return { id, provider: "claude", harnessId: id, cwd, title, createdAt: at, updatedAt: at };
  });
  writeFileSync(path.join(home, "fake-claude.json"), JSON.stringify(store));
  writeFileSync(path.join(home, ".x-bench", "sessions.json"), JSON.stringify({ sessions }));
  // The sidebar lists a project once a chat in it was prompted, and keeps the chat surface's chats by id.
  const sidebar: Partial<SidebarState> = {
    chatIds: sessions.filter((session) => session.cwd === chatHome).map((session) => session.id),
    promptedAt: Object.fromEntries(sessions.map((session) => [session.id, session.updatedAt])),
  };
  writeFileSync(path.join(home, ".x-bench", "sidebar.json"), JSON.stringify(sidebar));

  const sak = await startFakeSak(BOARD, TOKEN);
  writeFileSync(path.join(home, ".x-bench", "dev", "sak.json"), JSON.stringify({ baseUrl: sak.baseUrl, token: TOKEN, enabled: true }));
  const tickets: TicketsState = {
    bindings: { [project]: { provider: "sak", projectId: BOARD.project.id, title: SEED.board } },
    links: [{ sessionId: sessions[0]?.id ?? "", taskId: 4, projectId: BOARD.project.id, title: SEED.tickets.active, reference: null, status: "active" }],
  };
  writeFileSync(path.join(home, ".x-bench", "tickets.json"), JSON.stringify(tickets));
  return sak;
}
