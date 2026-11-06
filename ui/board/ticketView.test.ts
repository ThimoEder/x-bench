import assert from "node:assert/strict";
import test from "node:test";
import { avatarTone, dropIndex, hideCollapsed, nestCards, placeAmong, dueState, initials, nextCard, personCounts, personMatch, placeInOrder, relativeTime, reorderTasks } from "./ticketView.ts";

test("initials take the first and last word, or a single word's first two letters", () => {
  assert.equal(initials("Thimo Eder"), "TE");
  assert.equal(initials("Lena Maria Hofmann"), "LH");
  assert.equal(initials("claude"), "CL");
  assert.equal(initials("  "), "?");
  assert.equal(avatarTone("Thimo Eder"), avatarTone("Thimo Eder"));
});

test("a comment time reads as minutes, hours, yesterday or a day", () => {
  const now = new Date(2026, 9, 3, 12, 0);
  assert.equal(relativeTime(new Date(2026, 9, 3, 11, 59, 40).toISOString(), now), "just now");
  assert.equal(relativeTime(new Date(2026, 9, 3, 11, 52).toISOString(), now), "8 min ago");
  assert.equal(relativeTime(new Date(2026, 9, 3, 9, 30).toISOString(), now), "2 h ago");
  assert.equal(relativeTime(new Date(2026, 9, 2, 16, 42).toISOString(), now), "Yesterday 16:42");
  assert.equal(relativeTime(new Date(2026, 8, 24, 10, 0).toISOString(), now), "Sep 24");
  assert.equal(relativeTime(new Date(2025, 8, 24, 10, 0).toISOString(), now), "Sep 24, 2025");
  assert.equal(relativeTime("not a date", now), "");
  assert.equal(relativeTime(null, now), "");
});

test("a due date turns late after its day, unless the ticket is done", () => {
  const now = new Date(2026, 9, 3, 12, 0);
  assert.deepEqual(dueState("2026-10-10", false, now), { label: "Oct 10", late: false, lateLabel: "" });
  assert.deepEqual(dueState("2026-09-30", false, now), { label: "Sep 30", late: true, lateLabel: "3 days late" });
  assert.deepEqual(dueState("2026-10-02", false, now), { label: "Oct 2", late: true, lateLabel: "1 day late" });
  assert.deepEqual(dueState("2026-10-03", false, now), { label: "Oct 3", late: false, lateLabel: "" });
  assert.deepEqual(dueState(new Date(2026, 9, 3, 9, 0).toISOString(), false, now), { label: "Oct 3", late: true, lateLabel: "Overdue" });
  assert.equal(dueState("2026-09-30", true, now)?.late, false);
  assert.equal(dueState(null, false, now), null);
});

test("a dropped card lands before the first card whose middle is below the pointer", () => {
  assert.equal(dropIndex([10, 50, 90], 5), 0);
  assert.equal(dropIndex([10, 50, 90], 60), 2);
  assert.equal(dropIndex([10, 50, 90], 95), 3);
  assert.equal(dropIndex([], 95), 0);
  assert.deepEqual(placeInOrder(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(placeInOrder(["a", "b"], "x", 1), ["a", "x", "b"]);
  assert.deepEqual(placeInOrder(["a", "b"], "x", 9), ["a", "b", "x"]);
});

test("the board keeps a moved task next to its new neighbors", () => {
  const tasks = ["a", "b", "c", "d"];
  const same = (id: string) => id;
  assert.deepEqual(reorderTasks(tasks, same, "d", ["d", "a"]), ["d", "a", "b", "c"]);
  assert.deepEqual(reorderTasks(tasks, same, "a", ["c", "a"]), ["b", "c", "a", "d"]);
  assert.deepEqual(reorderTasks(tasks, same, "b", ["b"]), ["a", "c", "d", "b"]);
  assert.deepEqual(reorderTasks(tasks, same, "z", ["z"]), tasks);
});

test("the person filter keeps everyone, my tickets, the unassigned or one person's", () => {
  assert.equal(personMatch([], null, "me"), true);
  assert.equal(personMatch(["lena"], "me", "me"), false);
  assert.equal(personMatch(["lena", "me"], "me", "me"), true);
  assert.equal(personMatch(["me"], "me", null), false);
  assert.equal(personMatch([], "none", "me"), true);
  assert.equal(personMatch(["me"], "none", "me"), false);
  assert.equal(personMatch(["lena"], "lena", "me"), true);
  assert.equal(personMatch(["me"], "lena", "me"), false);
});

test("person counts count each person once per ticket, and tickets without anyone as none", () => {
  assert.deepEqual([...personCounts([["me"], ["me", "lena"], [], []])], [["me", 2], ["lena", 1], ["none", 2]]);
});

test("arrow keys move within a column and across to the nearest card", () => {
  const board = [["a", "b", "c"], [], ["d"], ["e", "f"]];
  assert.equal(nextCard(board, null, "ArrowDown"), "a");
  assert.equal(nextCard(board, "a", "ArrowDown"), "b");
  assert.equal(nextCard(board, "c", "ArrowDown"), "c");
  assert.equal(nextCard(board, "a", "ArrowUp"), "a");
  assert.equal(nextCard(board, "c", "ArrowRight"), "d");
  assert.equal(nextCard(board, "d", "ArrowLeft"), "a");
  assert.equal(nextCard(board, "d", "ArrowRight"), "e");
  assert.equal(nextCard(board, "f", "ArrowRight"), "f");
  assert.equal(nextCard(board, "f", "ArrowLeft"), "d");
  assert.equal(nextCard([[], []], "x", "ArrowDown"), null);
});

test("a child card moves right under its parent in the same column, and stays put when the parent is elsewhere", () => {
  const nested = nestCards([
    { id: "1", parent: null },
    { id: "2", parent: null },
    { id: "3", parent: "1" },
    { id: "4", parent: "3" },
    { id: "5", parent: "9" },
  ]);
  assert.deepEqual(nested, [
    { id: "1", depth: 0, children: 1, parentAway: false },
    { id: "3", depth: 1, children: 1, parentAway: false },
    { id: "4", depth: 2, children: 0, parentAway: false },
    { id: "2", depth: 0, children: 0, parentAway: false },
    { id: "5", depth: 0, children: 0, parentAway: true },
  ]);
  assert.deepEqual(hideCollapsed(nested, new Set()).map((card) => card.id), ["1", "2", "5"]);
  assert.deepEqual(hideCollapsed(nested, new Set(["1"])).map((card) => card.id), ["1", "3", "2", "5"]);
  assert.deepEqual(hideCollapsed(nested, new Set(["1", "3"])).map((card) => card.id), ["1", "3", "4", "2", "5"]);
  assert.deepEqual(nestCards([{ id: "a", parent: "b" }, { id: "b", parent: "a" }]).map((card) => card.id), ["a", "b"]);
});

test("a drop among the cards that show places the card in the whole column", () => {
  const column = ["a", "b", "c", "d"];
  assert.deepEqual(placeAmong(column, ["a", "c"], "d", 1), ["a", "d", "b", "c"]);
  assert.deepEqual(placeAmong(column, ["a", "c"], "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(placeAmong(column, ["a", "c"], "x", 2), ["a", "b", "c", "x", "d"]);
  assert.deepEqual(placeAmong(["a", "b"], [], "x", 0), ["a", "b", "x"]);
});
