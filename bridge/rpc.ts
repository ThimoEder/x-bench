// JSON-RPC peer for one ACP connection. Frames are one JSON object, or NDJSON.

export type RpcId = string | number | null;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcHandlers {
  onMessage: (raw: unknown) => void;
  onClose: () => void;
}

export interface RpcTransport {
  send(value: unknown): void;
  setHandlers(handlers: RpcHandlers): void;
}

// A connection to one agent: a WebSocket to Grok, or stdio to an adapter process.
// closed settles once, when the connection closes.
export interface Transport extends RpcTransport {
  close(): void;
  closed: Promise<void>;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RpcClient {
  nextId: number;
  pending: Map<number, Pending>;
  transport: RpcTransport | null;
  onRequest: (message: RpcRequest) => unknown;
  onNotification: (message: RpcNotification) => void;

  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.transport = null;
    this.onRequest = () => {};
    this.onNotification = () => {};
  }

  attach(transport: RpcTransport) {
    this.detach();
    this.transport = transport;
    transport.setHandlers({
      onMessage: (raw) => this.#onRaw(raw),
      onClose: () => {
        if (this.transport !== transport) return;
        this.transport = null;
        this.#failAll(new Error("connection closed"));
      },
    });
  }

  detach() {
    this.transport = null;
    this.#failAll(new Error("connection closed"));
  }

  request(method: string, params: unknown, timeoutMs = 60000): Promise<unknown> {
    if (!this.transport) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    const transport = this.transport;
    return new Promise((resolve, reject) => {
      // A non-positive timeout waits until the agent responds or the socket closes.
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`timeout waiting for ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown) {
    this.transport?.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: RpcId, result: unknown) {
    this.transport?.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: RpcId, code: number, message: string) {
    this.transport?.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #onRaw(raw: unknown) {
    const text = toText(raw).trim();
    if (!text) return;
    // Parse the frame before dispatch. A listener throw is not a bad frame:
    // parsing the same text again would apply the message twice.
    for (const message of parseMessages(text)) {
      try {
        this.#dispatch(message);
      } catch (error) {
        logListener(methodOf(message), error);
      }
    }
  }

  #dispatch(message: unknown) {
    if (!isObject(message)) return;
    const { id, method } = message;
    if (typeof method === "string" && id !== undefined && !isRpcId(id)) {
      // JSON-RPC ids are strings, numbers or null. Answer anything else so the agent does not wait.
      this.transport?.send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request id" } });
      return;
    }
    if (typeof method === "string" && isRpcId(id)) {
      const request: RpcRequest = { ...message, id, method };
      let outcome: unknown;
      try {
        outcome = this.onRequest(request);
      } catch (error) {
        this.respondError(id, -32603, error instanceof Error ? error.message : String(error));
        throw error;
      }
      Promise.resolve(outcome).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        logListener(method, error);
        this.respondError(id, -32603, detail);
      });
      return;
    }
    if (typeof method === "string") {
      this.onNotification({ ...message, method });
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      const error = isObject(message.error) ? message.error : {};
      const data = error.data;
      // The Claude adapter puts the reason in data.details.
      const detail = typeof data === "string" ? data : isObject(data) ? (data.message ?? data.details) : undefined;
      const text = detail ? `${error.message}: ${detail}` : String(error.message || "rpc error");
      pending.reject(Object.assign(new Error(text), { rpc: message.error }));
    }
    else pending.resolve(message.result ?? {});
  }

  #failAll(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

function toText(raw: unknown) {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return String(raw ?? "");
}

// One JSON object, or several newline-delimited objects. A line that is not JSON is a banner.
function parseMessages(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    const messages: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // Ignore non-JSON banners.
      }
    }
    return messages;
  }
}

function methodOf(message: unknown) {
  return isObject(message) && typeof message.method === "string" ? message.method : "";
}

function logListener(method: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(method ? `rpc listener failed (${method}): ${detail}` : `rpc listener failed: ${detail}`);
}
