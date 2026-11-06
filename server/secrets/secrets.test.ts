import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConnection } from "../board/sak/sakClient.ts";
import { readTrelloConnection, writeTrelloConnection } from "../board/trello/trello.ts";
import { createRemoteSettings } from "../remote/remoteTunnel.ts";
import { openSecret, sealFile, sealSecret, setSecretKey } from "./secrets.ts";

const newKey = () => randomBytes(32).toString("base64");
const folder = () => mkdtempSync(path.join(os.tmpdir(), "x-bench-secrets-"));

test("a sealed secret opens again under its key and under no other", () => {
  setSecretKey(newKey(), false);
  const sealed = sealSecret("trello-token");
  assert.match(sealed, /^sealed:v1:/);
  assert.doesNotMatch(sealed, /trello-token/);
  assert.notEqual(sealSecret("trello-token"), sealed);
  assert.equal(openSecret(sealed), "trello-token");
  setSecretKey(newKey(), false);
  assert.equal(openSecret(sealed), "");
  setSecretKey(null, true);
  assert.equal(openSecret(sealed), "");
});

test("without a key secrets are stored and read in plaintext", () => {
  setSecretKey(null, true);
  assert.equal(sealSecret("token"), "token");
  assert.equal(openSecret("token"), "token");
  assert.equal(openSecret(undefined), "");
  setSecretKey("too-short", true);
  assert.equal(sealSecret("token"), "token");
});

test("sealFile seals a plaintext file once and the store still reads it", () => {
  const file = path.join(folder(), "trello.json");
  writeFileSync(file, JSON.stringify({ apiKey: "key-1", token: "token-1", enabled: true }));
  setSecretKey(null, true);
  sealFile(file, ["apiKey", "token"]);
  assert.match(readFileSync(file, "utf8"), /token-1/);

  setSecretKey(newKey(), false);
  sealFile(file, ["apiKey", "token"]);
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /key-1|token-1/);
  assert.equal(JSON.parse(text).enabled, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readTrelloConnection(file), { apiKey: "key-1", token: "token-1", enabled: true });

  sealFile(file, ["apiKey", "token"]);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("stores write their secrets sealed", () => {
  const dir = folder();
  setSecretKey(newKey(), false);
  const trello = path.join(dir, "trello.json");
  writeTrelloConnection({ apiKey: "key-2", token: "token-2" }, trello);
  assert.doesNotMatch(readFileSync(trello, "utf8"), /key-2|token-2/);
  assert.equal(readTrelloConnection(trello).token, "token-2");

  const sak = path.join(dir, "sak.json");
  writeFileSync(sak, JSON.stringify({ baseUrl: "http://127.0.0.1:4345", token: "sak_1" }));
  sealFile(sak, ["token"]);
  assert.doesNotMatch(readFileSync(sak, "utf8"), /sak_1/);
  assert.equal(readConnection(sak).token, "sak_1");
});

test("the installed app without its key reads secrets as signed out and writes none", () => {
  const file = path.join(folder(), "trello.json");
  setSecretKey(newKey(), false);
  writeTrelloConnection({ apiKey: "key-3", token: "token-3" }, file);
  const sealed = readFileSync(file, "utf8");
  setSecretKey(null, false);
  assert.deepEqual(readTrelloConnection(file), { apiKey: "", token: "", enabled: false });
  assert.throws(() => writeTrelloConnection({ apiKey: "key-4", token: "token-4" }, file), /Keychain/);
  sealFile(file, ["apiKey", "token"]);
  assert.equal(readFileSync(file, "utf8"), sealed);
});

test("a host without the key keeps a sealed ngrok token when it saves other settings", () => {
  const settings = createRemoteSettings(path.join(folder(), "remote.json"));
  setSecretKey(newKey(), false);
  settings.save({ authtoken: "ngrok-1" });
  const key = newKey();
  setSecretKey(key, false);
  settings.save({ authtoken: "ngrok-2" });

  setSecretKey(null, false);
  assert.equal(settings.read().authtoken, "");
  settings.save({ enabledPorts: [8797] });

  setSecretKey(key, false);
  assert.deepEqual(settings.read(), { authtoken: "ngrok-2", domain: "", enabledPorts: [8797], localPorts: [] });
  settings.save({ authtoken: "" });
  assert.equal(settings.read().authtoken, "");
});
