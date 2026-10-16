import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import {
  MCP_HTTP_RESPONSE_BODY_MAX_BYTES,
  MCP_HTTP_RESPONSE_READ_TIMEOUT_MS,
  cancelBodyReader,
  createMcpHttpBodyLimitError,
  createMcpHttpBodyTimeoutError,
  type HttpMcpClient,
} from "./mcp-http-transport.js";
import { prepareStaticEnvironment, buildMcpHttpAuthHeaders } from "./mcp-transport-credentials.js";
import type { McpRuntimeTransportOptions, JsonRpcEnvelope } from "./mcp-runtime.js";

// Legacy MCP HTTP+SSE transport (protocol revision 2024-11-05): the client holds
// a GET event stream open, the server announces a message endpoint through an
// `endpoint` event, JSON-RPC messages are POSTed to that endpoint, and replies
// arrive as `message` events on the stream. The announced endpoint must share
// the stream URL's origin, and every request still goes through the
// allowlisted network guard.
export const MCP_LEGACY_SSE_PROTOCOL_VERSION = "2024-11-05";
const MCP_LEGACY_SSE_EXPIRED_SESSION_CODE = -32001;

interface SseEvent {
  event: string;
  data: string;
}

interface PendingResponse {
  resolve(envelope: JsonRpcEnvelope): void;
  reject(error: Error): void;
  dispose(): void;
}

export async function withLegacySseMcpClient<T>(
  server: McpServerRecord,
  timeoutMs: number,
  options: McpRuntimeTransportOptions,
  run: (client: HttpMcpClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  options = await prepareStaticEnvironment(server, options);
  const streamUrl = server.url?.trim();
  if (!streamUrl) {
    throw new Error("MCP SSE URL is missing.");
  }
  const session = new LegacySseSession({
    server,
    streamUrl,
    timeoutMs,
    readTimeoutMs: Math.min(MCP_HTTP_RESPONSE_READ_TIMEOUT_MS, timeoutMs),
    allowlist: options.networkAllowlist ?? [],
    authHeaders: await buildMcpHttpAuthHeaders(server, options),
  });
  try {
    await session.open(signal);
    const client = session.client();
    const initialized = await client.request(
      "initialize",
      {
        protocolVersion: MCP_LEGACY_SSE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "goatcitadel-gateway", version: "1.0.0" },
      },
      signal,
    );
    if (initialized.error) {
      throw new Error(`MCP SSE initialize failed for ${server.label}: ${initialized.error.message ?? "unknown error"}`);
    }
    await client.notify("notifications/initialized", {}, signal);
    return await run(client);
  } finally {
    session.close();
  }
}

class LegacySseSession {
  private readonly streamAbort = new AbortController();
  private readonly pending = new Map<number, PendingResponse>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private messageEndpoint: string | undefined;
  private endpointWaiter: PendingResponse | undefined;
  private failure: Error | undefined;
  private closed = false;
  private nextId = 1;
  private detachCallerSignal: (() => void) | undefined;

  public constructor(
    private readonly input: {
      server: McpServerRecord;
      streamUrl: string;
      timeoutMs: number;
      readTimeoutMs: number;
      allowlist: string[];
      authHeaders: Record<string, string>;
    },
  ) {}

