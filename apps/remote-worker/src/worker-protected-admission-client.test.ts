import { createHash, createPrivateKey, sign, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import {
  buildRemoteWorkerRuntimeCredentialClaims,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
  remoteWorkerRuntimeCredentialClaimsSha256,
} from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProtectedAdmissionEvidence } from "./worker-admission-client.js";
import { admitProtectedWorker, type WorkerProtectedAdmissionTicket } from "./worker-protected-admission-client.js";
import { normalizeWorkerProtectedKeyReference, type WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import { WorkerWireClient, type WorkerWireRequest } from "./worker-wire-client.js";
import { CA_PEM, CLIENT_CERT_PEM, CLIENT_KEY_PEM } from "./worker-wire-client-tls.test-fixture.js";
import { WorkerCredentialVault } from "./worker-credential-vault.js";
import { createFileWorkerDurableState } from "./worker-durable-state.js";
import { runConnectedWorker } from "./connected-worker-runtime.js";
import type { ProtectedConnectedWorkerConfig } from "./worker-runtime-config.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fixture() {
  const client = new WorkerWireClient({
    host: "127.0.0.1",
    port: 1,
    trustAnchorPem: CA_PEM,
    clientCertificatePem: CLIENT_CERT_PEM,
    clientPrivateKeyPem: CLIENT_KEY_PEM,
  });
  const identity = client.identity();
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "default",
    workerId: "worker",
    workerGeneration: 1,
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["gateway_inference"],
  });
  const ticket: WorkerProtectedAdmissionTicket = {
    registryWorkspaceId: "default",
    executionWorkspaceId: "default",
    bootstrapId: "bootstrap",
    workerId: "worker",
    nodeId: "node",
    targetWorkerGeneration: 1,
    platform: "windows",
    architecture: "x64",
    runtimeManifestSha256: hash("manifest"),
    runtimeManifestPayloadSha256: hash("payload"),
    workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256,
    keysetReceiptSha256: hash("keyset"),
    protectedSignerPublicKeySpkiBase64Url: identity.publicKeySpkiBase64Url,
    bootstrapSecret: "fixture-bootstrap",
    downloadVerificationReceiptSha256: hash("download"),
    installedTreeAttestationSha256: hash("attestation"),
    installedTreeVerificationReceiptSha256: hash("tree"),
  };
  const reference = normalizeWorkerProtectedKeyReference({
    kind: "windows_provisioner",
    keysetGeneration: 1,
    protectedStateSha256: hash(`worker-protected-state:${ticket.bootstrapId}`),
    keysetReceiptSha256: ticket.keysetReceiptSha256,
    workerPublicKeySpkiBase64Url: identity.publicKeySpkiBase64Url,
  });
  const abort = new AbortController();
  const channel = {
    tlsExporterSha256: hash("channel"),
    nonce: Buffer.alloc(32, 1).toString("base64url"),
    timestamp: "2026-09-10T00:00:00.000Z",
    signal: abort.signal,
  };
  // Reuse the established independent PEM fixture encoder to check native wire compatibility.
  const evidence = buildProtectedAdmissionEvidence({
    ticket: { ...ticket, protectedSignerPrivateKeyPem: CLIENT_KEY_PEM },
    identity,
    tlsExporterSha256: channel.tlsExporterSha256,
    evidenceNonce: channel.nonce,
  });
  const owner: WorkerProtectedKeyOwner = {
    reference,
    admissionSignerSpkiBase64Url: identity.publicKeySpkiBase64Url,
    signAdmissionEnvelope: vi.fn(async () =>
      normalizeRemoteWorkerProtectedAdmissionEvidenceWire(structuredClone(evidence)),
    ),
    signPopV2: vi.fn(async ({ preimage }) =>
      sign(null, preimage, createPrivateKey(CLIENT_KEY_PEM)).toString("base64url"),
    ),
  };
  const generation = {
    registryWorkspaceId: ticket.registryWorkspaceId,
    workerId: ticket.workerId,
    nodeId: ticket.nodeId,
    workerGeneration: 1,
    bootstrapId: ticket.bootstrapId,
    publicKeySpkiSha256: identity.publicKeySpkiSha256,
    clientCertificateSha256: identity.clientCertificateSha256,
    runtimeManifestSha256: ticket.runtimeManifestSha256,
    workspaceCeilingSha256: ticket.workspaceCeilingSha256,
    capabilityCeilingSha256: ticket.capabilityCeilingSha256,
    transportIdentitySource: "native_mtls",
    transportTrustAnchorSha256: identity.trustAnchorSha256,
    transportVerificationReceiptSha256: hash("transport"),
    proofOfPossessionReceiptSha256: hash("proof"),
    downloadVerificationReceiptSha256: ticket.downloadVerificationReceiptSha256,
    installedTreeAttestationSha256: ticket.installedTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: ticket.installedTreeVerificationReceiptSha256,
    exchangeIdempotencyKey: "admit",
    exchangeRequestSha256: hash("exchange"),
    admittedAt: channel.timestamp,
  };
  const credential = {
    registryWorkspaceId: ticket.registryWorkspaceId,
    workerId: ticket.workerId,
    workerGeneration: 1,
    credentialGeneration: 1,
    credentialId: "credential",
    purpose: claims.purpose,
    claims,
    claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
    issuanceProofSha256: hash("issuance"),
    idempotencyKey: "admit",
    requestSha256: hash("request"),
    issuedAt: channel.timestamp,
    expiresAt: "2026-09-10T01:00:00.000Z",
  };
  const response = {
    status: 201,
    body: {
      disposition: "admitted",
      generation,
      credential,
      authorizationScheme: "Bearer",
      secretDisposition: "returned_once",
      credentialSecret: Buffer.alloc(32, 2).toString("base64url"),
    },
  };
  const post = vi.spyOn(client, "post").mockResolvedValue(response);
  const run = (protectedKeys = owner, admissionTicket = ticket) =>
    admitProtectedWorker({ client, ticket: admissionTicket, protectedKeys, idempotencyKey: "admit" });
  const request = () => post.mock.calls[0]![0];
  return { client, ticket, identity, owner, reference, channel, abort, response, post, run, request };
}

