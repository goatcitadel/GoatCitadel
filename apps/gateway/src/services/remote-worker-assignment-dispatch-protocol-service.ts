/* eslint-disable max-lines -- Keep the production-dark routes 8-10 authentication, replay, and dispatch boundary auditable. */
import { createHash, timingSafeEqual } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type {
  ClaimRemoteWorkerAssignmentOfferOutcome,
  RemoteWorkerAssignmentOffer,
  RemoteWorkerAssignmentOfferCursor,
  RemoteWorkerAssignmentWorkloadProjection,
} from "@goatcitadel/storage";
import type {
  CurrentRemoteWorkerRuntimeCredentialAuthority,
  RemoteWorkerCurrentRuntimeCredentialAuthorityPort,
} from "./remote-worker-current-authority-service.js";
import {
  REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES,
  snapshotRemoteWorkerAssignmentDispatchAuthority,
  type RemoteWorkerAssignmentDispatchService,
} from "./remote-worker-assignment-dispatch-service.js";
import {
  REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES,
  consumeRemoteWorkerDurableNonce,
  normalizeRemoteWorkerProtocolBody,
  prepareRemoteWorkerProofOfPossession,
  snapshotRemoteWorkerDurableNonceConsumption,
  type RemoteWorkerDurableNonceConsumePort,
  type RemoteWorkerProtocolBody,
  type RemoteWorkerResolvedAuthority,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

export const REMOTE_WORKER_ASSIGNMENT_DISPATCH_RESPONSE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-dispatch-response.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_OFFER_POLL_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-offer-poll.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_CLAIM_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-claim.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_WORKLOAD_READ_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-workload-read.v1" as const;

type RemoteWorkerAssignmentDispatchRoute =
  (typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES];

export interface RemoteWorkerAssignmentDispatchProtocolRequest {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export interface RemoteWorkerAssignmentDispatchProtocolPort {
  execute(
    input: RemoteWorkerAssignmentDispatchProtocolRequest,
  ): Promise<RemoteWorkerAssignmentDispatchProtocolResponse>;
}

export interface RemoteWorkerAssignmentDispatchProtocolDependencies {
  readonly credentialAuthority: RemoteWorkerCurrentRuntimeCredentialAuthorityPort;
  readonly nonceConsumer: RemoteWorkerDurableNonceConsumePort;
  readonly dispatch: Pick<
    RemoteWorkerAssignmentDispatchService,
    "listOffers" | "claimOffer" | "readWorkload"
  >;
  readonly clock: () => Date;
}

type ResponseBase = Readonly<{
  schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_RESPONSE_SCHEMA_VERSION;
  operation: RemoteWorkerAssignmentDispatchRoute["operation"];
  registryWorkspaceId: string;
}>;

type SecretFreeClaimOutcome = Readonly<{
  disposition: ClaimRemoteWorkerAssignmentOfferOutcome["disposition"];
  assignment: ClaimRemoteWorkerAssignmentOfferOutcome["assignment"];
  generation: Omit<
    ClaimRemoteWorkerAssignmentOfferOutcome["generation"],
    "idempotencyKey" | "requestSha256"
  >;
  lease: Omit<ClaimRemoteWorkerAssignmentOfferOutcome["lease"], "idempotencyKey" | "requestSha256">;
  workload: ClaimRemoteWorkerAssignmentOfferOutcome["workload"];
}>;

export type RemoteWorkerAssignmentDispatchProtocolResponse =
  | (ResponseBase &
      Readonly<{
        disposition: "listed";
        items: readonly RemoteWorkerAssignmentOffer[];
        nextCursor?: RemoteWorkerAssignmentOfferCursor;
      }>)
  | (ResponseBase & SecretFreeClaimOutcome)
  | (ResponseBase &
      Readonly<{
        disposition: "available";
        workload: RemoteWorkerAssignmentWorkloadProjection;
      }>);

interface PollPayload {
  readonly kind: "poll";
  readonly registryWorkspaceId: string;
  readonly limit?: number;
  readonly cursor?: RemoteWorkerAssignmentOfferCursor;
}

interface ClaimPayload {
  readonly kind: "claim";
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly rawLeaseToken: string;
}

interface WorkloadPayload {
  readonly kind: "workload";
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly rawLeaseToken: string;
}

type NormalizedPayload = PollPayload | ClaimPayload | WorkloadPayload;

interface SnapshotRequest {
  readonly method: "POST";
  readonly rawPath: RemoteWorkerAssignmentDispatchRoute["rawPath"];
  readonly route: RemoteWorkerAssignmentDispatchRoute;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: RemoteWorkerProtocolBody;
  readonly payload: NormalizedPayload;
  readonly credentialTokenSha256: string;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export class RemoteWorkerAssignmentDispatchProtocolError extends Error {
  public readonly code = "REMOTE_WORKER_ASSIGNMENT_DISPATCH_PROTOCOL_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerAssignmentDispatchProtocolError";
  }
}

/**
 * Production-dark protected-v2 wire owner for route codes 8-10. It resolves
 * the canonical M2 credential/protected authority before PoP, consumes the
 * durable nonce before any assignment outcome is observed, then delegates to
 * the task-bound Chat dispatch owner whose storage calls recheck the complete
 * M2/M3/assignment fence at the read or mutation boundary. A response-loss
 * retry must use the same canonical request and idempotency key with a fresh
 * signed nonce; claim storage returns the secret-free canonical replay.
 */
export class RemoteWorkerAssignmentDispatchProtocolService
  implements RemoteWorkerAssignmentDispatchProtocolPort
{
  public constructor(private readonly dependencies: RemoteWorkerAssignmentDispatchProtocolDependencies) {
    if (typeof dependencies.clock !== "function") throw rejected("Remote worker dispatch clock is unavailable.");
  }

  public async execute(
    input: RemoteWorkerAssignmentDispatchProtocolRequest,
  ): Promise<RemoteWorkerAssignmentDispatchProtocolResponse> {
    let request: SnapshotRequest | undefined;
    try {
      request = snapshotRequest(input);
      const now = snapshotClock(this.dependencies.clock());
      const resolved = await this.dependencies.credentialAuthority.resolveByCredentialTokenSha256(
        request.credentialTokenSha256,
      );
      if (resolved === undefined) throw rejected("Remote worker dispatch credential authority is unavailable.");
      const authority = snapshotRemoteWorkerAssignmentDispatchAuthority(resolved);
      if (!safeDigestEqual(authority.current.authorizationCredentialSha256, request.credentialTokenSha256)) {
        throw rejected("Remote worker dispatch credential authority is inconsistent.");
      }
      assertTransportAuthorityBinding(authority.current, request.transportIdentity);
      const protocolAuthority: RemoteWorkerResolvedAuthority = Object.freeze({
        kind: "credential",
        authorityId: authority.current.credentialId,
        authorityGeneration: authority.current.credentialGeneration,
        workerGeneration: authority.current.workerGeneration,
        authorizationCredentialSha256: authority.current.authorizationCredentialSha256,
        publicKeySpkiDer: Buffer.from(authority.current.publicKeySpkiDer),
        publicKeySpkiSha256: authority.current.publicKeySpkiSha256,
      });
      const prepared = prepareRemoteWorkerProofOfPossession({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body: request.body,
        expectedOperation: request.route.operation,
        authority: protocolAuthority,
        proofRequirement: "protected_v2_required",
        transportIdentity: request.transportIdentity,
        now,
      });
      if (
        canonicalJsonString(prepared.body) !== canonicalJsonString(request.body) ||
        request.payload.registryWorkspaceId !== authority.current.registryWorkspaceId
      ) {
        throw rejected("Remote worker dispatch request authority is inconsistent.");
      }
      const nonce = snapshotRemoteWorkerDurableNonceConsumption({
        authority: Object.freeze({
          kind: "credential",
          registryWorkspaceId: authority.current.registryWorkspaceId,
          workerId: authority.current.workerId,
          workerGeneration: authority.current.workerGeneration,
          credentialGeneration: authority.current.credentialGeneration,
          credentialId: authority.current.credentialId,
        }),
        nonce: prepared.nonce.nonce,
        timestamp: prepared.nonce.timestamp,
        authorityId: prepared.nonce.authorityId,
        authorityGeneration: prepared.nonce.authorityGeneration,
      });
      let consumed: boolean;
      try {
        consumed = await consumeRemoteWorkerDurableNonce(this.dependencies.nonceConsumer, nonce);
      } catch {
        throw rejected("Remote worker dispatch replay protection is unavailable.");
      }
      if (!consumed) throw rejected("Remote worker dispatch request nonce was already consumed.");
      return await this.executeAuthorized(request.route, request.body.idempotencyKey, request.payload, authority.current);
    } catch (error) {
      if (error instanceof RemoteWorkerAssignmentDispatchProtocolError) throw error;
      throw rejected("Remote worker assignment dispatch could not be completed.");
    } finally {
      request?.transportIdentity.tlsExporter.fill(0);
    }
  }

  private async executeAuthorized(
    route: RemoteWorkerAssignmentDispatchRoute,
    idempotencyKey: string,
    payload: NormalizedPayload,
    authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentDispatchProtocolResponse> {
    if (payload.kind === "poll" && route.code === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers.code) {
      const listed = await this.dependencies.dispatch.listOffers({
        authority,
        ...(payload.limit === undefined ? {} : { limit: payload.limit }),
        ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      });
      return responseSnapshot({
        ...responseBase(route, authority.registryWorkspaceId),
        disposition: "listed",
        items: listed.items,
        ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
      });
    }
    if (payload.kind === "claim" && route.code === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim.code) {
      const outcome = await this.dependencies.dispatch.claimOffer({
        authority,
        assignmentId: payload.assignmentId,
        rawLeaseToken: payload.rawLeaseToken,
        idempotencyKey,
      });
      return responseSnapshot({
        ...responseBase(route, authority.registryWorkspaceId),
        ...secretFreeClaimOutcome(outcome),
      });
    }
    if (payload.kind === "workload" && route.code === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.readWorkload.code) {
      const workload = await this.dependencies.dispatch.readWorkload({
        authority,
        assignmentId: payload.assignmentId,
        expectedAssignmentGeneration: payload.expectedAssignmentGeneration,
        expectedLeaseRevision: payload.expectedLeaseRevision,
        rawLeaseToken: payload.rawLeaseToken,
      });
      if (workload === undefined) throw rejected("Remote worker assignment workload is unavailable.");
      return responseSnapshot({
        ...responseBase(route, authority.registryWorkspaceId),
        disposition: "available",
        workload,
      });
    }
    throw rejected("Remote worker assignment dispatch route and payload disagree.");
  }
}

function secretFreeClaimOutcome(
  outcome: ClaimRemoteWorkerAssignmentOfferOutcome,
): SecretFreeClaimOutcome {
  const { idempotencyKey: _generationIdempotencyKey, requestSha256: _generationRequestSha256, ...generation } =
    outcome.generation;
  const { idempotencyKey: _leaseIdempotencyKey, requestSha256: _leaseRequestSha256, ...lease } = outcome.lease;
  return Object.freeze({
    disposition: outcome.disposition,
    assignment: outcome.assignment,
    generation: Object.freeze(generation),
    lease: Object.freeze(lease),
    workload: outcome.workload,
  });
}

function snapshotRequest(value: unknown): SnapshotRequest {
  const fields = exactOwnDataFields(
    value,
    ["method", "rawPath", "headers", "body", "transportIdentity"],
    [],
    "dispatch protocol input",
  );
  if (fields.method !== "POST" || typeof fields.rawPath !== "string") {
    throw rejected("Remote worker assignment dispatch target is invalid.");
  }
  const route = routeForPath(fields.rawPath);
  const headers = snapshotHeaders(fields.headers);
  const body = normalizeRemoteWorkerProtocolBody(fields.body);
  if (body.operation !== route.operation) {
    throw rejected("Remote worker assignment dispatch operation is invalid.");
  }
  return Object.freeze({
    method: "POST",
    rawPath: route.rawPath,
    route,
    headers,
    body,
    payload: normalizePayload(route, body.payload),
    credentialTokenSha256: credentialAuthorizationSha256(headers),
    transportIdentity: snapshotTransportIdentity(fields.transportIdentity),
  });
}

function routeForPath(rawPath: string): RemoteWorkerAssignmentDispatchRoute {
  const route = Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES).find(
    (candidate) => candidate.rawPath === rawPath,
  );
  if (route === undefined) throw rejected("Remote worker assignment dispatch route is unavailable.");
  return route;
}

function normalizePayload(route: RemoteWorkerAssignmentDispatchRoute, value: unknown): NormalizedPayload {
  if (route.code === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers.code) return normalizePollPayload(value);
  if (route.code === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim.code) return normalizeClaimPayload(value);
  return normalizeWorkloadPayload(value);
}

function normalizePollPayload(value: unknown): PollPayload {
  const fields = exactOwnDataFields(
    value,
    ["schemaVersion", "registryWorkspaceId"],
    ["limit", "cursor"],
    "offer poll payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_OFFER_POLL_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment offer poll schema is invalid.");
  }
  return Object.freeze({
    kind: "poll",
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    ...(fields.limit === undefined ? {} : { limit: positiveInteger(fields.limit, "limit", 100) }),
    ...(fields.cursor === undefined ? {} : { cursor: normalizeCursor(fields.cursor) }),
  });
}

function normalizeClaimPayload(value: unknown): ClaimPayload {
  const fields = exactOwnDataFields(
    value,
    ["schemaVersion", "registryWorkspaceId", "assignmentId", "leaseToken"],
    [],
    "assignment claim payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_CLAIM_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment claim schema is invalid.");
  }
  return Object.freeze({
    kind: "claim",
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    rawLeaseToken: canonical32ByteSecret(fields.leaseToken, "leaseToken"),
  });
}