  public async open(signal?: AbortSignal): Promise<void> {
    this.linkCallerSignal(signal);
    const { server, streamUrl } = this.input;
    const response = await fetchAllowlisted(streamUrl, {
      allowlist: this.input.allowlist,
      timeoutMs: this.input.timeoutMs,
      init: {
        method: "GET",
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", ...this.input.authHeaders },
        signal: this.streamAbort.signal,
      },
    });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`MCP SSE server ${server.label} returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      await discardResponseBody(response);
      throw new Error(`MCP SSE server ${server.label} did not open an event stream.`);
    }
    this.reader = response.body.getReader();
    const endpointAnnounced = new Promise<JsonRpcEnvelope>((resolve, reject) => {
      this.endpointWaiter = this.createWaiter(resolve, reject, () => {
        this.endpointWaiter = undefined;
      });
    });
    void this.pump(this.reader);
    await endpointAnnounced;
  }

  public client(): HttpMcpClient {
    return {
      request: (method, params = {}, signal) => this.request(method, params, signal),
      notify: (method, params = {}, signal) => this.notify(method, params, signal),
      close: async () => this.close(),
    };
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachCallerSignal?.();
    this.fail(new Error(`MCP SSE session for ${this.input.server.label} was closed.`));
    this.streamAbort.abort();
    if (this.reader) {
      void cancelBodyReader(this.reader);
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonRpcEnvelope> {
    const id = this.nextId++;
    const response = this.awaitResponse(id, signal);
    // The reply may arrive on the stream before the POST resolves; keep the
    // rejection observed until the caller awaits it.
    response.catch(() => undefined);
    let status: number;
    try {
      status = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    } catch (error) {
      this.pending.get(id)?.dispose();
      throw error;
    }
    if (status === 404) {
      this.pending.get(id)?.dispose();
      return buildExpiredSessionEnvelope(id, this.input.server.label);
    }
    return response;
  }

  private async notify(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const status = await this.post({ jsonrpc: "2.0", method, params }, signal);
    if (status === 404) {
      throw new Error(buildExpiredSessionMessage(this.input.server.label));
    }
  }

  private async post(envelope: JsonRpcEnvelope, signal?: AbortSignal): Promise<number> {
    if (this.failure) {
      throw this.failure;
    }
    const endpoint = this.messageEndpoint;
    if (!endpoint) {
      throw new Error(`MCP SSE server ${this.input.server.label} has not announced a message endpoint.`);
    }
    const response = await fetchAllowlisted(endpoint, {
      allowlist: this.input.allowlist,
      timeoutMs: this.input.timeoutMs,
      // The endpoint was origin-checked when announced; refusing redirects keeps
      // every POST on that same-origin, allowlisted URL.
      maxRedirects: 0,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.input.authHeaders },
        body: JSON.stringify(envelope),
        signal,
      },
    });
    await discardResponseBody(response);
    if (response.status === 404) {
      return 404;
    }
    if (!response.ok) {
      throw new Error(`MCP SSE server ${this.input.server.label} returned HTTP ${response.status}.`);
    }
    return response.status;
  }

  private awaitResponse(id: number, signal?: AbortSignal): Promise<JsonRpcEnvelope> {
    return new Promise<JsonRpcEnvelope>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const onAbort = () => waiter.reject(new Error(`MCP SSE request to ${this.input.server.label} was aborted.`));
      const waiter = this.createWaiter(resolve, reject, () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      });
      this.pending.set(id, waiter);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private createWaiter(
    resolve: (envelope: JsonRpcEnvelope) => void,
    reject: (error: Error) => void,
    cleanup: () => void,
  ): PendingResponse {
    const timer = setTimeout(() => waiter.reject(createMcpHttpBodyTimeoutError()), this.input.readTimeoutMs);
    const dispose = () => {
      clearTimeout(timer);
      cleanup();
    };
    const waiter: PendingResponse = {
      resolve: (envelope) => {
        dispose();
        resolve(envelope);
      },
      reject: (error) => {
        dispose();
        reject(error);
      },
      dispose,
    };
    return waiter;
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const parser = new SseEventParser(MCP_HTTP_RESPONSE_BODY_MAX_BYTES);
    try {
      while (!this.closed) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`MCP SSE server ${this.input.server.label} closed the event stream.`);
        }
        for (const event of parser.push(chunk.value)) {
          this.handleEvent(event);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.streamAbort.abort();
      await cancelBodyReader(reader);
    }
  }

  private handleEvent(event: SseEvent): void {
    if (event.event === "endpoint") {
      this.acceptEndpoint(event.data);
      return;
    }
    if (event.event !== "message") {
      return;
    }
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(event.data) as JsonRpcEnvelope;
    } catch {
      // Non-JSON stream events are not replies to a pending request.
      return;
    }
    if (typeof envelope.id === "number") {
      this.pending.get(envelope.id)?.resolve(envelope);
    }
  }

  private acceptEndpoint(data: string): void {
    const waiter = this.endpointWaiter;
    if (!waiter || this.messageEndpoint) {
      return;
    }
    const { server, streamUrl } = this.input;
    let endpoint: URL;
    try {
      endpoint = new URL(data.trim(), streamUrl);
    } catch {
      this.fail(new Error(`MCP SSE server ${server.label} announced an invalid message endpoint.`));
      return;
    }
    if (endpoint.origin !== new URL(streamUrl).origin) {
      this.fail(new Error(`MCP SSE server ${server.label} announced a cross-origin message endpoint.`));
      return;
    }
    this.messageEndpoint = endpoint.toString();
    waiter.resolve({ jsonrpc: "2.0" });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.endpointWaiter?.reject(this.failure);
    for (const waiter of [...this.pending.values()]) {
      waiter.reject(this.failure);
    }
  }

  private linkCallerSignal(signal?: AbortSignal): void {
    if (!signal) {
      return;
    }
    const onAbort = () => {
      this.fail(new Error(`MCP SSE session for ${this.input.server.label} was aborted.`));
      this.streamAbort.abort(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    this.detachCallerSignal = () => signal.removeEventListener("abort", onAbort);
  }
}

// Incremental text/event-stream parser. Each event (its buffered lines plus any
// unterminated tail) is capped at `maxEventBytes`.
class SseEventParser {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  private eventName = "";
  private dataLines: string[] = [];
  private eventBytes = 0;

  public constructor(private readonly maxEventBytes: number) {}

  public push(chunk: Uint8Array): SseEvent[] {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    let newlineIndex = this.buffered.search(/\r?\n|\r/);
    while (newlineIndex >= 0) {
      const line = this.buffered.slice(0, newlineIndex);
      const newlineLength = this.buffered.startsWith("\r\n", newlineIndex) ? 2 : 1;
      this.buffered = this.buffered.slice(newlineIndex + newlineLength);
      const event = this.consumeLine(line);
      if (event) {
        events.push(event);
      }
      newlineIndex = this.buffered.search(/\r?\n|\r/);
    }
    if (this.eventBytes + Buffer.byteLength(this.buffered) > this.maxEventBytes) {
      throw createMcpHttpBodyLimitError(this.maxEventBytes);
    }
    return events;
  }

  private consumeLine(line: string): SseEvent | undefined {
    if (line === "") {
      const event =
        this.dataLines.length > 0 ? { event: this.eventName || "message", data: this.dataLines.join("\n") } : undefined;
      this.eventName = "";
      this.dataLines = [];
      this.eventBytes = 0;
      return event;
    }
    this.eventBytes += Buffer.byteLength(line) + 1;
    if (this.eventBytes > this.maxEventBytes) {
      throw createMcpHttpBodyLimitError(this.maxEventBytes);
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex);
    const value = colonIndex < 0 ? "" : line.slice(colonIndex + 1).replace(/^ /, "");
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    }
    return undefined;
  }
}

// A legacy SSE server answers 404 when it no longer knows the session encoded
// in the message endpoint; the message was refused before dispatch, so it is
// surfaced as an explicitly retry-safe expired session.
function buildExpiredSessionEnvelope(id: number, label: string): JsonRpcEnvelope {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: MCP_LEGACY_SSE_EXPIRED_SESSION_CODE,
      message: buildExpiredSessionMessage(label),
      data: { phase: "pre_dispatch", retrySafe: true },
    },
  };
}

function buildExpiredSessionMessage(label: string): string {
  return `MCP SSE server ${label} reported an expired session (HTTP 404) before dispatch.`;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup of a status-only response body.
  }
}
