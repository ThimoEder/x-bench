// Remote access on the local network: a TLS listener on every interface at a fixed port that hands each
// connection to the remote listener, at the Mac's Wi-Fi address. Its certificate names that address and the Mac's
// Bonjour name (name.local) and is signed by a CA that X Bench makes once in ~/.x-bench/remote-ca. A phone trusts
// it once that CA is installed there.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import type { Forward } from "./remoteTunnel.ts";

const run = promisify(execFile);
// The system's LibreSSL, whatever PATH the app started with.
const OPENSSL = "/usr/bin/openssl";
// iOS refuses server certificates valid for more than 825 days.
const SERVER_DAYS = "800";

// The file to install on the phone.
export function caFile(dir: string): string {
  return path.join(dir, "X Bench CA.pem");
}

const making = new Map<string, Promise<string>>();

// Makes the CA once. Concurrent calls share one run, so the key and the certificate always belong together.
export function ensureCa(dir: string): Promise<string> {
  const cert = caFile(dir);
  const key = path.join(dir, "ca.key");
  if (fs.existsSync(cert) && fs.existsSync(key)) return Promise.resolve(cert);
  let pending = making.get(dir);
  if (!pending) {
    pending = (async () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await run(OPENSSL, ["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", key]);
      fs.chmodSync(key, 0o600);
      await run(OPENSSL, [
        "req", "-x509", "-new", "-key", key, "-sha256", "-days", "3650",
        "-subj", `/CN=X Bench CA (${os.hostname()})`,
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-out", cert,
      ]);
      return cert;
    })().finally(() => making.delete(dir));
    making.set(dir, pending);
  }
  return pending;
}

// A fresh certificate on every start, so a renamed Mac or an old certificate never needs a check.
export async function serverCert(dir: string, host: string, address: string, name: string): Promise<{ key: Buffer; cert: Buffer }> {
  const ca = await ensureCa(dir);
  const base = path.join(dir, name);
  await run(OPENSSL, ["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", `${base}.key`]);
  fs.chmodSync(`${base}.key`, 0o600);
  await run(OPENSSL, ["req", "-new", "-key", `${base}.key`, "-subj", `/CN=${host}`, "-out", `${base}.csr`]);
  fs.writeFileSync(`${base}.ext`, `subjectAltName=DNS:${host}${address ? `,IP:${address}` : ""}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n`);
  await run(OPENSSL, [
    "x509", "-req", "-in", `${base}.csr`, "-CA", ca, "-CAkey", path.join(dir, "ca.key"),
    "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-days", SERVER_DAYS, "-sha256",
    "-extfile", `${base}.ext`, "-out", `${base}.pem`,
  ]);
  return { key: fs.readFileSync(`${base}.key`), cert: fs.readFileSync(`${base}.pem`) };
}

// The name the phone finds the Mac by on the network, for example my-mac.local.
export async function bonjourName(): Promise<string> {
  try {
    const { stdout } = await run("/usr/sbin/scutil", ["--get", "LocalHostName"]);
    if (stdout.trim()) return `${stdout.trim()}.local`.toLowerCase();
  } catch {
    // Not a Mac, or no Bonjour name set.
  }
  return `${os.hostname().replace(/\.local$/i, "")}.local`.toLowerCase();
}

// The Mac's IPv4 address on Wi-Fi or Ethernet. Phones reach it more reliably than the Bonjour name, which they may
// try over IPv6 only.
export function lanAddress(interfaces = os.networkInterfaces()): string {
  for (const [name, list] of Object.entries(interfaces)) {
    const v4 = name.startsWith("en") ? list?.find((item) => item.family === "IPv4" && !item.internal) : undefined;
    if (v4) return v4.address;
  }
  return "";
}

export function localForward(port: number, { dir, host = bonjourName, address = lanAddress }: { dir: string; host?: () => Promise<string>; address?: () => string }): Forward {
  return async ({ addr }) => {
    const name = await host();
    // shortcut: the address is read at start, so a new one from DHCP needs remote access turned off and on again.
    const ip = address();
    const { key, cert } = await serverCert(dir, name, ip, `server-${port}`);
    const target = Number(addr.split(":").pop());
    const sockets = new Set<net.Socket>();
    const server = tls.createServer({ key, cert }, (socket) => {
      const upstream = connect(target, "127.0.0.1");
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => {});
      upstream.on("error", () => {});
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    server.on("connection", (socket: net.Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // IPv4 only: on some networks replies to a phone's link-local IPv6 connection never arrive, and a refused
      // IPv6 connection makes the phone fall back to IPv4 at once.
      server.listen(port, "0.0.0.0", () => resolve());
    });
    return {
      url: () => `https://${ip || name}:${port}`,
      close() {
        for (const socket of sockets) socket.destroy();
        return new Promise((resolve) => {
          server.close(() => resolve());
        });
      },
    };
  };
}
