import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionIndexRow } from "../chat/sessions.ts";
import { type SidebarState, addFolder, arrangeChats, folderNamed, moveToFolder, removeFolder, renameFolder, setFolderCollapsed, arrangeSidebar, archiveSession, dropSession, emptySidebar, nameUntitled, noteChat, notePrompt, pinSession, readSidebar, removeProject, renameSession, reorderProjects, rowsWithCatalog, setProjectCollapsed, showProject, unarchiveSession, unpinSession, writeSidebar } from "./sidebar.ts";

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  assert.ok(item !== undefined, `no item at ${index}`);
  return item;
}

function started(rows: SessionIndexRow[], state = emptySidebar()): SidebarState {
  return rows.reduce((next: SidebarState, row) => {
    if (!row?.id || next.promptedAt[row.id]) return next;
    return notePrompt(next, row.id, row.updatedAt || "2026-09-22T00:00:00Z");
  }, state);
}

test("only the sole chat in an app worktree whose folder exists is marked as owning it", () => {
  const root = "/home/me/.x-bench/worktrees";
  const rows = [
    { id: "own", cwd: `${root}/app-abc123/claude-one/sub`, title: "Own", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "shared-a", cwd: `${root}/app-abc123/claude-two`, title: "A", updatedAt: "2026-09-22T11:00:00Z" },
    { id: "shared-b", cwd: `${root}/app-abc123/claude-two/sub`, title: "B", updatedAt: "2026-09-22T10:00:00Z" },
    { id: "gone", cwd: `${root}/app-abc123/claude-three`, title: "Gone", updatedAt: "2026-09-22T09:00:00Z", gone: true as const },
    { id: "claude", cwd: "/work/app/.claude/worktrees/x", title: "Claude", updatedAt: "2026-09-22T08:00:00Z" },
  ];
  const marked = arrangeSidebar(rows, started(rows), "", null, root)
    .projects.flatMap((project) => project.sessions)
    .filter((session) => session.ownWorktree)
    .map((session) => session.id);
  assert.deepEqual(marked, ["own"]);
});