describe("protected worker bootstrap admission", () => {
  it("returns a public key reference and signs bootstrap PoP-v2 using the connection authority", async () => {
    const f = fixture();
    const retained = await f.run();
    const request = f.request();
    const body = await request.buildBody(f.channel);
    expect(body).toMatchObject({
      schemaVersion: "goatcitadel.remote-worker-pop.v2",
      authorityId: "bootstrap",
      workerGeneration: 1,
    });
    const proof = await request.sign({
      ...f.channel,
      rawPath: request.rawPath,
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
      bodySha256: hash(JSON.stringify(body)),
    });
    const preimage = vi.mocked(f.owner.signPopV2).mock.calls[0]![0].preimage;
    expect(verify(null, preimage, createPrivateKey(CLIENT_KEY_PEM), Buffer.from(proof, "base64url"))).toBe(true);
    expect(f.owner.signAdmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ reference: f.reference, signal: f.channel.signal }),
    );
    expect(retained).toMatchObject({ protectedKey: f.reference, credentialId: "credential" });
    expect(retained).not.toHaveProperty("signingPrivateKeyPem");
    expect(JSON.stringify(retained)).not.toContain(f.ticket.bootstrapSecret);
  });

  it.each([
    "runtimeManifestSha256",
    "workspaceCeilingSha256",
    "capabilityCeilingSha256",
    "downloadVerificationReceiptSha256",
    "installedTreeAttestationSha256",
    "installedTreeVerificationReceiptSha256",
  ] as const)("rejects a response that changes admitted %s", async (field) => {
    const f = fixture();
    f.response.body.generation[field] = hash("changed");
    await expect(f.run()).rejects.toThrow("authority");
  });

  it("rejects widened credential claims even when their own digest is correct", async () => {
    const f = fixture();
    const claims = buildRemoteWorkerRuntimeCredentialClaims({
      registryWorkspaceId: "default",
      workerId: "worker",
      workerGeneration: 1,
      allowedWorkspaceIds: ["default", "other"],
      capabilityClasses: ["gateway_inference"],
    });
    f.response.body.credential.claims = claims;
    f.response.body.credential.claimsSha256 = remoteWorkerRuntimeCredentialClaimsSha256(claims);
    await expect(f.run()).rejects.toThrow("authority");
  });

  it.each(["authorizationScheme", "secretDisposition"] as const)("rejects changed %s", async (field) => {
    const f = fixture();
    f.response.body[field] = "other";
    await expect(f.run()).rejects.toThrow("authority");
  });

  it("requires the exact fresh exchange and handles secretless replay as reconciliation", async () => {
    const f = fixture();
    f.response.body.generation.exchangeIdempotencyKey = "another-exchange";
    await expect(f.run()).rejects.toThrow("authority");
    f.response.body.disposition = "replayed_without_secret";
    await expect(f.run()).rejects.toThrow("reconcile");
  });

  it("rejects mismatched custody and any PEM field before transport", async () => {
    const f = fixture();
    await expect(f.run({ ...f.owner, reference: { ...f.reference, keysetGeneration: 2 } })).rejects.toThrow(
      "authority",
    );
    await expect(
      f.run(f.owner, { ...f.ticket, protectedSignerPrivateKeyPem: undefined } as WorkerProtectedAdmissionTicket),
    ).rejects.toThrow("PEM");
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["protectedStateSha256", "signatureBase64Url", "envelopeSha256"] as const)(
    "rejects changed admission evidence %s",
    async (field) => {
      const f = fixture();
      const original = f.owner.signAdmissionEnvelope;
      await f.run({
        ...f.owner,
        signAdmissionEnvelope: async (input) => {
          const evidence = structuredClone(await original(input));
          return {
            ...evidence,
            signerResult: {
              ...evidence.signerResult,
              [field]: field === "signatureBase64Url" ? Buffer.alloc(64, 3).toString("base64url") : hash("changed"),
            },
          };
        },
      });
      await expect(f.request().buildBody(f.channel)).rejects.toThrow();
    },
  );

  it("rejects admission evidence returned after cancellation", async () => {
    const f = fixture();
    await f.run({
      ...f.owner,
      signAdmissionEnvelope: async (input) => {
        const evidence = await f.owner.signAdmissionEnvelope(input);
        f.abort.abort();
        return evidence;
      },
    });
    await expect(f.request().buildBody(f.channel)).rejects.toThrow();
  });

  it("never signs a runtime route with bootstrap authority", async () => {
    const f = fixture();
    await f.run();
    const material: Parameters<WorkerWireRequest["sign"]>[0] = {
      ...f.channel,
      idempotencyKey: "admit",
      bodySha256: hash("body"),
      rawPath: "/api/v1/remote-workers/assignment-offer-polls",
      operation: "assignment.offers.poll",
    };
    expect(() => f.request().sign(material)).toThrow("bootstrap route");
    expect(f.owner.signPopV2).not.toHaveBeenCalled();
  });
});

