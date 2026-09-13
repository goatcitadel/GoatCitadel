import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";

import { WORKER_MCP_PROTOCOL_VERSION } from "./worker-mcp-tool-protocol.js";
export { WORKER_MCP_PROTOCOL_VERSION } from "./worker-mcp-tool-protocol.js";
export const workerMcpRefused = () => new Error("The destination MCP connection or protocol evidence was refused.");

/** The registry supplies the entire endpoint; tools never choose URLs or headers. */
export function workerMcpEndpoint(value: string): URL {
  if (typeof value !== "string" || value.length > 2048) throw workerMcpRefused();
  const url = new URL(value);
  if (url.href !== value || url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))))
    throw workerMcpRefused();
  return url;
}

export interface WorkerMcpHttpResponse {
  readonly result?: Record<string, unknown>;
  readonly sessionId?: string;
}

/** One bounded POST, no redirects/proxies/retries or server-initiated tool/model calls.
 * HTTP bodies and SSE frames share one byte bound. Socket closure is joined before
 * return; a disconnected effect-bearing request is not treated as cancellation. */
export async function exchangeWorkerMcpHttp(input: {
  readonly endpoint: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly id?: number;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly beforeSend?: () => void;
  readonly closeSession?: boolean;
  readonly authorization?: string;
}): Promise<WorkerMcpHttpResponse> {
  const url = workerMcpEndpoint(input.endpoint);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(25_000)]);
  signal.throwIfAborted();
  const body = input.closeSession ? Buffer.alloc(0) : Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...(input.id === undefined ? {} : { id: input.id }),
    method: input.method, params: input.params }), "utf8");
  if (body.length > 256 * 1024 + 4096) throw workerMcpRefused();
  const session = input.sessionId;
  const authorization = input.authorization;
  if (authorization !== undefined && (authorization.length > 8199 ||
    !/^Bearer [A-Za-z0-9._~+/-]+={0,2}$/u.test(authorization))) throw workerMcpRefused();
  if (session !== undefined && !/^[\x21-\x7e]{1,256}$/u.test(session)) throw workerMcpRefused();
  await input.assertCurrent();
  signal.throwIfAborted();
  return new Promise<WorkerMcpHttpResponse>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let outcome: WorkerMcpHttpResponse | undefined;
    let stopped = false, failed = false;
    let sessionId: string | undefined;
    const stop = (value?: WorkerMcpHttpResponse) => {
      if (stopped) return;
      stopped = true;
      failed = value === undefined;
      outcome = value;
      response?.destroy();
      request.destroy();
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: input.closeSession ? "DELETE" : "POST", agent: false, signal, maxHeaderSize: 8192, rejectUnauthorized: true,
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json",
        "Content-Length": body.length, "MCP-Protocol-Version": WORKER_MCP_PROTOCOL_VERSION,
        ...(authorization ? { Authorization: authorization } : {}),
        ...(session ? { "Mcp-Session-Id": session } : {}) },
    }, (incoming) => {
      response = incoming;
      incoming.on("error", () => stop());
      try {
        const receivedSession = incoming.headers["mcp-session-id"];
        if (receivedSession !== undefined && (typeof receivedSession !== "string" ||
          !/^[\x21-\x7e]{1,256}$/u.test(receivedSession) ||
          (input.method !== "initialize" && receivedSession !== session))) throw workerMcpRefused();
        sessionId = receivedSession ?? session;
        if ((input.closeSession ? ![200, 202, 204, 405].includes(incoming.statusCode ?? 0)
          : incoming.statusCode !== (input.id === undefined ? 202 : 200)) ||
          (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity")) throw workerMcpRefused();
        const length = incoming.headers["content-length"];
        if (length !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > 512 * 1024)) throw workerMcpRefused();
        const type = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (input.id !== undefined && type !== "application/json" && type !== "text/event-stream") throw workerMcpRefused();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0, text = "", frames = 0, skipLf = false;
        const append = (value: string) => {
          if (!value) return;
          const normalized = skipLf && value.startsWith("\n") ? value.slice(1) : value;
          skipLf = normalized.endsWith("\r");
          text += type === "text/event-stream" ? normalized.replace(/\r\n|\r/gu, "\n") : value;
        };
        const envelope = (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw workerMcpRefused();
          const rpc = value as Record<string, unknown>;
          if (rpc.jsonrpc !== "2.0") throw workerMcpRefused();
          if (rpc.id === undefined && typeof rpc.method === "string" &&
            ["notifications/progress", "notifications/message"].includes(rpc.method)) return;
          if (rpc.id !== input.id || rpc.method !== undefined || rpc.error !== undefined || !rpc.result ||
            typeof rpc.result !== "object" || Array.isArray(rpc.result)) throw workerMcpRefused();
          stop({ result: rpc.result as Record<string, unknown>, ...(sessionId ? { sessionId } : {}) });
        };
        const sse = () => {
          for (;;) {
            const end = text.indexOf("\n\n");
            if (end < 0 || stopped) return;
            const frame = text.slice(0, end); text = text.slice(end + 2);
            if (++frames > 128) throw workerMcpRefused();
            const data: string[] = [];
            for (const line of frame.split("\n")) {
              if (!line || line.startsWith(":")) continue;
              const colon = line.indexOf(":");
              const key = colon < 0 ? line : line.slice(0, colon);
              const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
              if (key === "data") data.push(value);
              else if (key === "event" && value !== "message") throw workerMcpRefused();
              else if (!["id", "retry", "event"].includes(key)) throw workerMcpRefused();
            }
            if (data.length) envelope(JSON.parse(data.join("\n")));
          }
        };
        incoming.on("data", (chunk: Buffer) => {
          if (stopped) return;
          try {
            bytes += chunk.length;
            if (bytes > 512 * 1024 || (input.id === undefined && bytes)) throw workerMcpRefused();
            append(decoder.decode(chunk, { stream: true }));
            if (type === "text/event-stream") sse();
          } catch { stop(); }
        });
        incoming.once("end", () => {
          if (stopped) return;
          try {
            append(decoder.decode());
            if (input.id === undefined) stop({ ...(sessionId ? { sessionId } : {}) });
            else if (type === "application/json") { envelope(JSON.parse(text)); if (!stopped) stop(); }
            else { sse(); if (!stopped) stop(); }
          } catch { stop(); }
        });
      } catch { stop(); }
    });
    request.once("error", () => stop());
    request.once("close", () => {
      if (failed || !outcome || signal.aborted) reject(workerMcpRefused()); else resolve(outcome);
    });
    request.once("socket", (socket) => {
      const send = async () => {
        try {
          await input.assertCurrent();
          signal.throwIfAborted();
          if (stopped) return;
          input.beforeSend?.();
          request.end(body);
        } catch { stop(); }
      };
      if (socket instanceof TLSSocket) socket.once("secureConnect", () => { void send(); });
      else if (socket.connecting) socket.once("connect", () => { void send(); });
      else void send();
    });
  });
}
