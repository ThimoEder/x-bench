// Test helpers for the browser pane. The host drives the pane through the Electron app over a WebSocket
// link (server/browser/browser.ts); these stand in for the app's end, so the host's browser code runs in tests
// without Electron. Only tests import this file.

import { PROMPT_OPTIONS, type Browser } from "../browser/browser.ts";
import type { MessageListener, WebSocketConnection } from "../websocket.ts";

// The Electron app's end of the link. Each call the host sends is answered with answer(op, args), or with its
// error when it throws. sent lists the calls, and push sends a message as the app would, such as its tabs.
export function fakeLink(answer: (op: string, args: Record<string, unknown>) => unknown = () => ({})) {
  const listeners: MessageListener[] = [];
  const closers: (() => void)[] = [];
  const sent: { op: string; args: Record<string, unknown> }[] = [];
  let open = true;
  const push = (message: unknown) => {
    for (const listener of listeners) listener(Buffer.from(JSON.stringify(message)), true);
  };
  const link: WebSocketConnection = {
    send: () => open,
    sendText(text) {
      if (!open) return false;
      const call = JSON.parse(String(text)) as { id: number; op: string; args: Record<string, unknown> };
      sent.push({ op: call.op, args: call.args });
      queueMicrotask(() => {
        try {
          push({ type: "reply", id: call.id, result: answer(call.op, call.args) });
        } catch (error) {
          push({ type: "reply", id: call.id, error: error instanceof Error ? error.message : String(error) });
        }
      });
      return true;
    },
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener),
    close() {
      if (!open) return;
      open = false;
      for (const closer of closers) closer();
    },
    buffered: () => 0,
  };
  return { link, sent, push };
}

// Answers the session's waiting prompt the way its card's button would.
export function choose(browser: Browser, kind: keyof typeof PROMPT_OPTIONS, sessionId = "s1"): boolean {
  const option = browser.prompt(sessionId)?.options.find((item) => item.optionId.startsWith(`${PROMPT_OPTIONS[kind]}:`));
  return option ? browser.answer(sessionId, option.optionId) : false;
}
