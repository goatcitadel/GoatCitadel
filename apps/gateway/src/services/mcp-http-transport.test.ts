import { describe, expect, it } from "vitest";
import { isReplyFor } from "./mcp-http-transport.js";

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