test("opening a chat does not move it or its project", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
    { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T09:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  assert.deepEqual(first.projects.map((project) => project.name), ["app", "other"]);
  assert.deepEqual(first.projects[0]?.sessions.map((session) => session.id), ["a", "b"]);

  const loaded = arrangeSidebar(
    [
      { id: "a", cwd: "/work/app", title: "A renamed", updatedAt: "2026-09-22T12:00:00Z" },
      { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T18:00:00Z" },
      { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T19:00:00Z" },
    ],
    first.state,
  );
  assert.deepEqual(loaded.projects.map((project) => project.name), ["app", "other"]);
  assert.deepEqual(loaded.projects[0]?.sessions.map((session) => session.id), ["a", "b"]);
  assert.equal(loaded.projects[0]?.sessions[0]?.title, "A renamed");
});

test("project rows carry the rank the sidebar sorts by, not Grok's updated_at", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  // Loading b moves Grok's updated_at; the rank stays at b's last prompt.
  const loaded = arrangeSidebar(
    [
      { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
      { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T18:00:00Z" },
    ],
    first.state,
  );
  assert.deepEqual(loaded.projects[0]?.sessions.map((session) => [session.id, session.rankedAt]), [
    ["a", "2026-09-22T12:00:00Z"],
    ["b", "2026-09-22T11:00:00Z"],
  ]);

  // A chat only in the bridge catalog has no updated_at yet; its prompt ranks it.
  const fresh = rowsWithCatalog(rows, [{ sessionId: "c", cwd: "/work/app", title: "C" }]);
  const next = arrangeSidebar(fresh, notePrompt(first.state, "c", "2026-09-22T20:00:00Z"));
  const c = next.projects[0]?.sessions.find((session) => session.id === "c");
  assert.equal(c?.updatedAt, "");
  assert.equal(c?.rankedAt, "2026-09-22T20:00:00Z");
});

test("a sent message moves that chat to the top of its project", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  const prompted = notePrompt(first.state, "b", "2026-09-22T13:00:00Z");
  const next = arrangeSidebar(
    [
      { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
      { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
    ],
    prompted,
  );
  assert.deepEqual(next.projects[0]?.sessions.map((session) => session.id), ["b", "a"]);
});

test("a new folder is appended and stays there", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T20:00:00Z" },
    { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T09:00:00Z" },
  ];
  const existing = started(rows, {
    ...emptySidebar(),
    projects: [{ cwd: "/work/other", name: "other" }],
    seenAt: { c: "2026-09-22T09:00:00Z" },
  });
  const arranged = arrangeSidebar(rows, existing);
  assert.deepEqual(arranged.projects.map((project) => project.name), ["other", "app"]);
  assert.equal(at(arranged.projects, 0).sessions.length + at(arranged.projects, 1).sessions.length, 2);
});

test("a Grok catalog update refreshes titles and adds a chat without moving the others", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  const synced = arrangeSidebar(
    rowsWithCatalog(
      [
        { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
        { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T18:00:00Z" },
      ],
      [
        { sessionId: "b", cwd: "/work/app", title: "B renamed" },
        { sessionId: "d", cwd: "/work/app", title: "Fresh" },
      ],
    ),
    first.state,
  );
  assert.deepEqual(synced.projects[0]?.sessions.map((session) => session.id), ["a", "b", "d"]);
  assert.equal(synced.projects[0]?.sessions[1]?.title, "B renamed");
  assert.equal(synced.projects[0]?.sessions[2]?.title, "Fresh");
});

test("a chat that arrives only from the catalog keeps its provider", () => {
  const rows = rowsWithCatalog([], [{ sessionId: "b", cwd: "/work/app", title: "Fresh", provider: "grok" }]);
  assert.equal(rows[0]?.provider, "grok");
});

test("a catalog update does not add a subagent as its own chat", () => {
  const rows = rowsWithCatalog(
    [{ id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" }],
    [
      { sessionId: "child", cwd: "/work/app", title: "Read package.json and report project info" },
      { sessionId: "child-2", cwd: "/work/app", title: "Other subtask", sessionKind: "subagent" },
      { sessionId: "fresh", cwd: "/work/app", title: "Fresh" },
    ],
    ["child"],
  );
  assert.deepEqual(rows.map((row) => row.id), ["a", "fresh"]);
});

test("a removed project stays hidden until you start a chat there again", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T10:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  const removed = arrangeSidebar(rows, removeProject(first.state, "/work/other"));
  assert.deepEqual(removed.projects.map((project) => project.name), ["app"]);
  const restored = arrangeSidebar(rows, showProject(removed.state, "/work/other"));
  assert.deepEqual(restored.projects.map((project) => project.name), ["app", "other"]);
});

test("a collapsed project stays collapsed when chats refresh", () => {
  const rows = [{ id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" }];
  const first = arrangeSidebar(rows, started(rows));
  const collapsed = arrangeSidebar(rows, setProjectCollapsed(first.state, "/work/app", true));
  assert.equal(collapsed.projects[0]?.collapsed, true);
});

test("a custom name stays when Grok sends another title", () => {
  const rows = [{ id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" }];
  const first = arrangeSidebar(rows, started(rows));
  const named = arrangeSidebar(
    [{ id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" }],
    renameSession(first.state, "a", "  My chat  "),
  );
  assert.equal(named.projects[0]?.sessions[0]?.title, "My chat");
  const grok = arrangeSidebar(
    rowsWithCatalog(
      [{ id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T18:00:00Z" }],
      [{ sessionId: "a", cwd: "/work/app", title: "Generated" }],
    ),
    named.state,
  );
  assert.equal(grok.projects[0]?.sessions[0]?.title, "My chat");
  const cleared = dropSession(named.state, "a");
  assert.equal(cleared.titles.a, undefined);
});

test("a linked ticket names only a chat without a title of its own", () => {
  const ticket = nameUntitled(emptySidebar(), "a", "Fix login");
  assert.equal(ticket.titles.a, "Fix login");
  assert.equal(nameUntitled(ticket, "a", "Second ticket").titles.a, "Fix login");
  assert.equal(nameUntitled(renameSession(emptySidebar(), "a", "Mine"), "a", "Fix login").titles.a, "Mine");
});

test("dropSession clears bookkeeping for a deleted chat", () => {
  const state = archiveSession(
    notePrompt({ ...emptySidebar(), seenAt: { a: "2026-09-22T12:00:00Z", b: "2026-09-22T11:00:00Z" } }, "a", "2026-09-22T13:00:00Z"),
    "a",
  );
  const next = dropSession(state, "a");
  assert.deepEqual(next.archived, []);
  assert.equal(next.promptedAt.a, undefined);
  assert.equal(next.seenAt.a, undefined);
  assert.equal(next.seenAt.b, "2026-09-22T11:00:00Z");
});

test("archive marks a chat and project order can be changed", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
    { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T10:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  const hidden = arrangeSidebar(
    [
      { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
      { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
      { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T10:00:00Z" },
    ],
    archiveSession(first.state, "a"),
  );
  assert.deepEqual(hidden.projects[0]?.sessions.map((session) => session.id), ["a", "b"]);
  assert.equal(hidden.projects[0]?.sessions[0]?.archived, true);
  assert.equal(at(at(hidden.projects, 0).sessions, 1).archived, undefined);
  const moved = arrangeSidebar(
    [
      { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
      { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T10:00:00Z" },
    ],
    reorderProjects(hidden.state, ["/work/other", "/work/app"]),
  );
  assert.deepEqual(moved.projects.map((project) => project.name), ["other", "app"]);
});

test("unarchive clears the archived mark and keeps the title", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
  ];
  const first = arrangeSidebar(rows, started(rows));
  const hidden = renameSession(archiveSession(notePrompt(first.state, "a", "2026-09-22T13:00:00Z"), "a"), "a", "Kept");
  const marked = arrangeSidebar(rows, hidden);
  assert.equal(marked.projects[0]?.sessions[0]?.archived, true);
  assert.equal(marked.projects[0]?.sessions[0]?.title, "Kept");
  const back = unarchiveSession(hidden, "a");
  assert.deepEqual(back.archived, []);
  assert.equal(back.promptedAt.a, "2026-09-22T13:00:00Z");
  assert.equal(back.titles.a, "Kept");
  const restored = arrangeSidebar(rows, back);
  assert.equal(at(at(restored.projects, 0).sessions, 0).archived, undefined);
  assert.equal(restored.projects[0]?.sessions[0]?.title, "Kept");
  assert.equal(unarchiveSession(first.state, "missing"), first.state);
});

test("a new message takes a chat out of the archive and to the top", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
  ];
  const archived = archiveSession(arrangeSidebar(rows, started(rows)).state, "b");
  const prompted = notePrompt(archived, "b", "2026-09-22T13:00:00Z");
  assert.deepEqual(prompted.archived, []);
  const session = at(arrangeSidebar(rows, prompted).projects, 0).sessions[0];
  assert.equal(session?.id, "b");
  assert.equal(session?.archived, undefined);
});

test("pinned chats lead their project, the latest pin first, and keep their place while others move", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
    { id: "c", cwd: "/work/app", title: "C", updatedAt: "2026-09-22T10:00:00Z" },
    { id: "d", cwd: "/work/app", title: "D", updatedAt: "2026-09-22T09:00:00Z" },
  ];
  const pinned = pinSession(pinSession(started(rows), "d"), "c");
  assert.deepEqual(pinned.pinned, ["c", "d"]);
  assert.equal(pinSession(pinned, "d"), pinned, "pinning a pinned chat leaves its place");
  const arranged = arrangeSidebar(rows, pinned);
  const sessions = at(arranged.projects, 0).sessions;
  assert.deepEqual(sessions.map((session) => session.id), ["c", "d", "a", "b"]);
  assert.deepEqual(sessions.map((session) => session.pinned), [true, true, undefined, undefined]);

  const busy = arrangeSidebar(rows, notePrompt(notePrompt(pinned, "d", "2026-09-22T20:00:00Z"), "b", "2026-09-22T21:00:00Z"));
  assert.deepEqual(at(busy.projects, 0).sessions.map((session) => session.id), ["c", "d", "b", "a"]);

  const back = arrangeSidebar(rows, unpinSession(pinned, "c"));
  assert.deepEqual(at(back.projects, 0).sessions.map((session) => session.id), ["d", "a", "b", "c"]);
  assert.equal(unpinSession(pinned, "missing"), pinned);
});

test("pinned chats lead the chat list too", () => {
  const home = "/home/me/.x-bench/chat";
  const rows = [
    { id: "x", cwd: home, title: "X", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "y", cwd: home, title: "Y", updatedAt: "2026-09-22T11:00:00Z" },
  ];
  const chats = arrangeChats(rows, pinSession(emptySidebar(), "y"), home);
  assert.deepEqual(chats.map((chat) => [chat.id, chat.pinned]), [["y", true], ["x", undefined]]);
});

test("archiving or deleting a chat drops its pin, and pins survive sidebar.json", () => {
  const state = pinSession(pinSession(emptySidebar(), "a"), "b");
  assert.deepEqual(archiveSession(state, "a").pinned, ["b"]);
  assert.deepEqual(unarchiveSession(archiveSession(state, "a"), "a").pinned, ["b"]);
  assert.deepEqual(dropSession(state, "b").pinned, ["a"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-sidebar-"));
  try {
    const file = path.join(dir, "sidebar.json");
    writeSidebar(state, file);
    assert.deepEqual(readSidebar(file).pinned, ["b", "a"]);
    fs.writeFileSync(file, JSON.stringify({ archived: ["z"] }));
    assert.deepEqual(readSidebar(file).pinned, [], "a file from before pins reads with none");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chat sessions stay out of the project list", () => {
  const home = "/work/chat";
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
    { id: "c", cwd: home, title: "Hello", updatedAt: "2026-09-22T13:00:00Z" },
  ];
  const state = started(rows, {
    ...emptySidebar(),
    projects: [
      { cwd: "/work/app", name: "app" },
      { cwd: home, name: "chat" },
    ],
  });
  const arranged = arrangeSidebar(rows, state, home);
  assert.deepEqual(arranged.projects.map((project) => project.cwd), ["/work/app"]);
  assert.deepEqual(arranged.projects[0]?.sessions.map((session) => session.id), ["a", "b"]);
  assert.equal(arranged.state.hidden.includes(home), false);
  assert.equal(arranged.state.projects.some((project) => project.cwd === home), false);
  assert.deepEqual(arrangeChats(rows, arranged.state, home).map((session) => session.id), ["c"]);

  const more = [
    ...rows,
    { id: "d", cwd: home, title: "Later", updatedAt: "2026-09-22T20:00:00Z" },
  ];
  const named = renameSession(notePrompt(arranged.state, "c", "2026-09-22T21:00:00Z"), "c", "Renamed");
  const listed = arrangeChats(more, named, home);
  assert.deepEqual(listed.map((session) => session.id), ["c", "d"]);
  assert.equal(listed[0]?.title, "Renamed");
  const archivedChats = arrangeChats(more, archiveSession(named, "c"), home);
  assert.deepEqual(archivedChats.map((session) => session.id), ["c", "d"]);
  assert.equal(archivedChats[0]?.archived, true);
  assert.equal(archivedChats[0]?.title, "Renamed");
  assert.equal(at(archivedChats, 1).archived, undefined);

  const again = arrangeSidebar(more, named, home);
  assert.deepEqual(again.projects.map((project) => project.cwd), ["/work/app"]);
  assert.deepEqual(again.projects[0]?.sessions.map((session) => session.id), ["a", "b"]);
});

test("a chat kept in a project folder still shows in the chat list", () => {
  const home = "/work/chat";
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "c", cwd: "/work/app", title: "Hello", updatedAt: "2026-09-22T13:00:00Z" },
  ];
  const state = noteChat(arrangeSidebar(rows, started([at(rows, 0)]), home).state, "c");
  const arranged = arrangeSidebar(rows, state, home);
  assert.deepEqual(arranged.projects[0]?.sessions.map((session) => session.id), ["a"]);
  assert.deepEqual(arrangeChats(rows, arranged.state, home).map((session) => session.id), ["c"]);
  assert.deepEqual(dropSession(arranged.state, "c").chatIds, []);
});

test("a folder with only CLI chats stays out of the sidebar", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "cli", cwd: "/work/app", title: "CLI", updatedAt: "2026-09-22T10:00:00Z" },
    { id: "other", cwd: "/work/other", title: "Other", updatedAt: "2026-09-22T16:00:00Z" },
  ];
  const state = {
    ...notePrompt(emptySidebar(), "a", "2026-09-22T12:00:00Z"),
    projects: [
      { cwd: "/work/other", name: "other" },
      { cwd: "/work/app", name: "app" },
    ],
  };
  const arranged = arrangeSidebar(rows, state);
  assert.deepEqual(arranged.projects.map((project) => project.name), ["app"]);
  assert.deepEqual(arranged.projects[0]?.sessions.map((session) => session.id), ["a", "cli"]);
  assert.equal(arranged.state.projects.some((project) => project.cwd === "/work/other"), false);
  assert.equal(arrangeSidebar(rows, arranged.state).changed, false);
});

test("worktree chats live under the project they were started from", () => {
  const locate = (cwd: string) => {
    if (cwd === "/wt/topic") return { home: "/repo", worktree: "topic" };
    if (cwd === "/wt/nested") return { home: "/repo", worktree: "nested" };
    return { home: cwd, worktree: null };
  };
  const rows = [
    { id: "main", cwd: "/repo", title: "Main", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "cli", cwd: "/repo", title: "CLI", updatedAt: "2026-09-22T09:00:00Z" },
    { id: "wt", cwd: "/wt/topic", title: "Topic", updatedAt: "2026-09-22T13:00:00Z" },
    { id: "nested", cwd: "/wt/nested", title: "Nested", updatedAt: "2026-09-22T14:00:00Z" },
  ];
  const state = started([at(rows, 0), at(rows, 2)], {
    ...emptySidebar(),
    projects: [
      { cwd: "/wt/topic", name: "topic" },
      { cwd: "/repo", name: "Custom", collapsed: true },
    ],
  });
  const arranged = arrangeSidebar(rows, state, "/work/chat", locate);
  assert.deepEqual(arranged.projects.map((project) => project.cwd), ["/repo"]);
  assert.equal(arranged.projects[0]?.name, "Custom");
  assert.equal(arranged.projects[0]?.collapsed, true);
  assert.deepEqual(arranged.projects[0]?.sessions.map((session) => session.id), ["nested", "wt", "main", "cli"]);
  assert.equal(arranged.projects[0]?.sessions.find((session) => session.id === "wt")?.cwd, "/wt/topic");
  assert.equal(arranged.projects[0]?.sessions.find((session) => session.id === "wt")?.worktree, "topic");
  assert.equal(arranged.projects[0]?.sessions.find((session) => session.id === "nested")?.worktree, "nested");
  assert.equal(at(arranged.projects, 0).sessions.find((session) => session.id === "main")?.worktree, undefined);
  assert.deepEqual(arranged.state.projects.map((project) => project.cwd), ["/repo"]);
  assert.equal(arrangeSidebar(rows, arranged.state, "/work/chat", locate).changed, false);

  const hidden = arrangeSidebar(rows, removeProject(arranged.state, "/repo"), "/work/chat", locate);
  assert.deepEqual(hidden.projects, []);
  const back = arrangeSidebar(rows, showProject(hidden.state, "/repo"), "/work/chat", locate);
  assert.equal(back.projects[0]?.cwd, "/repo");
  assert.equal(back.projects[0]?.sessions.find((session) => session.id === "wt")?.worktree, "topic");
});

test("a worktree thread remembers the checkout it was started from", () => {
  const rows = [
    { id: "main", cwd: "/repo", title: "Main", updatedAt: "2026-09-22T12:00:00Z" },
    {
      id: "wt",
      cwd: "/wt/2026-09-24-a5a4faa3",
      title: "Simple Test Query from User",
      updatedAt: "2026-09-24T21:32:00Z",
      source: "/repo",
      worktreeLabel: "2026-09-24-a5a4faa3",
    },
    {
      id: "nested",
      cwd: "/wt/nested",
      title: "Nested",
      updatedAt: "2026-09-24T21:40:00Z",
      source: "/wt/2026-09-24-a5a4faa3",
      worktreeLabel: "nested",
    },
  ];
  const locate = (cwd: string) => ({ home: cwd, worktree: null });
  const state = started(rows, {
    ...emptySidebar(),
    projects: [
      { cwd: "/repo", name: "repo" },
      { cwd: "/wt/2026-09-24-a5a4faa3", name: "2026-09-24-a5a4faa3" },
    ],
  });
  const arranged = arrangeSidebar(rows, state, "/work/chat", locate);
  assert.deepEqual(arranged.projects.map((project) => project.cwd), ["/repo"]);
  assert.equal(arranged.projects[0]?.sessions.find((session) => session.id === "wt")?.worktree, "2026-09-24-a5a4faa3");
  assert.equal(arranged.projects[0]?.sessions.find((session) => session.id === "wt")?.cwd, "/wt/2026-09-24-a5a4faa3");
  assert.equal(arranged.projects[0]?.sessions.find((session) => session.id === "nested")?.worktree, "nested");
  assert.equal(arranged.state.projects.some((project) => project.cwd.includes("a5a4faa3")), false);
});

test("a chat started inside a worktree adds the parent project", () => {
  const locate = (cwd: string) => (cwd === "/wt/topic" ? { home: "/repo", worktree: "topic" } : { home: cwd, worktree: null });
  const rows = [
    { id: "wt", cwd: "/wt/topic", title: "Topic", updatedAt: "2026-09-22T13:00:00Z" },
    { id: "cli", cwd: "/repo", title: "CLI", updatedAt: "2026-09-22T09:00:00Z" },
  ];
  const arranged = arrangeSidebar(rows, notePrompt(emptySidebar(), "wt", "2026-09-22T13:00:00Z"), "/work/chat", locate);
  assert.deepEqual(arranged.projects.map((project) => ({ cwd: project.cwd, name: project.name })), [{ cwd: "/repo", name: "repo" }]);
  assert.deepEqual(arranged.projects[0]?.sessions.map((session) => session.id), ["wt", "cli"]);
  const listed = arrangeChats(rows, noteChat(emptySidebar(), "wt"), "/work/chat", locate);
  assert.equal(listed[0]?.worktree, "topic");
  assert.equal(listed[0]?.cwd, "/wt/topic");
});

test("chats sit in their project's folders, which survive sidebar.json, and a removed folder lets its chats go", () => {
  const rows = [
    { id: "a", cwd: "/work/app", title: "A", updatedAt: "2026-09-22T12:00:00Z" },
    { id: "b", cwd: "/work/app", title: "B", updatedAt: "2026-09-22T11:00:00Z" },
    { id: "c", cwd: "/work/other", title: "C", updatedAt: "2026-09-22T10:00:00Z" },
  ];
  const made = addFolder(addFolder(started(rows), "/work/app", "  Auth\n work ", "f1"), "/work/app", "Docs", "f2");
  assert.equal(addFolder(made, "/work/app", "Again", "f1"), made, "an id is taken once");
  assert.equal(folderNamed(made, "/work/app", "auth WORK")?.id, "f1");
  assert.equal(folderNamed(made, "/work/other", "Auth work"), undefined);
  const filed = moveToFolder(made, ["a", "c"], "f1");
  assert.equal(moveToFolder(filed, ["b"], "missing"), filed);
  assert.equal(renameFolder(made, "f2", "auth WORK"), made, "a name another folder of the project has stays with it");
  assert.equal(renameFolder(made, "f1", "Auth Work").folders[0]?.name, "Auth Work");

  const arranged = arrangeSidebar(rows, setFolderCollapsed(renameFolder(filed, "f2", "Notes"), "f2", true));
  const app = at(arranged.projects, 0);
  assert.deepEqual(app.folders, [
    { id: "f1", name: "Auth work", collapsed: false },
    { id: "f2", name: "Notes", collapsed: true },
  ]);
  assert.deepEqual(app.sessions.map((session) => session.folder), ["f1", undefined]);
  const other = at(arranged.projects, 1);
  assert.equal(other.folders, undefined);
  assert.equal(at(other.sessions, 0).folder, undefined, "a folder of another project does not hold the chat");

  assert.deepEqual(moveToFolder(filed, ["a"], null).inFolder, { c: "f1" });
  assert.deepEqual(dropSession(filed, "a").inFolder, { c: "f1" });
  const removed = removeFolder(filed, "f1");
  assert.deepEqual(removed.folders.map((folder) => folder.id), ["f2"]);
  assert.deepEqual(removed.inFolder, {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-build-sidebar-"));
  try {
    const file = path.join(dir, "sidebar.json");
    writeSidebar(filed, file);
    const read = readSidebar(file);
    assert.deepEqual(read.folders, filed.folders);
    assert.deepEqual(read.inFolder, { a: "f1", c: "f1" });
    fs.writeFileSync(file, JSON.stringify({ folders: [{ id: "f1", cwd: "/w", name: "" }, { id: "f2", cwd: "/w", name: "Kept" }], inFolder: { a: "f1", b: "f2" } }));
    assert.deepEqual(readSidebar(file).folders, [{ id: "f2", cwd: "/w", name: "Kept", collapsed: false }], "a folder without a name is dropped");
    assert.deepEqual(readSidebar(file).inFolder, { b: "f2" }, "a chat in a dropped folder is in none");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
