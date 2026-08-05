import { describe, expect, it, vi } from "vitest";
import {
  ApprovalRemoteTokenSecretService,
  buildApprovalRemoteTokenSecretRef,
  deleteApprovalRemoteTokenSecret,
  resolveApprovalRemoteTokenSecret,
  storeApprovalRemoteTokenSecret,
} from "./approval-remote-token-secret.js";

describe("approval remote token keychain references", () => {
  it("survives service recreation without putting the bearer in the reference", () => {
    const secrets = new Map<string, string>();
    const store = {
      setSecret: vi.fn((account: string, value: string) => secrets.set(account, value)),
      getSecret: vi.fn((account: string) => secrets.get(account)),
      deleteSecret: vi.fn((account: string) => secrets.delete(account)),
    };
    const rawToken = `grat_${"k".repeat(43)}`;

    const secretRef = storeApprovalRemoteTokenSecret(store as never, "rat_restart", rawToken);
    const restartedStore = { ...store };

    expect(secretRef).toBe("keychain:goatcitadel:approval-remote-action:rat_restart");
    expect(secretRef).not.toContain(rawToken);
    expect(resolveApprovalRemoteTokenSecret(restartedStore as never, secretRef)).toBe(rawToken);

    deleteApprovalRemoteTokenSecret(restartedStore as never, secretRef);
    expect(secrets.size).toBe(0);
  });

  it("rejects arbitrary keychain references", () => {
    const store = { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() };
    expect(() => resolveApprovalRemoteTokenSecret(store as never, "keychain:goatcitadel:provider:openai")).toThrow(
      /reference is invalid/i,
    );
  });

  it("derives the cleanup reference from an opaque token id", () => {
    expect(buildApprovalRemoteTokenSecretRef("rat_cleanup_1")).toBe(
      "keychain:goatcitadel:approval-remote-action:rat_cleanup_1",
    );
    expect(() => buildApprovalRemoteTokenSecretRef("rat:unsafe")).toThrow(/id is invalid/i);
  });

  it("removes protected secrets before expiring canonical token rows", async () => {
    const deleteSecret = vi.fn();
    const tokens = {
      listPendingExpired: vi.fn(() => [{ tokenId: "rat_expired" }]),
      expirePendingIfExpired: vi.fn(() => ({ state: "expired" })),
    };
    const hostNow = vi.fn(() => new Date("2100-07-10T12:00:00.000Z"));
    const service = new ApprovalRemoteTokenSecretService(
      { setSecret: vi.fn(), getSecret: vi.fn(), deleteSecret } as never,
      tokens as never,
      hostNow,
    );

    await expect(service.reconcileExpired(25)).resolves.toBe(1);
    expect(tokens.listPendingExpired).toHaveBeenCalledWith(25);
    expect(deleteSecret).toHaveBeenCalledWith("approval-remote-action:rat_expired");
    expect(tokens.expirePendingIfExpired).toHaveBeenCalledWith("rat_expired");
    expect(hostNow).not.toHaveBeenCalled();
    expect(deleteSecret.mock.invocationCallOrder[0]).toBeLessThan(
      tokens.expirePendingIfExpired.mock.invocationCallOrder[0]!,
    );
  });
});
