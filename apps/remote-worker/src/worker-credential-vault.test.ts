import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkerDurableState, type WorkerDurableStatePort } from "./worker-durable-state.js";
import {
  WorkerCredentialVault,
  WorkerCredentialVaultError,
  type RetainedRuntimeCredential,
} from "./worker-credential-vault.js";

function signingKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function base64Url32(): string {
  return randomBytes(32).toString("base64url");
}

function validCredential(overrides: Partial<RetainedRuntimeCredential> = {}): RetainedRuntimeCredential {
  return {
    credentialId: "cred-abc",
    credentialGeneration: 1,
    workerGeneration: 1,
    registryWorkspaceId: "workspace-1",
    authorizationCredential: base64Url32(),
    clientCertificateSha256: "a".repeat(64),
    workerPublicKeySpkiSha256: "b".repeat(64),
    signingPrivateKeyPem: signingKeyPem(),
    ...overrides,
  };
}

describe("worker credential vault", () => {
  it("retains a credential and hydrates it back", async () => {
    const state = createInMemoryWorkerDurableState();
    const vault = await WorkerCredentialVault.open(state);
    expect(vault.hasCredential()).toBe(false);
    expect(() => vault.getCredential()).toThrow(WorkerCredentialVaultError);
    const credential = validCredential();
    await vault.retainCredential(credential);
    expect(vault.getCredential().credentialId).toBe("cred-abc");
  });

  it("never stores a one-time bootstrap secret and reconnects with the credential bearer", async () => {
    const state = createInMemoryWorkerDurableState();
    const vault = await WorkerCredentialVault.open(state);
    const bootstrapSecret = randomBytes(32).toString("base64url");
    const credential = validCredential({ authorizationCredential: base64Url32() });
    await vault.retainCredential(credential);

    // Reconnect authority is the credential bearer — not a GoatWorkerBootstrap secret.
    expect(vault.reconnectAuthorization()).toBe(`Bearer ${credential.authorizationCredential}`);
    expect(vault.reconnectAuthorization()).not.toContain(bootstrapSecret);
    const persisted = await state.read("runtime-credential");
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain(bootstrapSecret);

    // A credential that smuggles a bootstrap secret field is rejected outright.
    await expect(
      vault.retainCredential({ ...credential, bootstrapSecret } as unknown as RetainedRuntimeCredential),
    ).rejects.toBeInstanceOf(WorkerCredentialVaultError);
  });

  it("reconnects after a simulated restart without re-running admission", async () => {
    const backing = new Map<string, string>();
    const state: WorkerDurableStatePort = {
      read: (key) => Promise.resolve(backing.get(key)),
      write: (key, value) => {
        backing.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        backing.delete(key);
        return Promise.resolve();
      },
    };
    const credential = validCredential();
    const first = await WorkerCredentialVault.open(state);
    await first.retainCredential(credential);

    // "Restart": a fresh vault over the same durable state re-hydrates the credential.
    const restarted = await WorkerCredentialVault.open(state);
    expect(restarted.hasCredential()).toBe(true);
    expect(restarted.reconnectAuthorization()).toBe(`Bearer ${credential.authorizationCredential}`);
    expect(restarted.getCredential().signingPrivateKeyPem).toBe(credential.signingPrivateKeyPem);
  });

  it("retains, rotates, and forgets per-assignment leases across restart", async () => {
    const state = createInMemoryWorkerDurableState();
    const vault = await WorkerCredentialVault.open(state);
    await vault.retainCredential(validCredential());
    const token = base64Url32();
    await vault.retainLease({
      assignmentId: "assign-1",
      rawLeaseToken: token,
      leaseRevision: 1,
      assignmentGeneration: 1,
    });
    expect(vault.getLease("assign-1").leaseRevision).toBe(1);

    const rotated = base64Url32();
    await vault.advanceLease("assign-1", 2, rotated);
    expect(vault.getLease("assign-1").leaseRevision).toBe(2);
    expect(vault.getLease("assign-1").rawLeaseToken).toBe(rotated);
    await expect(vault.advanceLease("assign-1", 1)).rejects.toBeInstanceOf(WorkerCredentialVaultError);

    const restarted = await WorkerCredentialVault.open(state);
    expect(restarted.getLease("assign-1").leaseRevision).toBe(2);
    expect(restarted.listLeaseAssignmentIds()).toContain("assign-1");
    await restarted.forgetLease("assign-1");
    expect((await WorkerCredentialVault.open(state)).hasLease("assign-1")).toBe(false);
  });

  it("rejects a malformed credential", async () => {
    const vault = await WorkerCredentialVault.open(createInMemoryWorkerDurableState());
    await expect(
      vault.retainCredential(validCredential({ authorizationCredential: "too-short" })),
    ).rejects.toBeInstanceOf(WorkerCredentialVaultError);
    await expect(vault.retainCredential(validCredential({ signingPrivateKeyPem: "not-a-pem" }))).rejects.toBeInstanceOf(
      WorkerCredentialVaultError,
    );
  });
});
