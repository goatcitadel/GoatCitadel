import { describe, expect, it, vi } from "vitest";
import { ChannelSecretCustodyService, parseChannelSecretRef } from "./channel-secret-custody-service.js";

function createHarness() {
  const values = new Map<string, string>();
  const store = {
    setSecret: vi.fn((account: string, value: string) => values.set(account, value)),
    getSecret: vi.fn((account: string) => values.get(account)),
    deleteSecret: vi.fn((account: string) => values.delete(account)),
  };
  return { values, store, custody: new ChannelSecretCustodyService(store as never) };
}

describe("ChannelSecretCustodyService", () => {
  it("stores an opaque temporary reference and promotes it without exposing the value", () => {
    const harness = createHarness();
    const temporary = harness.custody.storeTemporary("draft-1", "botToken", "secret-value");

    expect(temporary).toMatch(/^keychain:goatcitadel:channel-draft:draft-1:botToken:/);
    expect(temporary).not.toContain("secret-value");
    expect(harness.custody.resolve(temporary)).toBe("secret-value");

    const promoted = harness.custody.copyToConnection(temporary, "connection-1", "botToken");
    expect(promoted).toBe("keychain:goatcitadel:channel-connection:connection-1:botToken");
    expect(harness.custody.resolve(promoted)).toBe("secret-value");
    harness.custody.deleteTemporary(temporary);
    expect(() => harness.custody.resolve(temporary)).toThrow(/unavailable/);
  });

  it("rejects foreign references and field drift", () => {
    const harness = createHarness();
    const temporary = harness.custody.storeTemporary("draft-1", "botToken", "secret-value");
    expect(() => harness.custody.copyToConnection(temporary, "connection-1", "signingSecret")).toThrow(/not bound/);
    expect(() => parseChannelSecretRef("keychain:goatcitadel:provider:openai")).toThrow(/invalid/);
  });
});
