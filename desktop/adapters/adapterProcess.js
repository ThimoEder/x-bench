// A utilityProcess has no stdin, so the main process sends it as { stdin } messages, null for its end.
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const stdin = new PassThrough();
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
process.parentPort.on("message", ({ data }) => {
  if (typeof data?.stdin === "string") stdin.write(data.stdin);
  else if (data?.stdin === null) {
    stdin.end();
    // A utilityProcess does not exit when its event loop empties, as a node adapter does at the end of its stdin.
    setTimeout(() => process.exit(0), 2000);
  }
});
const entry = process.argv.at(-1);
await import(pathToFileURL(entry).href);
