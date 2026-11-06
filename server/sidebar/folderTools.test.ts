import assert from "node:assert/strict";
import test from "node:test";
import { LIST_LIMIT, folderTools, type ChatFolders } from "./folderTools.ts";
import type { SidebarProject } from "../snapshot.ts";

const project: SidebarProject = {
  cwd: "/work/app",
  name: "app",
  folders: [{ id: "f1", name: "Auth", collapsed: false }],
  sessions: [
    { id: "a", cwd: "/work/app", title: "Login token", updatedAt: "", folder: "f1" },
    { id: "b", cwd: "/work/app", title: "Keychain", updatedAt: "" },
    { id: "z", cwd: "/work/app", title: "Old", updatedAt: "", archived: true },
  ],
};

function tools(found: SidebarProject | null = project) {
  const moves: [string, string[], string][] = [];
  const folders: ChatFolders = {
    projectOf: (id) => (id === "s1" ? found : null),
    move(cwd, ids, name) {
      moves.push([cwd, ids, name]);
      return name !== "Auth";
    },
  };
  const group = folderTools(folders);
  const run = async (name: string, args: unknown, sessionId: string | null = "s1") => {
    const tool = group.tools.find((item) => item.spec.name === name);
    assert.ok(tool);
    const result = await tool.call(args, { sessionId, signal: new AbortController().signal });
    return { error: result.isError, text: result.content[0]?.text ?? "" };
  };
  return { group, moves, run };
}

test("list_chats lists the project's chats with their folders, and the move asks the person", async () => {
  const { group, run } = tools();
  assert.equal(group.tools.find((tool) => tool.spec.name === "list_chats")?.trusted, true);
  assert.equal(group.tools.find((tool) => tool.spec.name === "move_chats_to_folder")?.trusted, undefined);
  const listed = await run("list_chats", {});
  assert.equal(listed.error, false);
  assert.equal(listed.text, ["Project app (/work/app).", "Folders: Auth.", "Chats, as id | title | folder:", "a | Login token | Auth", "b | Keychain | -"].join("\n"));
  assert.equal((await run("list_chats", {}, "elsewhere")).error, true);
  assert.equal((await run("list_chats", {}, null)).error, true);
});

test("move_chats_to_folder moves the project's chats and leaves others out", async () => {
  const { moves, run } = tools();
  const moved = await run("move_chats_to_folder", { chat_ids: ["b", "b", "x"], folder: " Auth " });
  assert.deepEqual(moved, { error: false, text: "Moved 1 chat into the folder Auth. Left out, not in app: x." });
  assert.deepEqual((await run("move_chats_to_folder", { chat_ids: ["a", "b"], folder: "Docs" })).text, "Moved 2 chats into the new folder Docs.");
  assert.deepEqual(moves, [["/work/app", ["b"], "Auth"], ["/work/app", ["a", "b"], "Docs"]]);

  assert.equal((await run("move_chats_to_folder", { chat_ids: ["x"], folder: "Auth" })).error, true);
  assert.equal((await run("move_chats_to_folder", { chat_ids: ["a"], folder: "  " })).error, true);
  assert.equal(moves.length, 2);
});

test("list_chats shows the most recent chats up to its limit, and query finds older ones by title", async () => {
  const sessions = Array.from({ length: LIST_LIMIT + 5 }, (_, index) => ({ id: `c${index}`, cwd: "/work/app", title: index === LIST_LIMIT + 4 ? "Old Auth login fix" : `Chat ${index}`, updatedAt: "" }));
  const { run } = tools({ cwd: "/work/app", name: "app", sessions });
  const listed = (await run("list_chats", {})).text.split("\n");
  assert.equal(listed.filter((line) => line.startsWith("c")).length, LIST_LIMIT);
  assert.equal(listed.at(-1), "5 older chats left out. Pass query to find them by title.");
  const found = await run("list_chats", { query: "  auth LOGIN " });
  assert.equal(found.text.split("\n").slice(2).join("\n"), 'Chats with "auth login" in the title, as id | title | folder:\nc104 | Old Auth login fix | -');
});
