import { describe, expect, it } from "vitest";
import { HookSecretCustodyService } from "./hook-secret-custody-service.js";

describe("HookSecretCustodyService", () => {
  it("stores a signing key behind an opaque, hook-only keychain reference", () => {
    const values = new Map<string, string>();
    const service = new HookSecretCustodyService({
      setSecret: (account, secret) => values.set(account, secret),
      getSecret: (account) => values.get(account),
      deleteSecret: (account) => values.delete(account),
    } as never);

    const reference = service.storeSecret(" signing-value ");

    expect(reference).toMatch(/^keychain:goatcitadel:hook:[0-9a-f-]+$/);
    expect(reference).not.toContain("signing-value");
    expect(service.resolveSecret(reference)).toBe("signing-value");
    service.deleteSecret(reference);
    expect(() => service.resolveSecret(reference)).toThrow(/unavailable/i);
  });

  it("rejects foreign or malformed references", () => {
    const service = new HookSecretCustodyService({
      setSecret: () => undefined,
      getSecret: () => undefined,
      deleteSecret: () => undefined,
    } as never);

    expect(() => service.resolveSecret("keychain:goatcitadel:provider:abc")).toThrow(/invalid/i);
    expect(() => service.resolveSecret("keychain:goatcitadel:hook:too-short")).toThrow(/invalid/i);
  });
});
