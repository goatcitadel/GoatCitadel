import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  REMOTE_WORKER_MESH_CAPABILITY_OPERATION,
  REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH,
  REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION,
  REMOTE_WORKER_ROUTE_ACCESS_CLASS,
  canonicalJsonString,
  evaluateRemoteWorkerRuntimeCredentialRoutePolicy,
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  remoteWorkerMeshCapabilityPayloadSchema,
  type RemoteWorkerMeshCapabilityPayload,
  type RemoteWorkerMeshCapabilityResponse,
  type RemoteWorkerMeshNodeAuthorityFence,
} from "@goatcitadel/contracts";
import type { MeshCapabilityInvocationService } from "./mesh-capability-invocation-service.js";
import type { MeshCapabilityAuthenticatedNodeIdentity, MeshCapabilityPublicationService } from "./mesh-capability-publication-service.js";
import { snapshotRemoteWorkerAssignmentDispatchAuthority, type RemoteWorkerAssignmentMeshAdmissionPort } from "./remote-worker-assignment-dispatch-service.js";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority, RemoteWorkerCurrentRuntimeCredentialAuthorityPort } from "./remote-worker-current-authority-service.js";
import {
  consumeRemoteWorkerDurableNonce,
  normalizeRemoteWorkerProtocolBody,
  prepareRemoteWorkerProofOfPossession,
  snapshotRemoteWorkerDurableNonceConsumption,
  type RemoteWorkerDurableNonceConsumePort,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

export interface RemoteWorkerMeshCapabilityRequest {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export interface RemoteWorkerMeshCapabilityOwners {
  readonly publication: Pick<MeshCapabilityPublicationService, "publishCapabilityManifest" | "listOwnPublications">;
  readonly invocation: Pick<MeshCapabilityInvocationService, "listPendingInvocations" | "readInvocationInput" | "recordProgress" | "settleFromNode">;
}

export interface RemoteWorkerMeshCapabilityProtocolPort {
  assertAvailable(): Promise<void>;
  execute(input: RemoteWorkerMeshCapabilityRequest): Promise<RemoteWorkerMeshCapabilityResponse>;
}

interface Dependencies extends RemoteWorkerMeshCapabilityOwners {
  readonly credentialAuthority: RemoteWorkerCurrentRuntimeCredentialAuthorityPort;
  readonly meshAdmissions: RemoteWorkerAssignmentMeshAdmissionPort;
  readonly nonceConsumer: RemoteWorkerDurableNonceConsumePort;
  readonly clock: () => Date;
}

export class RemoteWorkerMeshCapabilityProtocolError extends Error {
  public readonly code = "REMOTE_WORKER_MESH_CAPABILITY_REJECTED";
  public constructor() { super("Remote worker mesh capability exchange was rejected."); }
}

/** Fixed route 13. Gateway owners retain publication, activation and invocation authority. */
export class RemoteWorkerMeshCapabilityProtocolService implements RemoteWorkerMeshCapabilityProtocolPort {
  public constructor(private readonly dependencies: Dependencies) {}

  public async assertAvailable(): Promise<void> {
    for (const [owner, methods] of [
      [this.dependencies.credentialAuthority, ["resolveByCredentialTokenSha256"]],
      [this.dependencies.meshAdmissions, ["resolveCurrentForRuntimeCredential"]],
      [this.dependencies.nonceConsumer, ["consume"]],
      [this.dependencies.publication, ["publishCapabilityManifest", "listOwnPublications"]],
      [this.dependencies.invocation, ["listPendingInvocations", "readInvocationInput", "recordProgress", "settleFromNode"]],
    ] as const) {
      for (const method of methods) {
        if (!owner || typeof (owner as unknown as Record<string, unknown>)[method] !== "function") throw rejected();
      }
    }
    if (typeof this.dependencies.clock !== "function") throw rejected();
  }

  public async execute(input: RemoteWorkerMeshCapabilityRequest): Promise<RemoteWorkerMeshCapabilityResponse> {
    let request: ReturnType<typeof snapshotRequest> | undefined;
    try {
      request = snapshotRequest(input);
      const now = this.dependencies.clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw rejected();
      const resolved = await this.dependencies.credentialAuthority.resolveByCredentialTokenSha256(request.credentialSha256);
      if (!resolved) throw rejected();
      const { current: authority } = snapshotRemoteWorkerAssignmentDispatchAuthority(resolved);
      if (authority.authorizationCredentialSha256 !== request.credentialSha256 ||
        authority.clientCertificateSha256 !== request.transportIdentity.certificateDerSha256 ||
        authority.publicKeySpkiSha256 !== request.transportIdentity.publicKeySpkiSha256 ||
        authority.transportTrustAnchorSha256 !== request.transportIdentity.trustAnchorDerSha256) throw rejected();
      const policy = evaluateRemoteWorkerRuntimeCredentialRoutePolicy(authority.claims, {
        routeAccessClass: REMOTE_WORKER_ROUTE_ACCESS_CLASS,
        workspaceId: request.payload.workspaceId,
        requiredCapabilityClasses: ["governed_tool"],
      });
      if (!policy.allowed) throw rejected();
      const prepared = prepareRemoteWorkerProofOfPossession({
        method: "POST", rawPath: REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH, headers: request.headers,
        body: request.body, expectedOperation: REMOTE_WORKER_MESH_CAPABILITY_OPERATION,
        proofRequirement: "protected_v2_required", transportIdentity: request.transportIdentity, now,
        authority: {
          kind: "credential", authorityId: authority.credentialId, authorityGeneration: authority.credentialGeneration,
          workerGeneration: authority.workerGeneration, authorizationCredentialSha256: authority.authorizationCredentialSha256,
          publicKeySpkiDer: authority.publicKeySpkiDer, publicKeySpkiSha256: authority.publicKeySpkiSha256,
        },
      });
      const nonce = snapshotRemoteWorkerDurableNonceConsumption({
        authority: {
          kind: "credential", registryWorkspaceId: authority.registryWorkspaceId, workerId: authority.workerId,
          workerGeneration: authority.workerGeneration, credentialId: authority.credentialId,
          credentialGeneration: authority.credentialGeneration,
        },
        ...prepared.nonce,
      });
      if (!await consumeRemoteWorkerDurableNonce(this.dependencies.nonceConsumer, nonce)) throw rejected();
      const fence = await this.resolveMeshAuthority(authority, request.payload.workspaceId);
      const identity: MeshCapabilityAuthenticatedNodeIdentity = Object.freeze({
        workspaceId: fence.workspaceId, nodeId: fence.nodeId, admissionGeneration: fence.admissionGeneration,
        mtlsRequired: true, tlsFingerprint: authority.clientCertificateSha256,
        provenance: "remote_worker", remoteWorkerAuthorityFence: fence,
      });
      const response = await this.executeAction(identity, request.payload);
      if (["pending", "publications", "input"].includes(request.payload.action) &&
        canonicalJsonString(await this.resolveMeshAuthority(authority, request.payload.workspaceId)) !== canonicalJsonString(fence)) {
        throw rejected();
      }
      return response;
    } catch {
      throw rejected();
    } finally {
      request?.transportIdentity.tlsExporter.fill(0);
    }
  }

  private async resolveMeshAuthority(
    authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
    workspaceId: string,
  ): Promise<RemoteWorkerMeshNodeAuthorityFence> {
    const expected = {
      registryWorkspaceId: authority.registryWorkspaceId, bootstrapId: authority.bootstrapId,
      workerId: authority.workerId, workerGeneration: authority.workerGeneration,
      credentialId: authority.credentialId, credentialGeneration: authority.credentialGeneration,
      workspaceId, nodeId: authority.nodeId,
      protectedAdmissionEnvelopeSha256: authority.protectedAdmissionEnvelopeSha256,
      protectedAdmissionContextSha256: authority.protectedAdmissionContextSha256,
    };
    const resolved = await this.dependencies.meshAdmissions.resolveCurrentForRuntimeCredential({
      ...expected, clientCertificateSha256: authority.clientCertificateSha256,
      authorizationCredentialSha256: authority.authorizationCredentialSha256,
    });
    if (!resolved) throw rejected();
    const fence = normalizeRemoteWorkerMeshNodeAuthorityFence(resolved);
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (fence[key] !== expected[key]) throw rejected();
    }
    return fence;
  }

  private async executeAction(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    payload: RemoteWorkerMeshCapabilityPayload,
  ): Promise<RemoteWorkerMeshCapabilityResponse> {
    const base = {
      schemaVersion: REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION, operation: REMOTE_WORKER_MESH_CAPABILITY_OPERATION,
      workspaceId: identity.workspaceId, nodeId: identity.nodeId,
    };
    const { publication, invocation } = this.dependencies;
    switch (payload.action) {
      case "publish": return { ...base, action: payload.action, result: await publication.publishCapabilityManifest(identity, payload.submission) };
      case "publications": return { ...base, action: payload.action, result: await publication.listOwnPublications(identity) };
      case "pending": return { ...base, action: payload.action, result: await invocation.listPendingInvocations(identity) };
      case "input": return { ...base, action: payload.action, result: await invocation.readInvocationInput(identity, payload.invocationId) };
      case "progress": return { ...base, action: payload.action, result: await invocation.recordProgress(identity, payload.submission) };
      case "settle": return { ...base, action: payload.action, result: await invocation.settleFromNode(identity, payload.submission) };
    }
  }
}

function snapshotRequest(input: unknown) {
  const fields = dataFields(input, ["method", "rawPath", "headers", "body", "transportIdentity"]);
  if (fields.method !== "POST" || fields.rawPath !== REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH) throw rejected();
  const headerFields = dataFields(fields.headers);
  if (Object.keys(headerFields).length > 32) throw rejected();
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headerFields)) {
    if (!/^[a-z0-9-]{1,128}$/u.test(name) || typeof value !== "string" || value.length > 8192 || /[\r\n]/u.test(value)) throw rejected();
    headers[name] = value;
  }
  if (headers["x-goatcitadel-mesh-node-join-credential"] !== undefined) throw rejected();
  const credential = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(headers.authorization ?? "")?.[1];
  if (!credential || Buffer.from(credential, "base64url").toString("base64url") !== credential) throw rejected();
  const body = normalizeRemoteWorkerProtocolBody(fields.body);
  if (body.operation !== REMOTE_WORKER_MESH_CAPABILITY_OPERATION) throw rejected();
  const payload = remoteWorkerMeshCapabilityPayloadSchema.parse(body.payload);
  const transport = dataFields(fields.transportIdentity, ["source", "certificateDerSha256", "publicKeySpkiSha256",
    "trustAnchorDerSha256", "tlsExporterSha256", "tlsExporter"]);
  if (transport.source !== "native_mtls" || types.isProxy(transport.tlsExporter) || !Buffer.isBuffer(transport.tlsExporter) ||
    transport.tlsExporter.byteLength !== 32) throw rejected();
  for (const key of ["certificateDerSha256", "publicKeySpkiSha256", "trustAnchorDerSha256", "tlsExporterSha256"]) {
    if (typeof transport[key] !== "string" || !/^[a-f0-9]{64}$/u.test(transport[key])) throw rejected();
  }
  if (createHash("sha256").update(transport.tlsExporter).digest("hex") !== transport.tlsExporterSha256) throw rejected();
  const transportIdentity: RemoteWorkerTransportIdentity = Object.freeze({
    source: "native_mtls", certificateDerSha256: transport.certificateDerSha256 as string,
    publicKeySpkiSha256: transport.publicKeySpkiSha256 as string, trustAnchorDerSha256: transport.trustAnchorDerSha256 as string,
    tlsExporterSha256: transport.tlsExporterSha256 as string, tlsExporter: Buffer.from(transport.tlsExporter),
  });
  return Object.freeze({ body, payload, headers: Object.freeze(headers), transportIdentity,
    credentialSha256: createHash("sha256").update(credential).digest("hex") });
}

function dataFields(input: unknown, expected?: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw rejected();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((field) => !field.enumerable || !Object.hasOwn(field, "value")) ||
    (expected && (Object.keys(descriptors).length !== expected.length || expected.some((key) => !Object.hasOwn(descriptors, key))))) throw rejected();
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
}

function rejected(): RemoteWorkerMeshCapabilityProtocolError { return new RemoteWorkerMeshCapabilityProtocolError(); }