function normalizeWorkloadPayload(value: unknown): WorkloadPayload {
  const fields = exactOwnDataFields(
    value,
    [
      "schemaVersion",
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "leaseRevision",
      "leaseToken",
    ],
    [],
    "assignment workload payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_WORKLOAD_READ_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment workload schema is invalid.");
  }
  return Object.freeze({
    kind: "workload",
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(fields.assignmentGeneration, "assignmentGeneration"),
    expectedLeaseRevision: positiveInteger(fields.leaseRevision, "leaseRevision"),
    rawLeaseToken: canonical32ByteSecret(fields.leaseToken, "leaseToken"),
  });
}

function normalizeCursor(value: unknown): RemoteWorkerAssignmentOfferCursor {
  const fields = exactOwnDataFields(value, ["createdAt", "assignmentId"], [], "offer cursor");
  return Object.freeze({
    createdAt: canonicalTimestamp(fields.createdAt, "cursor.createdAt"),
    assignmentId: identifier(fields.assignmentId, "cursor.assignmentId"),
  });
}

function responseBase(route: RemoteWorkerAssignmentDispatchRoute, registryWorkspaceId: string): ResponseBase {
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_DISPATCH_RESPONSE_SCHEMA_VERSION,
    operation: route.operation,
    registryWorkspaceId,
  });
}

