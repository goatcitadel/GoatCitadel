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
    expect(promoted).toMatch(/^keychain:goatcitadel:channel-connection:connection-1:botToken:[a-f0-9-]+$/);
    expect(harness.custody.resolve(promoted)).toBe("secret-value");
    harness.custody.deleteTemporary(temporary);
    expect(() => harness.custody.resolve(temporary)).toThrow(/unavailable/);
  });

  it("keeps legacy and competing credential versions intact when one promotion is removed", () => {
    const { store, custody } = createHarness();
    store.setSecret("channel-connection:connection-1:botToken", "legacy");
    const legacy = "keychain:goatcitadel:channel-connection:connection-1:botToken";
    const left = custody.copyToConnection(custody.storeTemporary("draft-1", "botToken", "left"), "connection-1", "botToken");
    const right = custody.copyToConnection(custody.storeTemporary("draft-2", "botToken", "right"), "connection-1", "botToken");
    expect(left).not.toBe(right);
    expect(custody.resolve(legacy)).toBe("legacy");
    custody.delete(left);
    expect(custody.resolve(right)).toBe("right");
    expect(custody.resolve(legacy)).toBe("legacy");
    expect(() => parseChannelSecretRef(`${right}:extra`)).toThrow(/invalid/);
  });

  it("rejects foreign references and field drift", () => {
    const harness = createHarness();
    const temporary = harness.custody.storeTemporary("draft-1", "botToken", "secret-value");
    expect(() => harness.custody.copyToConnection(temporary, "connection-1", "signingSecret")).toThrow(/not bound/);
    expect(() => parseChannelSecretRef("keychain:goatcitadel:provider:openai")).toThrow(/invalid/);
  });
});
