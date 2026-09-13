import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_MESH_CAPABILITY_OPERATION as OPERATION,
  REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH as RAW_PATH,
  REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION as SCHEMA,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  buildRemoteWorkerPopV2Preimage,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  remoteWorkerRuntimeCredentialClaimsSha256,
} from "@goatcitadel/contracts";
import { tlsConfig, portOf } from "../../test/fixtures/remote-worker-native.js";
import { WorkerWireClient } from "../../../remote-worker/src/worker-wire-client.js";
import { exchangeWorkerMeshCapability } from "../../../remote-worker/src/worker-mesh-capability-client.js";
import { createRemoteWorkerMeshCapabilityNativeRequestHandler } from "./remote-worker-mesh-capability-handler.js";
import { RemoteWorkerMeshCapabilityProtocolService } from "./remote-worker-mesh-capability-protocol-service.js";
import { startRemoteWorkerNativeTlsListener } from "./remote-worker-native-tls-listener.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function harness(tls?: { key: KeyObject; certificate: X509Certificate; ca: X509Certificate }) {
  const key = tls?.key ?? generateKeyPairSync("ed25519").privateKey;
  const publicKeySpkiDer = createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer;
  const credential = randomBytes(32).toString("base64url");
  const claims = buildRemoteWorkerRuntimeCredentialClaims({ registryWorkspaceId: "registry-a", workerId: "worker-a",
    workerGeneration: 2, allowedWorkspaceIds: ["registry-a", "workspace-a"], capabilityClasses: ["governed_tool"] });
  const authority = {
    credentialId: "credential-a", credentialGeneration: 3, authorizationCredentialSha256: digest(credential),
    registryWorkspaceId: "registry-a", bootstrapId: "bootstrap-a", workerId: "worker-a", workerGeneration: 2, nodeId: "node-a",
    publicKeySpkiDer, publicKeySpkiSha256: digest(publicKeySpkiDer),
    clientCertificateSha256: digest(tls?.certificate.raw ?? "certificate"), transportTrustAnchorSha256: digest(tls?.ca.raw ?? "ca"),
    runtimeManifestSha256: digest("manifest"), workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256, protectedAdmissionEnvelopeSha256: digest("protected-envelope"),
    protectedAdmissionContextSha256: digest("protected-context"), claims, claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
  };
  const fence = {
    schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION, registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a", workerId: "worker-a", workerGeneration: 2, credentialId: "credential-a", credentialGeneration: 3,
    workspaceId: "workspace-a", nodeId: "node-a", admissionGeneration: 1, joinAuthorityGeneration: 1,
    joinCredentialSha256: digest("mesh"), protectedAdmissionEnvelopeSha256: authority.protectedAdmissionEnvelopeSha256,
    protectedAdmissionContextSha256: authority.protectedAdmissionContextSha256,
  };
  const resolved = vi.fn(async () => authority);
  const mesh = vi.fn(async () => fence);
  const seen = new Set<string>();
  const consume = vi.fn(async ({ nonceSha256 }: { nonceSha256: string }) => {
    if (seen.has(nonceSha256)) return false;
    seen.add(nonceSha256); return true;
  });
  const owners = {
    publication: { publishCapabilityManifest: vi.fn(async () => ({ replayed: false, manifest: {}, entries: [] })),
      listOwnPublications: vi.fn(async () => ({ workspaceId: "workspace-a", nodeId: "node-a", manifests: [] })) },
    invocation: {
      listPendingInvocations: vi.fn(async () => ({ items: [] })),
      readInvocationInput: vi.fn(async () => ({ invocationId: "invoke-a", inputSha256: digest("input"), input: { value: "controlled input" } })),
      recordProgress: vi.fn(async () => ({ accepted: true, sequence: 1 })),
      settleFromNode: vi.fn(async () => ({ settlement: {}, replayed: false })),
    },
  };
  const service = new RemoteWorkerMeshCapabilityProtocolService({
    ...owners, credentialAuthority: { resolveByCredentialTokenSha256: resolved },
    meshAdmissions: { resolveCurrentForRuntimeCredential: mesh }, nonceConsumer: { consume }, clock: () => new Date(),
  } as never);
  const signed = (action: Record<string, unknown> = { action: "pending" }) => {
    const payload = { schemaVersion: SCHEMA, workspaceId: "workspace-a", ...action };
    const body = { schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION, operation: OPERATION,
      authorityId: authority.credentialId, authorityGeneration: 3, workerGeneration: 2, idempotencyKey: "mesh:request", payload };
    const tlsExporter = randomBytes(32);
    const transportIdentity = { source: "native_mtls" as const, certificateDerSha256: authority.clientCertificateSha256,
      publicKeySpkiSha256: authority.publicKeySpkiSha256, trustAnchorDerSha256: authority.transportTrustAnchorSha256,
      tlsExporterSha256: digest(tlsExporter), tlsExporter };
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = new Date().toISOString();
    const proof = sign(null, buildRemoteWorkerPopV2Preimage({ schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
      method: "POST", rawPath: RAW_PATH, operation: OPERATION, bodySha256: digest(canonicalJsonString(body)),
      nonce, timestamp, idempotencyKey: body.idempotencyKey, authorityKind: "credential", authorityId: authority.credentialId,
      authorityGeneration: 3, workerGeneration: 2, tlsExporterSha256: transportIdentity.tlsExporterSha256,
      clientCertificateSha256: authority.clientCertificateSha256, workerPublicKeySpkiSha256: authority.publicKeySpkiSha256,
    }), key).toString("base64url");
    return { method: "POST", rawPath: RAW_PATH, body, transportIdentity, headers: {
      authorization: `Bearer ${credential}`, "idempotency-key": body.idempotencyKey,
      "x-goatcitadel-worker-nonce": nonce, "x-goatcitadel-worker-timestamp": timestamp,
      "x-goatcitadel-worker-operation": OPERATION, "x-goatcitadel-worker-proof": proof,
    } };
  };
  return { service, signed, authority, fence, resolved, mesh, consume, owners, credential, key };
}

