import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { buildRemoteWorkerPopV2Preimage, REMOTE_WORKER_POP_V2_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { WorkerCredentialVault, type RetainedRuntimeCredential } from "./worker-credential-vault.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { WorkerWireClient, type WorkerWireRequest } from "./worker-wire-client.js";
import { normalizeWorkerProtectedKeyReference, type WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ type: "spki", format: "der" });
  const reference = normalizeWorkerProtectedKeyReference({
    kind: "windows_provisioner",
    keysetGeneration: 7,
    protectedStateSha256: "11".repeat(32),
    keysetReceiptSha256: "22".repeat(32),
    workerPublicKeySpkiBase64Url: spki.toString("base64url"),
  });
  const credential: RetainedRuntimeCredential = {
    credentialId: "credential",
    credentialGeneration: 1,
    workerGeneration: 7,
    registryWorkspaceId: "workspace",
    authorizationCredential: "A".repeat(43),
    clientCertificateSha256: "33".repeat(32),
    workerPublicKeySpkiSha256: createHash("sha256").update(spki).digest("hex"),
    protectedKey: reference,
  };
  const owner: WorkerProtectedKeyOwner = {
    reference,
    admissionSignerSpkiBase64Url: spki.toString("base64url"),
    signPopV2: vi.fn(async ({ preimage }) => sign(null, preimage, keys.privateKey).toString("base64url")),
    signAdmissionEnvelope: vi.fn(async () => {
      throw new Error("Not used in runtime proof");
    }),
  };
  const client = new WorkerWireClient({
    host: "127.0.0.1",
    port: 1,
    clientPrivateKeyPem: "fixture",
    clientCertificatePem: "fixture",
    trustAnchorPem: "fixture",
  });
  const material = {
    rawPath: "/api/v1/remote-workers/assignment-offer-polls",
    operation: "assignment.offers.poll",
    bodySha256: "44".repeat(32),
    tlsExporterSha256: "55".repeat(32),
    idempotencyKey: "poll",
    nonce: "B".repeat(42) + "A",
    timestamp: "2026-09-10T00:00:00.000Z",
    signal: new AbortController().signal,
  } as const;
  const call = {
    client,
    credential,
    rawPath: material.rawPath,
    operation: material.operation,
    idempotencyKey: "poll",
    payload: {},
  };
  return { keys, reference, credential, owner, client, material, call };
}

describe("protected worker credential custody", () => {
  it("retains only public key authority and reconnects after restart", async () => {
    const { credential, reference } = fixture();
    const state = createInMemoryWorkerDurableState();
    await (await WorkerCredentialVault.open(state)).retainCredential(credential);
    const stored = await state.read("runtime-credential");
    expect(stored).not.toContain("PRIVATE KEY");
    expect(stored).not.toContain("signingPrivateKeyPem");
    const restarted = await WorkerCredentialVault.open(state);
    expect(restarted.getCredential().protectedKey).toEqual(reference);
    expect(restarted.reconnectAuthorization()).toBe(`Bearer ${credential.authorizationCredential}`);
  });
  it("rejects ambiguous, missing, changed-generation and changed-key custody", async () => {
    const { credential, reference, keys } = fixture();
    const state = createInMemoryWorkerDurableState();
    const vault = await WorkerCredentialVault.open(state);
    for (const changed of [
      { ...credential, signingPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
      { ...credential, protectedKey: undefined },
      { ...credential, protectedKey: { ...reference, keysetGeneration: 8 } },
      { ...credential, workerPublicKeySpkiSha256: "66".repeat(32) },
      { ...credential, protectedKey: { ...reference, bootstrapSecret: "must not persist" } },
    ])
      await expect(vault.retainCredential(changed as RetainedRuntimeCredential)).rejects.toThrow();
    expect(await state.read("runtime-credential")).toBeUndefined();
  });
  it("does not expose a protected credential after its durable write fails", async () => {
    const { credential } = fixture();
    const backing = createInMemoryWorkerDurableState();
    const vault = await WorkerCredentialVault.open({
      ...backing,
      write: async () => {
        throw new Error("disk full");
      },
    });
    await expect(vault.retainCredential(credential)).rejects.toThrow("disk full");
    expect(vault.hasCredential()).toBe(false);
  });
});

describe("protected worker runtime signatures", () => {
  it("requires a matching native owner before opening a request", async () => {
    const { owner, client, call } = fixture();
    const post = vi.spyOn(client, "post");
    await expect(callProtectedRoute(call)).rejects.toThrow("protected key owner");
    await expect(
      callProtectedRoute({
        ...call,
        protectedKeys: { ...owner, reference: { ...owner.reference, protectedStateSha256: "77".repeat(32) } },
      }),
    ).rejects.toThrow("protected key owner");
    expect(post).not.toHaveBeenCalled();
  });
  it("signs the canonical runtime proof with the exact retained authority and connection signal", async () => {
    const { owner, client, material, call, credential } = fixture();
    let proof: string | undefined;
    vi.spyOn(client, "post").mockImplementation(async (request) => {
      proof = await request.sign(material);
      return { status: 200, body: {} };
    });
    await callProtectedRoute({ ...call, protectedKeys: owner });
    const { signal: _signal, ...unsigned } = material;
    const preimage = buildRemoteWorkerPopV2Preimage({
      schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
      method: "POST",
      ...unsigned,
      authorityKind: "credential",
      authorityId: credential.credentialId,
      authorityGeneration: credential.credentialGeneration,
      workerGeneration: credential.workerGeneration,
      clientCertificateSha256: credential.clientCertificateSha256,
      workerPublicKeySpkiSha256: credential.workerPublicKeySpkiSha256,
    });
    expect(owner.signPopV2).toHaveBeenCalledWith({
      reference: owner.reference,
      preimage: Buffer.from(preimage),
      signal: material.signal,
    });
    expect(proof).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  });
  it("rejects forged signatures and late results after cancellation", async () => {
    const { owner, client, material, call } = fixture();
    let request!: WorkerWireRequest;
    vi.spyOn(client, "post").mockImplementation(async (input) => {
      request = input;
      return { status: 200, body: {} };
    });
    await callProtectedRoute({
      ...call,
      protectedKeys: { ...owner, signPopV2: async () => Buffer.alloc(64, 1).toString("base64url") },
    });
    await expect(request.sign(material)).rejects.toThrow("signature");
    const abort = new AbortController();
    await callProtectedRoute({
      ...call,
      protectedKeys: {
        ...owner,
        signPopV2: async (input) => {
          const result = await owner.signPopV2(input);
          abort.abort();
          return result;
        },
      },
    });
    await expect(request.sign({ ...material, signal: abort.signal })).rejects.toThrow();
  });
  it("does not accept a signer's mutation of the submitted bytes", async () => {
    const { keys, owner, client, material, call } = fixture();
    vi.spyOn(client, "post").mockImplementation(async (request) => {
      await request.sign(material);
      return { status: 200, body: {} };
    });
    const changedOwner = {
      ...owner,
      signPopV2: async ({ preimage }: { preimage: Uint8Array }) => {
        preimage[0] = (preimage[0] ?? 0) ^ 1;
        return sign(null, preimage, keys.privateKey).toString("base64url");
      },
    };
    await expect(callProtectedRoute({ ...call, protectedKeys: changedOwner })).rejects.toThrow("signature");
    expect(createPublicKey(keys.privateKey).asymmetricKeyType).toBe("ed25519");
  });
});
