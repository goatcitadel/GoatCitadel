import { describe, expect, it } from "vitest";
import { HOOK_SECRET_REF_PATTERN, isChangePlanRequest } from "@goatcitadel/contracts";
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

  // A plugin install plan carries only the reference this service mints, so the contract pattern must match a stored one.
  it("mints references that match the contract pattern a plugin install plan accepts", () => {
    const service = new HookSecretCustodyService({
      setSecret: () => undefined,
      getSecret: () => undefined,
      deleteSecret: () => undefined,
    } as never);

    const reference = service.storeSecret("signing-value");

    expect(reference).toMatch(HOOK_SECRET_REF_PATTERN);
    expect(
      isChangePlanRequest({
        kind: "plugin_install",
        inspectionId: "inspection-1",
        manifestSha256: "a".repeat(64),
        snapshotTreeSha256: "b".repeat(64),
        workspaceId: "default",
        hookSecretRefs: { "audit-hook": reference },
      }),
    ).toBe(true);
    // A raw secret value is not a reference, so a plan cannot carry one.
    expect(HOOK_SECRET_REF_PATTERN.test("signing-value")).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "plugin_install",
        inspectionId: "inspection-1",
        manifestSha256: "a".repeat(64),
        snapshotTreeSha256: "b".repeat(64),
        workspaceId: "default",
        hookSecretRefs: { "audit-hook": "signing-value" },
      }),
    ).toBe(false);
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