describe("protected native mesh capability exchange", () => {
  it("routes only the six signed actions with server-derived native admission and fresh nonces", async () => {
    const h = harness();
    await h.service.assertAvailable();
    const binding = { invocationId: "invoke-a", publisherGeneration: 1, publicationLeaseFencingToken: 1 };
    const actions = [
      { action: "pending" }, { action: "publications" }, { action: "input", invocationId: "invoke-a" },
      { action: "publish", submission: { publicationKey: "publication-a", entries: [
        { localId: "status", kind: "tool", descriptor: {}, descriptorSha256: digest("descriptor") },
      ] } },
      { action: "progress", submission: { ...binding, sequence: 1, stage: "executing" } },
      { action: "settle", submission: { ...binding, disposition: "succeeded", settlementSha256: digest("settlement") } },
    ];
    for (const action of actions) {
      const request = h.signed(action);
      const exporter = Buffer.from(request.transportIdentity.tlsExporter);
      await expect(h.service.execute(request)).resolves.toMatchObject({ action: action.action, workspaceId: "workspace-a", nodeId: "node-a" });
      expect(request.transportIdentity.tlsExporter).toEqual(exporter);
      await expect(h.service.execute(request)).rejects.toMatchObject({ code: "REMOTE_WORKER_MESH_CAPABILITY_REJECTED" });
    }
    for (const method of [...Object.values(h.owners.publication), ...Object.values(h.owners.invocation)]) {
      expect(method).toHaveBeenCalledOnce();
      expect(method.mock.calls[0]?.[0]).toEqual({ workspaceId: "workspace-a", nodeId: "node-a", admissionGeneration: 1,
        mtlsRequired: true, tlsFingerprint: h.authority.clientCertificateSha256, provenance: "remote_worker", remoteWorkerAuthorityFence: h.fence });
    }
    expect(h.consume).toHaveBeenCalledTimes(12);
  });

  it.each(["target", "action", "node", "workspace", "certificate", "exporter", "generation", "proof", "legacy", "capability"])(
    "rejects %s drift before reaching a mesh owner", async (drift) => {
      const h = harness(); const request = h.signed();
      if (drift === "target") request.rawPath += "?workspaceId=other";
      if (drift === "action") request.body.payload.action = "publications";
      if (drift === "node") Object.assign(request.body.payload, { nodeId: "other-node" });
      if (drift === "workspace") request.body.payload.workspaceId = "other-workspace";
      if (drift === "certificate") request.transportIdentity.certificateDerSha256 = digest("foreign-certificate");
      if (drift === "exporter") request.transportIdentity.tlsExporter.fill(0);
      if (drift === "generation") request.body.workerGeneration += 1;
      if (drift === "proof") request.headers["x-goatcitadel-worker-proof"] = randomBytes(64).toString("base64url");
      if (drift === "legacy") Object.assign(request.body, { schemaVersion: "goatcitadel.remote-worker-pop.v1" });
      if (drift === "capability") {
        const claims = buildRemoteWorkerRuntimeCredentialClaims({ registryWorkspaceId: "registry-a", workerId: "worker-a",
          workerGeneration: 2, allowedWorkspaceIds: ["registry-a", "workspace-a"], capabilityClasses: ["durable_compute"] });
        Object.assign(h.authority, { claims, capabilityCeilingSha256: claims.capabilityCeilingSha256,
          claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims) });
      }
      await expect(h.service.execute(request)).rejects.toMatchObject({ code: "REMOTE_WORKER_MESH_CAPABILITY_REJECTED" });
      expect(h.owners.invocation.listPendingInvocations).not.toHaveBeenCalled();
      expect(h.owners.publication.listOwnPublications).not.toHaveBeenCalled();
    },
  );

  it("freezes inputs before credential resolution and withholds read results after admission changes", async () => {
    const h = harness(); const request = h.signed();
    h.resolved.mockImplementationOnce(async () => {
      request.body.payload.workspaceId = "other-workspace";
      request.transportIdentity.tlsExporter.fill(0);
      return h.authority;
    });
    await expect(h.service.execute(request)).resolves.toMatchObject({ action: "pending", workspaceId: "workspace-a" });
    h.mesh.mockResolvedValueOnce(h.fence).mockResolvedValueOnce(undefined as never);
    await expect(h.service.execute(h.signed({ action: "input", invocationId: "invoke-a" }))).rejects.toThrow();
    expect(h.owners.invocation.readInvocationInput).toHaveBeenCalledOnce();
    h.mesh.mockResolvedValueOnce({ ...h.fence, credentialGeneration: 4 });
    await expect(h.service.execute(h.signed())).rejects.toThrow();
    expect(h.owners.invocation.listPendingInvocations).toHaveBeenCalledOnce();
  });

  it("rejects accessors, missing owners and unknown actions with bounded handler errors", async () => {
    const h = harness();
    const accessor = vi.fn(() => h.signed().headers);
    const request = Object.defineProperty(h.signed(), "headers", { get: accessor, enumerable: true });
    await expect(h.service.execute(request)).rejects.toThrow();
    expect(accessor).not.toHaveBeenCalled();
    await expect(h.service.execute(h.signed({ action: "activate", approvalId: "pretend-approval" }))).rejects.toThrow();
    const handler = createRemoteWorkerMeshCapabilityNativeRequestHandler(h.service);
    const signed = h.signed();
    const invalid = await handler({ ...signed, method: "POST", bodyBytes: Buffer.from([0xff, 0xff]) });
    expect(invalid).toMatchObject({ statusCode: 400, body: canonicalJsonString({ error: "REMOTE_WORKER_REQUEST_INVALID" }) });
    Object.assign(h.owners.invocation, { settleFromNode: undefined });
    await expect(h.service.assertAvailable()).rejects.toThrow();
  });

  it.runIf(process.platform === "win32")("crosses real native mTLS with the worker client and rejects a changed response scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gc-native-mesh-wire-"));
    let listener: Awaited<ReturnType<typeof startRemoteWorkerNativeTlsListener>> | undefined;
    try {
      const tls = await tlsConfig(root);
      const [certificatePem, keyPem, caPem] = await Promise.all([tls.paths.clientCert, tls.paths.clientKey, tls.paths.ca].map((file) => readFile(file, "utf8")));
      const h = harness({ key: createPrivateKey(keyPem!), certificate: new X509Certificate(certificatePem!), ca: new X509Certificate(caPem!) });
      const nodeId = "node-" + "a".repeat(251);
      h.authority.nodeId = nodeId;
      h.fence.nodeId = nodeId;
      listener = await startRemoteWorkerNativeTlsListener(tls.config, createRemoteWorkerMeshCapabilityNativeRequestHandler(h.service));
      const client = new WorkerWireClient({ host: "127.0.0.1", port: portOf(listener.address),
        clientCertificatePem: certificatePem!, clientPrivateKeyPem: keyPem!, trustAnchorPem: caPem! });
      const call = { client, credential: { credentialId: "credential-a", credentialGeneration: 3, workerGeneration: 2,
        registryWorkspaceId: "registry-a", authorizationCredential: h.credential, clientCertificateSha256: h.authority.clientCertificateSha256,
        workerPublicKeySpkiSha256: h.authority.publicKeySpkiSha256, signingPrivateKeyPem: keyPem! },
        expectedNodeId: nodeId, idempotencyKey: "native:pending", payload: { schemaVersion: SCHEMA, workspaceId: "workspace-a", action: "pending" as const } };
      await expect(exchangeWorkerMeshCapability({ ...call, expectedNodeId: nodeId + "a" })).rejects.toThrow("identity is unavailable");
      await expect(exchangeWorkerMeshCapability(call)).resolves.toMatchObject({ action: "pending", result: { items: [] } });
      await expect(exchangeWorkerMeshCapability({ ...call, expectedNodeId: "other-node" })).rejects.toThrow("response does not match");
      expect(h.owners.invocation.listPendingInvocations).toHaveBeenCalledTimes(2);
      expect(h.consume).toHaveBeenCalledTimes(2);
    } finally {
      await listener?.close();
      expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
      expect(path.basename(root)).toMatch(/^gc-native-mesh-wire-/u);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
