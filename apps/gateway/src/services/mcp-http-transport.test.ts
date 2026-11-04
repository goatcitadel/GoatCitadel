import { describe, expect, it } from "vitest";
import { isReplyFor, readHttpJsonRpcEnvelope } from "./mcp-http-transport.js";

describe("isReplyFor", () => {
  it("accepts a reply with the expected id", () => {
    expect(isReplyFor({ jsonrpc: "2.0", id: 3, result: {} }, 3)).toBe(true);
  });
  it("rejects a server-initiated request that reuses the id", () => {
    expect(isReplyFor({ jsonrpc: "2.0", id: 3, method: "ping" }, 3)).toBe(false);
  });
  it("rejects a different id and accepts anything when no id is expected", () => {
    expect(isReplyFor({ jsonrpc: "2.0", id: 4, result: {} }, 3)).toBe(false);
    expect(isReplyFor({ jsonrpc: "2.0", method: "notifications/x" }, undefined)).toBe(true);
  });
});

describe("readHttpJsonRpcEnvelope response correlation", () => {
  it.each([
    { name: "another request's result", body: { jsonrpc: "2.0", id: 4, result: {} } },
    { name: "a notification", body: { jsonrpc: "2.0", method: "notifications/tools/list_changed" } },
    { name: "an uncorrelated result", body: { jsonrpc: "2.0", result: {} } },
    { name: "a server request reusing our id", body: { jsonrpc: "2.0", id: 3, method: "ping" } },
    { name: "a string id", body: { jsonrpc: "2.0", id: "3", result: {} } },
    { name: "null", body: null },
    { name: "a primitive", body: 3 },
    { name: "a batch", body: [{ jsonrpc: "2.0", id: 3, result: {} }] },
  ])("rejects $name for a JSON request", async ({ body }) => {
    await expect(readHttpJsonRpcEnvelope(Response.json(body), 3)).rejects.toThrow(
      "expected JSON-RPC response",
    );
  });

  it.each([
    { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "matched" }] } },
    { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Unknown method" } },
  ])("preserves the matched result or error: %j", async (body) => {
    await expect(readHttpJsonRpcEnvelope(Response.json(body), 3)).resolves.toEqual(body);
  });

  it("keeps the notification response compatibility path when no id is expected", async () => {
    const body = { jsonrpc: "2.0", method: "notifications/x" };
    await expect(readHttpJsonRpcEnvelope(Response.json(body))).resolves.toEqual(body);
  });

  it("continues past unrelated SSE messages to the matching reply", async () => {
    const matched = { jsonrpc: "2.0", id: 3, result: { ok: true } };
    const events = [null, { jsonrpc: "2.0", id: 4, result: {} },
      { jsonrpc: "2.0", id: 3, method: "ping" }, matched];
    const response = new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
    await expect(readHttpJsonRpcEnvelope(response, 3)).resolves.toEqual(matched);
  });
});
