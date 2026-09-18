import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { prepareStaticEnvironment, buildMcpHttpAuthHeaders } from "./mcp-transport-credentials.js";
import type { McpRuntimeTransportOptions, JsonRpcEnvelope } from "./mcp-runtime.js";
export const MCP_STREAMABLE_HTTP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_HTTP_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;
export const MCP_HTTP_RESPONSE_READ_TIMEOUT_MS = 25000;
export interface HttpMcpClient {
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcEnvelope>;
  notify(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}

export async function withHttpMcpClient<T>(
  server: McpServerRecord,
  timeoutMs: number,
  options: McpRuntimeTransportOptions,
  run: (client: HttpMcpClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  options = await prepareStaticEnvironment(server, options);
  const endpoint = server.url?.trim();
  if (!endpoint) {
    throw new Error(`MCP ${server.transport.toUpperCase()} URL is missing.`);
  }
  const allowlist = options.networkAllowlist ?? [];
  const authHeaders = await buildMcpHttpAuthHeaders(server, options);
  let nextId = 1;
  let sessionId: string | undefined;
  let protocolVersion = MCP_STREAMABLE_HTTP_PROTOCOL_VERSION;

  const postJsonRpc = async (
    envelope: JsonRpcEnvelope,
    requestSignal?: AbortSignal,
  ): Promise<{ envelope?: JsonRpcEnvelope; response: Response }> => {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...authHeaders,
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
      headers["MCP-Protocol-Version"] = protocolVersion;
    }
    const response = await fetchAllowlisted(endpoint, {
      allowlist,
      timeoutMs,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: requestSignal,
      },
    });
    const responseSessionId = response.headers.get("mcp-session-id")?.trim();
    if (responseSessionId) {
      sessionId = responseSessionId;
    }
    if (!response.ok) {
      throw new Error(`MCP ${server.transport.toUpperCase()} server ${server.label} returned HTTP ${response.status}.`);
    }
    if (response.status === 202) {
      return { response };
    }
    return {
      response,
      envelope: await readHttpJsonRpcEnvelope(response, envelope.id, timeoutMs),
    };
  };

  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<JsonRpcEnvelope> => {
    const id = nextId++;
    const envelope: JsonRpcEnvelope = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const result = await postJsonRpc(envelope, signal);
    if (!result.envelope) {
      throw new Error(`MCP ${method} request to ${server.label} returned no JSON-RPC response.`);
    }
    return result.envelope;
  };

  const notify = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<void> => {
    await postJsonRpc(
      {
        jsonrpc: "2.0",
        method,
        params,
      },
      signal,
    );
  };

  const close = async (signal?: AbortSignal): Promise<void> => {
    if (!sessionId) {
      return;
    }
    try {
      await fetchAllowlisted(endpoint, {
        allowlist,
        timeoutMs: Math.min(timeoutMs, 5000),
        init: {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Mcp-Session-Id": sessionId,
            "MCP-Protocol-Version": protocolVersion,
            ...authHeaders,
          },
          signal,
        },
      });
    } catch {
      // Best-effort session cleanup. Some MCP servers respond 405 or close
      // without delete support; the per-operation bridge can safely move on.
    }
  };

  const client: HttpMcpClient = { request, notify, close };
  try {
    const initialized = await client.request(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "goatcitadel-gateway",
          version: "1.0.0",
        },
      },
      signal,
    );
    const negotiated = readString(initialized.result?.protocolVersion);
    if (negotiated) {
      protocolVersion = negotiated;
    }
    await client.notify("notifications/initialized", {}, signal);
    return await run(client);
  } finally {
    await client.close(signal);
  }
}

export async function readHttpJsonRpcEnvelope(
  response: Response,
  expectedId?: number,
  timeoutMs = MCP_HTTP_RESPONSE_READ_TIMEOUT_MS,
): Promise<JsonRpcEnvelope> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseJsonRpcEnvelope(response, expectedId, timeoutMs);
  }
  const body = await readHttpResponseText(response, MCP_HTTP_RESPONSE_BODY_MAX_BYTES, timeoutMs);
  try {
    return JSON.parse(body) as JsonRpcEnvelope;
  } catch (error) {
    throw new Error(`MCP HTTP response was not valid JSON-RPC: ${(error as Error).message}`, { cause: error });
  }
}