async function restartFixture() {
  const f = fixture();
  const stateDir = await mkdtemp(join(tmpdir(), "goat-protected-restart-"));
  roots.push(stateDir);
  const state = createFileWorkerDurableState(stateDir);
  await (await WorkerCredentialVault.open(state)).retainCredential(await f.run());
  f.post.mockRestore();
  // This unit fixture supplies a normal test context; native custody is tested separately.
  const clientTlsContext = createSecureContext({ ca: CA_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM });
  const config: ProtectedConnectedWorkerConfig = {
    transport: {
      host: "127.0.0.1",
      port: 1,
      trustAnchorPem: CA_PEM,
      clientCertificatePem: CLIENT_CERT_PEM,
      clientTlsContext,
    },
    ticket: { ...f.ticket, bootstrapSecret: "already-consumed" },
    stateDir,
    reportFile: join(stateDir, "report.json"),
    runId: "restart",
    stopAfter: "admit",
  };
  const transport = vi.spyOn(WorkerWireClient.prototype, "post").mockRejectedValue(new Error("Unexpected transport"));
  return { ...f, state, config, transport };
}

describe("protected connected worker restart", () => {
  it("retains a fresh admission before reporting handoff readiness and requests no assignment", async () => {
    const f = await restartFixture();
    await f.state.delete("runtime-credential");
    f.response.body.generation.exchangeIdempotencyKey = `worker-admission:${f.ticket.bootstrapId}`;
    f.transport.mockResolvedValue(f.response);
    const result = await runConnectedWorker({ ...f.config, ticket: f.ticket }, { protectedKeys: f.owner });
    const retained = await f.state.read("runtime-credential");
    expect(result).toMatchObject({
      admitted: "bootstrap_exchange",
      stagesCompleted: ["admit"],
      enrollment: {
        schemaVersion: "goatcitadel.remote-worker.enrollment.v1",
        credentialSha256: hash(retained!),
      },
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0]![0]).toMatchObject({ operation: "bootstrap.exchange" });
    expect(retained).not.toContain(f.ticket.bootstrapSecret);
  });

  it("binds an admission-only report to the exact retained credential without exposing it", async () => {
    const f = await restartFixture();
    const result = await runConnectedWorker(f.config, { protectedKeys: f.owner });
    const retained = await f.state.read("runtime-credential");
    expect(retained).toBeTypeOf("string");
    expect(result).toMatchObject({
      runId: "restart",
      outcome: "stopped",
      stagesCompleted: ["admit"],
      admitted: "retained_credential",
      enrollment: {
        schemaVersion: "goatcitadel.remote-worker.enrollment.v1",
        credentialSha256: hash(retained!),
      },
    });
    const credential = (await WorkerCredentialVault.open(f.state)).getCredential();
    expect(JSON.stringify(result)).not.toContain(credential.authorizationCredential);
    expect(JSON.stringify(result)).not.toContain("already-consumed");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.owner.signAdmissionEnvelope).not.toHaveBeenCalled();
  });

  it("reopens the saved public reference without bootstrap exchange or signing", async () => {
    const f = await restartFixture();
    await expect(runConnectedWorker(f.config, { protectedKeys: f.owner })).resolves.toMatchObject({
      admitted: "retained_credential",
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.owner.signAdmissionEnvelope).not.toHaveBeenCalled();
    const retained = await f.state.read("runtime-credential");
    expect(retained).not.toContain("PRIVATE KEY");
    expect(retained).not.toContain("already-consumed");
  });

  it.each([
    "registryWorkspaceId",
    "targetWorkerGeneration",
    "keysetReceiptSha256",
    "protectedSignerPublicKeySpkiBase64Url",
  ] as const)("refuses changed %s before reconnecting", async (field) => {
    const f = await restartFixture();
    const changed = {
      ...f.config,
      ticket: { ...f.config.ticket, [field]: field === "targetWorkerGeneration" ? 2 : "different" },
    };
    await expect(runConnectedWorker(changed, { protectedKeys: f.owner })).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("requires the original native owner and never falls back to a PEM credential", async () => {
    const f = await restartFixture();
    await expect(runConnectedWorker(f.config)).rejects.toThrow("protected key owner");
    await expect(
      runConnectedWorker(f.config, {
        protectedKeys: { ...f.owner, reference: { ...f.reference, protectedStateSha256: hash("changed") } },
      }),
    ).rejects.toThrow("protected key owner");
    const { protectedKey: _reference, ...authority } = (await WorkerCredentialVault.open(f.state)).getCredential();
    await (
      await WorkerCredentialVault.open(f.state)
    ).retainCredential({ ...authority, signingPrivateKeyPem: CLIENT_KEY_PEM });
    await expect(runConnectedWorker(f.config, { protectedKeys: f.owner })).rejects.toThrow("PEM credential");
    expect(f.transport).not.toHaveBeenCalled();
  });
});
