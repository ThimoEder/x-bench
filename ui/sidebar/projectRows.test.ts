import assert from "node:assert/strict";
import test from "node:test";
import type { SidebarSession } from "../../server/snapshot.ts";
import { isGroup, pages, shownRows } from "./projectRows.ts";

const chat = (id: string, folder?: string): SidebarSession => ({ id, cwd: "/work/app", title: id, updatedAt: "2026-10-01T09:00:00Z", ...(folder ? { folder } : {}) });

test("a list's first page and the revealed ones after it show", () => {
  const list = pages([1, 2, 3, 4, 5], 2, 1);
  assert.deepEqual(list.map((page) => page.items), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(list.map((page) => page.revealed), [true, true, false]);
  assert.deepEqual(pages([], 2), []);
});

test("a project shows the rows on its revealed pages, and an open folder the chats on its own", () => {
  const folders = [{ id: "f1", name: "Auth", collapsed: false }];
  const inFolder = Array.from({ length: 7 }, (_, index) => chat(`in${index}`, "f1"));
  const loose = Array.from({ length: 12 }, (_, index) => chat(`s${index}`));
  const project = { cwd: "/work/app", name: "app", sessions: [...inFolder, ...loose], folders };
  const ids = (extraPages: Record<string, number>, open: boolean) =>
    shownRows(project, project.sessions, extraPages, () => open).map((row) => (isGroup(row) ? row.folder.id : row.id));

  assert.deepEqual(ids({}, true), ["f1", "in0", "in1", "in2", "in3", "in4", ...loose.slice(0, 9).map((session) => session.id)]);
  assert.deepEqual(ids({}, false), ["f1", ...loose.slice(0, 9).map((session) => session.id)]);
  assert.equal(ids({ "/work/app": 1, f1: 1 }, true).length, 1 + 7 + 12);
});