function responseSnapshot<T extends RemoteWorkerAssignmentDispatchProtocolResponse>(value: T): T {
  const encoded = canonicalJsonString(value);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) {
    throw rejected("Remote worker assignment dispatch response exceeds its byte limit.");
  }
  return freezeJson(JSON.parse(encoded) as T) as T;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = freezeJson(item);
    return Object.freeze(result);
  }
  return value;
}

function assertTransportAuthorityBinding(
  authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
  transport: RemoteWorkerTransportIdentity,
): void {
  if (
    transport.source !== "native_mtls" ||
    !safeDigestEqual(transport.publicKeySpkiSha256, authority.publicKeySpkiSha256) ||
    !safeDigestEqual(transport.certificateDerSha256, authority.clientCertificateSha256) ||
    !safeDigestEqual(transport.trustAnchorDerSha256, authority.transportTrustAnchorSha256)
  ) {
    throw rejected("Remote worker assignment dispatch mutual TLS authority is invalid.");
  }
}

function credentialAuthorizationSha256(headers: RemoteWorkerRequestHeaders): string {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") throw rejected("Remote worker assignment dispatch authorization is invalid.");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (match === null) throw rejected("Remote worker assignment dispatch authorization is invalid.");
  return createHash("sha256").update(canonical32ByteSecret(match[1], "authorization credential"), "utf8").digest("hex");
}

