import { describe, expect, it } from "vitest";
import { decodeMcpCredentialReceipt, encodeMcpCredentialReceipt, isMcpReceiptAccount } from "./mcp-credential-receipt.js";
import { isMcpEnvironmentRefForServer } from "./mcp-static-environment-service.js";
import { isMcpOAuthTokenRefForServer } from "./mcp-oauth-token-service.js";

const id = "11111111-2222-4333-8444-555555555555";

describe("private MCP credential write receipts", () => {
  it("retains exact secret bytes inside one versioned envelope", () => {
    const secret = '  \uFEFFprivate-value\n"🦙" ';
    const encoded = encodeMcpCredentialReceipt(secret, id);
    expect(encoded).not.toMatch(/[^\x20-\x7e]/u);
    expect(decodeMcpCredentialReceipt(encoded)).toEqual({ writeId: id, secret });
  });
  it.each(["null", "[]", "{private-input", JSON.stringify({ version: 1, writeId: id, secret: "" }),
    JSON.stringify({ version: 1, writeId: id, secret: "private-value", extra: true }),
    JSON.stringify({ version: 2, writeId: id, secret: "private-value" }),
    JSON.stringify({ version: 1, writeId: "wrong", secret: "private-value" }), "x".repeat(49153)])(
    "refuses malformed or oversized private input without exposing it (%#)", (encoded) => {
      expect(() => decodeMcpCredentialReceipt(encoded)).toThrow("receipt is invalid or unavailable");
    });
  it("bounds encoded UTF-8 bytes and requires the canonical write identity", () => {
    expect(() => encodeMcpCredentialReceipt("🦙".repeat(16000), id)).toThrow("invalid");
    expect(() => encodeMcpCredentialReceipt("private-value", "wrong")).toThrow("invalid");
  });
  it.each(["environment", "access-token", "refresh-token"] as const)("keeps %s receipt slots distinct from legacy values", (kind) => {
    const account = `mcp:fixture:${kind}:receipt-v1:${id}`, ref = `keychain:goatcitadel:${account}`;
    expect(isMcpReceiptAccount(account)).toBe(true);
    expect(isMcpReceiptAccount(`mcp:fixture:${kind}:${id}`)).toBe(false);
    const owned = kind === "environment" ? isMcpEnvironmentRefForServer :
      (value: string, server: string) => isMcpOAuthTokenRefForServer(value, server, kind);
    expect(owned(ref, "fixture")).toBe(true);
    expect(owned(ref, "other")).toBe(false);
    expect(owned(ref.replace("receipt-v1", "receipt-v2"), "fixture")).toBe(false);
  });
});
