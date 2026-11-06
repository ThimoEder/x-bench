// The host bundle's options, shared by desktop/bundle-host.js and the Open Source Licenses list.
import type { BuildOptions } from "esbuild";

export const hostBundle = {
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // sherpa-onnx-node, node-pty and @ngrok/ngrok load native code, so they stay in
  // node_modules (unpacked from the asar archive). Vite is only imported
  // without X_BENCH_UI=dist, which the packaged app never does.
  external: ["sherpa-onnx-node", "node-pty", "@ngrok/ngrok", "vite", "@vitejs/plugin-react"],
} satisfies BuildOptions;
