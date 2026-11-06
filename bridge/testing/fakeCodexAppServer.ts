import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [file = "", used = "42"] = process.argv.slice(2);
if (file) appendFileSync(file, "start\n");

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: number; method?: string };
  if (message.method === "initialize") {
    // Codex sends notifications of its own before it answers anything else.
    send({ method: "account/updated", params: { authMode: "chatgpt" } });
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "account/rateLimits/read") {
    if (used === "error") {
      send({ id: message.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } });
      return;
    }
    if (used === "offline") {
      send({ id: message.id, error: { code: -32603, message: "failed to fetch codex rate limits: error sending request" } });
      return;
    }
    if (used === "none") {
      send({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null, planType: "plus" } } });
      return;
    }
    send({
      id: message.id,
      result: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: Number(used), windowDurationMins: 300, resetsAt: 1790820111 },
          secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1791234524 },
          planType: "plus",
        },
      },
    });
  }
});
