import assert from "node:assert/strict";
import test from "node:test";
import { boardHref, boardSearch, boardTarget, chatBoardHref, localBoardTarget } from "./boardLink.ts";

test("a board link names the folder and the selected ticket", () => {
  const search = boardSearch({ cwd: "/Users/me/x_bench", taskId: 36 });
  assert.equal(search, "?cwd=%2FUsers%2Fme%2Fx_bench&task=36");
  assert.deepEqual(boardTarget(search), { cwd: "/Users/me/x_bench", taskId: 36 });
  assert.equal(boardHref("http://127.0.0.1:8787/", "/Users/me/x_bench", 36), `http://127.0.0.1:8787/${search}`);
});

test("a board link without a ticket opens the overview", () => {
  assert.equal(boardSearch({ cwd: "/work/app" }), "?cwd=%2Fwork%2Fapp");
  assert.deepEqual(boardTarget("?cwd=%2Fwork%2Fapp"), { cwd: "/work/app", taskId: null });
  assert.deepEqual(boardTarget("?cwd=%2Fwork%2Fapp&task=0"), { cwd: "/work/app", taskId: null });
});

test("a Trello card id survives the board link and a malformed id does not", () => {
  const id = "f".repeat(24);
  const search = boardSearch({ cwd: "/work/app", taskId: id.toUpperCase() });
  assert.equal(search, `?cwd=%2Fwork%2Fapp&task=${id}`);
  assert.equal(boardTarget(search).taskId, id);
  assert.equal(boardTarget("?cwd=%2Fwork%2Fapp&task=xyz").taskId, null);
  assert.equal(boardTarget("?cwd=%2Fwork%2Fapp&task=123").taskId, 123);
});

test("a ticket without a folder does not open a board", () => {
  assert.equal(boardSearch({ taskId: 36 }), "");
  assert.deepEqual(boardTarget("?task=36"), { cwd: null, taskId: null });
  assert.equal(boardHref("", "", 36), "/");
});

test("a chat link to a local board opens that board, and other links do not", () => {
  const here = "http://127.0.0.1:8798";
  assert.deepEqual(localBoardTarget("http://127.0.0.1:8797/?cwd=/Users/me/x_bench&task=120", here), { cwd: "/Users/me/x_bench", taskId: 120 });
  assert.deepEqual(localBoardTarget("http://localhost:8798/?cwd=%2Fwork%2Fapp", here), { cwd: "/work/app", taskId: null });
  assert.deepEqual(localBoardTarget("https://example.com/?cwd=/work/app&task=1", here), { cwd: null, taskId: null });
  assert.deepEqual(localBoardTarget("http://127.0.0.1:3000/docs?cwd=/work/app", here), { cwd: null, taskId: null });
  assert.deepEqual(localBoardTarget("http://127.0.0.1:8797/", here), { cwd: null, taskId: null });
  assert.deepEqual(localBoardTarget("not a url", here), { cwd: null, taskId: null });
  assert.deepEqual(localBoardTarget("http://localhost:3000/?cwd=/repo", here), { cwd: null, taskId: null });
});

test("a short ticket link opens the ticket on the board of the chat's folder", () => {
  const here = "http://127.0.0.1:8798";
  assert.equal(chatBoardHref("?task=91", here, "/work/app"), `${here}/?cwd=%2Fwork%2Fapp&task=91`);
  assert.equal(chatBoardHref("?task=PROJ-7", here, "/work/app"), `${here}/?cwd=%2Fwork%2Fapp&task=PROJ-7`);
  assert.equal(chatBoardHref("?task=91", here, undefined), "?task=91");
  assert.equal(chatBoardHref("?task=91&cwd=/etc", here, "/work/app"), "?task=91&cwd=/etc");
  assert.equal(chatBoardHref("https://example.com/?task=91", here, "/work/app"), "https://example.com/?task=91");
});

test("a board link on a remote window's own origin opens that board", () => {
  const here = "https://desk.example.com";
  assert.deepEqual(localBoardTarget(`${here}/?cwd=%2Fwork%2Fapp&task=91`, here), { cwd: "/work/app", taskId: 91 });
  assert.deepEqual(localBoardTarget(chatBoardHref("?task=91", here, "/work/app"), here), { cwd: "/work/app", taskId: 91 });
  assert.deepEqual(localBoardTarget("https://other.example.com/?cwd=%2Fwork%2Fapp&task=91", here), { cwd: null, taskId: null });
  assert.deepEqual(localBoardTarget(`${here}/docs?cwd=%2Fwork%2Fapp&task=91`, here), { cwd: null, taskId: null });
});
