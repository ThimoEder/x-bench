import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { caFile, ensureCa, lanAddress, localForward } from "./localTunnel.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test("the local tunnel serves the remote listener over TLS that the CA vouches for", { skip: !fs.existsSync("/usr/bin/openssl") }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ca-"));
  const [first, second] = await Promise.all([ensureCa(dir), ensureCa(dir)]);
  assert.equal(first, caFile(dir));
  assert.equal(second, first);
  assert.equal(fs.statSync(path.join(dir, "ca.key")).mode & 0o777, 0o600);

  const plain = http.createServer((req, res) => res.end(`host ${req.headers.host}`));
  await new Promise<void>((resolve) => {
    plain.listen(0, "127.0.0.1", resolve);
  });
  const port = await freePort();
  const listener = await localForward(port, { dir, host: async () => "test-mac.local", address: () => "127.0.0.1" })({
    addr: `127.0.0.1:${(plain.address() as AddressInfo).port}`,
    authtoken: "",
  });
  assert.equal(listener.url(), `https://127.0.0.1:${port}`);

  const body = await new Promise<string>((resolve, reject) => {
    https
      .get({ host: "127.0.0.1", port, servername: "test-mac.local", headers: { host: `test-mac.local:${port}` }, ca: fs.readFileSync(caFile(dir)) }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
  assert.equal(body, `host test-mac.local:${port}`);

  // The certificate also names the IP address, so a request to it passes without a servername.
  const byAddress = await new Promise<number>((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, ca: fs.readFileSync(caFile(dir)) }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject);
  });
  assert.equal(byAddress, 200);

  await listener.close();
  plain.close();
});

test("the LAN address is the first IPv4 address on a Wi-Fi or Ethernet interface", () => {
  const item = (address: string, family: "IPv4" | "IPv6", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null });
  assert.equal(
    lanAddress({ lo0: [item("127.0.0.1", "IPv4", true)], utun3: [item("10.0.0.2", "IPv4")], en0: [item("fe80::1", "IPv6"), item("192.168.178.56", "IPv4")] } as never),
    "192.168.178.56",
  );
  assert.equal(lanAddress({ lo0: [item("127.0.0.1", "IPv4", true)] } as never), "");
});