function snapshotHeaders(value: unknown): RemoteWorkerRequestHeaders {
  assertPlainRecord(value, "request headers");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw rejected("Remote worker assignment dispatch headers are invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 32) throw rejected("Remote worker assignment dispatch headers are invalid.");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, descriptor] of Object.entries(descriptors)) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      name.length < 1 ||
      name.length > 128 ||
      !/^[a-z0-9-]+$/u.test(name) ||
      Object.hasOwn(result, name) ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 8_192 ||
      /[\r\n]/u.test(descriptor.value)
    ) {
      throw rejected("Remote worker assignment dispatch headers are invalid.");
    }
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotTransportIdentity(value: unknown): RemoteWorkerTransportIdentity {
  const fields = exactOwnDataFields(
    value,
    [
      "source",
      "certificateDerSha256",
      "publicKeySpkiSha256",
      "trustAnchorDerSha256",
      "tlsExporterSha256",
      "tlsExporter",
    ],
    [],
    "transport identity",
  );
  if (
    !Buffer.isBuffer(fields.tlsExporter) ||
    nodeUtilTypes.isProxy(fields.tlsExporter) ||
    fields.tlsExporter.byteLength !== 32
  ) {
    throw rejected("Remote worker assignment dispatch TLS exporter is invalid.");
  }
  const snapshot: RemoteWorkerTransportIdentity = Object.freeze({
    source: fields.source as "native_mtls",
    certificateDerSha256: digest(fields.certificateDerSha256, "certificateDerSha256"),
    publicKeySpkiSha256: digest(fields.publicKeySpkiSha256, "publicKeySpkiSha256"),
    trustAnchorDerSha256: digest(fields.trustAnchorDerSha256, "trustAnchorDerSha256"),
    tlsExporterSha256: digest(fields.tlsExporterSha256, "tlsExporterSha256"),
    tlsExporter: Buffer.from(fields.tlsExporter),
  });
  if (
    snapshot.source !== "native_mtls" ||
    !safeDigestEqual(createHash("sha256").update(snapshot.tlsExporter).digest("hex"), snapshot.tlsExporterSha256)
  ) {
    snapshot.tlsExporter.fill(0);
    throw rejected("Remote worker assignment dispatch transport identity is invalid.");
  }
  return snapshot;
}

function exactOwnDataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw rejected(`Remote worker ${label} is invalid.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((name) => !(name in descriptors)) ||
    (keys as string[]).some((name) => !allowed.has(name)) ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) result[key] = descriptors[key]?.value;
  return result;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
}

function identifier(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw rejected(`Remote worker assignment dispatch ${field} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw rejected(`Remote worker assignment dispatch ${field} is invalid.`);
  }
  return value as number;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw rejected(`Remote worker assignment dispatch ${field} is invalid.`);
  }
  return value;
}

function canonical32ByteSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw rejected(`Remote worker assignment dispatch ${field} is invalid.`);
  }
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
      throw rejected(`Remote worker assignment dispatch ${field} is invalid.`);
    }
  } finally {
    decoded.fill(0);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw rejected(`Remote worker assignment dispatch ${field} is invalid.`);
  }
  return value;
}

function snapshotClock(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw rejected("Remote worker assignment dispatch clock is invalid.");
  }
  return new Date(value.getTime());
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rejected(message: string): RemoteWorkerAssignmentDispatchProtocolError {
  return new RemoteWorkerAssignmentDispatchProtocolError(message);
}