async function readSseJsonRpcEnvelope(
  response: Response,
  expectedId: number | undefined,
  timeoutMs: number,
): Promise<JsonRpcEnvelope> {
  if (!response.body) {
    const body = await readHttpResponseText(response, MCP_HTTP_RESPONSE_BODY_MAX_BYTES, timeoutMs);
    const messages = parseSseJsonRpcMessages(body);
    const matched = messages.find((message) => expectedId === undefined || message.id === expectedId);
    if (!matched) {
      throw new Error("MCP HTTP event stream did not include the expected JSON-RPC response.");
    }
    return matched;
  }

  assertHttpResponseBodyWithinLimit(response, MCP_HTTP_RESPONSE_BODY_MAX_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadlineMs = Date.now() + timeoutMs;
  let receivedBytes = 0;
  let bufferedText = "";
  let dataLines: string[] = [];

  const flush = (): JsonRpcEnvelope | undefined => {
    if (dataLines.length === 0) {
      return undefined;
    }
    const raw = dataLines.join("\n").trim();
    dataLines = [];
    if (!raw) {
      return undefined;
    }
    try {
      const message = JSON.parse(raw) as JsonRpcEnvelope;
      return expectedId === undefined || message.id === expectedId ? message : undefined;
    } catch {
      return undefined;
    }
  };

  const consumeBufferedLines = (): JsonRpcEnvelope | undefined => {
    let newlineIndex = bufferedText.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const line = bufferedText.slice(0, newlineIndex);
      const newlineLength =
        bufferedText.charAt(newlineIndex) === "\r" && bufferedText.charAt(newlineIndex + 1) === "\n" ? 2 : 1;
      bufferedText = bufferedText.slice(newlineIndex + newlineLength);
      if (line.trim() === "") {
        const matched = flush();
        if (matched) {
          return matched;
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
      newlineIndex = bufferedText.search(/\r?\n/);
    }
    return undefined;
  };

  try {
    while (true) {
      const chunk = await readBodyChunkWithDeadline(reader, deadlineMs);
      if (chunk.done) {
        bufferedText += decoder.decode();
        const matchedFromRemainder = consumeBufferedLines() ?? flush();
        if (matchedFromRemainder) {
          return matchedFromRemainder;
        }
        throw new Error("MCP HTTP event stream did not include the expected JSON-RPC response.");
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MCP_HTTP_RESPONSE_BODY_MAX_BYTES) {
        await cancelBodyReader(reader);
        throw createMcpHttpBodyLimitError(MCP_HTTP_RESPONSE_BODY_MAX_BYTES);
      }
      bufferedText += decoder.decode(chunk.value, { stream: true });
      const matched = consumeBufferedLines();
      if (matched) {
        await cancelBodyReader(reader);
        return matched;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseJsonRpcMessages(body: string): JsonRpcEnvelope[] {
  const messages: JsonRpcEnvelope[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const raw = dataLines.join("\n").trim();
    dataLines = [];
    if (!raw) {
      return;
    }
    try {
      messages.push(JSON.parse(raw) as JsonRpcEnvelope);
    } catch {
      // Ignore non-JSON events; MCP servers may stream notifications that
      // GoatCitadel does not consume in the single-request bridge.
    }
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  flush();
  return messages;
}

async function readHttpResponseText(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  return readBoundedResponseText(response, {
    maxBytes,
    timeoutMs,
    label: "MCP HTTP",
  });
}

function assertHttpResponseBodyWithinLimit(response: Response, maxBytes: number): void {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) {
    return;
  }
  const parsed = Number(contentLength);
  if (Number.isFinite(parsed) && parsed > maxBytes) {
    throw createMcpHttpBodyLimitError(maxBytes);
  }
}

async function readBodyChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    await cancelBodyReader(reader);
    throw createMcpHttpBodyTimeoutError();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(() => {
          // Reject before cancelling: reader.cancel() synchronously resolves the
          // in-flight read() with { done: true }, which would otherwise win the
          // race and surface a misleading missing-response error.
          reject(createMcpHttpBodyTimeoutError());
          void cancelBodyReader(reader).catch(() => undefined);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort body cleanup only.
  }
}

function createMcpHttpBodyLimitError(maxBytes: number): Error {
  return new Error(`MCP HTTP response body exceeded ${maxBytes} bytes.`);
}

function createMcpHttpBodyTimeoutError(): Error {
  return new Error("Timed out reading MCP HTTP response body.");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
