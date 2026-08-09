/* eslint-disable max-lines -- Keep the production-dark authentication, exact payload, and assignment-fence boundary auditable in one file. */
import { createHash, timingSafeEqual } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  REMOTE_WORKER_ROUTE_ACCESS_CLASS,
  assertRemoteWorkerAssignmentControlRecord,
  assertRemoteWorkerAssignmentGenerationRecord,
  assertRemoteWorkerAssignmentLeaseRecord,
  assertRemoteWorkerAssignmentRecord,
  assertRemoteWorkerAssignmentSettlementRecord,
  assertRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  evaluateRemoteWorkerRuntimeCredentialRoutePolicy,
  normalizeAppendRemoteWorkerAssignmentEventsCommand,
  normalizeRenewRemoteWorkerAssignmentLeaseCommand,
  normalizeSettleRemoteWorkerAssignmentCommand,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type AppendRemoteWorkerAssignmentEventsCommand,
  type RemoteWorkerAssignmentAppendOutcome,
  type RemoteWorkerAssignmentControlRecord,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentLeaseRecord,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerAssignmentSettlementOutcome,
  type RemoteWorkerAssignmentSettlementRecord,
  type RemoteWorkerRuntimeCredentialClaims,
  type RenewRemoteWorkerAssignmentLeaseCommand,
  type ResolvedRemoteWorkerAssignmentAuthority,
  type SettleRemoteWorkerAssignmentWorkerCommand,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerAssignmentAggregate,
  RenewRemoteWorkerAssignmentLeaseOutcome,
  ResolveRemoteWorkerAssignmentControlReadInput,
  ResolvedRemoteWorkerAssignmentControlReadAuthority,
  SettleRemoteWorkerAssignmentOutcome,
} from "@goatcitadel/storage";
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

export const REMOTE_WORKER_ASSIGNMENT_RPC_RESPONSE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-rpc-response.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION = "goatcitadel.remote-worker-assignment-sync.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_LEASE_RENEWAL_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-lease-renewal.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-event-append.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_CONTROL_READ_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-control-read.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_WORKER_SETTLEMENT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-worker-settlement.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_RPC_MAX_PAYLOAD_BYTES = 256 * 1024;

export const REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES = Object.freeze({
  sync: Object.freeze({
    operation: "assignment.sync",
    rawPath: "/api/v1/remote-workers/assignment-syncs",
  }),
  renewLease: Object.freeze({
    operation: "assignment.lease.renew",
    rawPath: "/api/v1/remote-workers/assignment-lease-renewals",
  }),
  appendEvents: Object.freeze({
    operation: "assignment.events.append",
    rawPath: "/api/v1/remote-workers/assignment-event-batches",
  }),
  readControl: Object.freeze({
    operation: "assignment.control.read",
    rawPath: "/api/v1/remote-workers/assignment-control-reads",
  }),
  settle: Object.freeze({
    operation: "assignment.settle",
    rawPath: "/api/v1/remote-workers/assignment-settlements",
  }),
} as const);

type RemoteWorkerAssignmentRpcRoute =
  (typeof REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES];

/**
 * Current, non-revoked runtime credential authority joined with the canonical
 * admitted-key evidence and current node-admission generation. Production
 * composition must obtain `publicKeySpkiDer` from M2's protected-evidence
 * owner; this service is not a key owner and persists none of these fields.
 */
export interface RemoteWorkerAssignmentRuntimeCredentialAuthority {
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly authorizationCredentialSha256: string;
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly nodeAdmissionGeneration: number;
  readonly publicKeySpkiDer: Buffer;
  readonly publicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly runtimeManifestSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly claims: RemoteWorkerRuntimeCredentialClaims;
  readonly claimsSha256: string;
}

export interface RemoteWorkerAssignmentRuntimeCredentialAuthorityPort {
  /**
   * Resolve only the latest fresh credential of the latest healthy worker
   * generation. A production implementation must revalidate the M2 evidence
   * signature/key pin and current revoke, quarantine, and mesh node-admission
   * state; a raw protected-evidence row is not sufficient authority.
   */
  resolveByCredentialTokenSha256(
    credentialTokenSha256: string,
  ):
    | RemoteWorkerAssignmentRuntimeCredentialAuthority
    | undefined
    | Promise<RemoteWorkerAssignmentRuntimeCredentialAuthority | undefined>;
}

export interface RemoteWorkerAssignmentProtocolStorePort {
  resolveActiveAuthorityByLeaseTokenHash(
    leaseTokenSha256: string,
  ): ResolvedRemoteWorkerAssignmentAuthority | undefined | Promise<ResolvedRemoteWorkerAssignmentAuthority | undefined>;
  resolveControlReadAuthorityByLeaseTokenHash(
    input: ResolveRemoteWorkerAssignmentControlReadInput,
  ):
    | ResolvedRemoteWorkerAssignmentControlReadAuthority
    | undefined
    | Promise<ResolvedRemoteWorkerAssignmentControlReadAuthority | undefined>;
  findAssignmentAggregate(
    registryWorkspaceId: string,
    assignmentId: string,
  ): RemoteWorkerAssignmentAggregate | undefined | Promise<RemoteWorkerAssignmentAggregate | undefined>;
  renewLease(
    input: RenewRemoteWorkerAssignmentLeaseCommand,
  ): RenewRemoteWorkerAssignmentLeaseOutcome | Promise<RenewRemoteWorkerAssignmentLeaseOutcome>;
  appendEvents(
    input: AppendRemoteWorkerAssignmentEventsCommand,
  ): RemoteWorkerAssignmentAppendOutcome | Promise<RemoteWorkerAssignmentAppendOutcome>;
  settleAssignment(
    input: SettleRemoteWorkerAssignmentWorkerCommand,
  ): SettleRemoteWorkerAssignmentOutcome | Promise<SettleRemoteWorkerAssignmentOutcome>;
}

export interface RemoteWorkerAssignmentProtocolRequest {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export interface RemoteWorkerAssignmentProtocolServiceDependencies {
  readonly credentialAuthority: RemoteWorkerAssignmentRuntimeCredentialAuthorityPort;
  readonly nonceConsumer: RemoteWorkerDurableNonceConsumePort;
  readonly assignments: RemoteWorkerAssignmentProtocolStorePort;
  readonly clock: () => Date;
}

type BaseResponse = Readonly<{
  schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_RPC_RESPONSE_SCHEMA_VERSION;
  operation: RemoteWorkerAssignmentRpcRoute["operation"];
}>;

export type RemoteWorkerAssignmentProtocolResponse =
  | (BaseResponse &
      Readonly<{
        disposition: "synchronized";
        assignment: RemoteWorkerAssignmentRecord;
        generation: RemoteWorkerAssignmentGenerationRecord;
        lease: RemoteWorkerAssignmentLeaseRecord;
      }>)
  | (BaseResponse &
      Readonly<{
        disposition: RenewRemoteWorkerAssignmentLeaseOutcome["disposition"];
        lease: RemoteWorkerAssignmentLeaseRecord;
      }>)
  | (BaseResponse &
      Readonly<{
        disposition: RemoteWorkerAssignmentAppendOutcome["disposition"];
        acknowledgedThrough: number;
        workerSentThrough: number;
        pendingCount: number;
        flowControl: RemoteWorkerAssignmentAppendOutcome["flowControl"];
      }>)
  | (BaseResponse &
      Readonly<{
        disposition: ResolvedRemoteWorkerAssignmentControlReadAuthority["disposition"];
        assignmentId: string;
        assignmentGeneration: number;
        lease: RemoteWorkerAssignmentLeaseRecord;
        control?: RemoteWorkerAssignmentControlRecord;
      }>)
  | (BaseResponse &
      Readonly<{
        disposition: SettleRemoteWorkerAssignmentOutcome["disposition"];
        settlement: RemoteWorkerAssignmentSettlementRecord;
      }>);

interface CommonAssignmentPayload {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly leaseTokenSha256: string;
}

type NormalizedRpcPayload =
  | Readonly<{ kind: "sync"; command: CommonAssignmentPayload }>
  | Readonly<{ kind: "renewLease"; command: RenewRemoteWorkerAssignmentLeaseCommand }>
  | Readonly<{ kind: "appendEvents"; command: AppendRemoteWorkerAssignmentEventsCommand }>
  | Readonly<{ kind: "readControl"; command: CommonAssignmentPayload }>
  | Readonly<{ kind: "settle"; command: SettleRemoteWorkerAssignmentWorkerCommand }>;

interface SnapshotRequest {
  readonly method: "POST";
  readonly rawPath: string;
  readonly route: RemoteWorkerAssignmentRpcRoute;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: RemoteWorkerProtocolBody;
  readonly payload: NormalizedRpcPayload;
  readonly credentialTokenSha256: string;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export class RemoteWorkerAssignmentProtocolError extends Error {
  readonly code = "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerAssignmentProtocolError";
  }
}

export class RemoteWorkerAssignmentProtocolService {
  public constructor(private readonly dependencies: RemoteWorkerAssignmentProtocolServiceDependencies) {
    if (typeof dependencies.clock !== "function") throw rejected("Remote worker assignment RPC clock is unavailable.");
  }

  public async execute(input: RemoteWorkerAssignmentProtocolRequest): Promise<RemoteWorkerAssignmentProtocolResponse> {
    let request: SnapshotRequest | undefined;
    try {
      request = snapshotRequest(input);
      const now = snapshotClock(this.dependencies.clock());
      const resolved = await this.dependencies.credentialAuthority.resolveByCredentialTokenSha256(
        request.credentialTokenSha256,
      );
      if (resolved === undefined) throw rejected("Remote worker assignment credential authority is unavailable.");
      const authority = snapshotCredentialAuthority(resolved, request.credentialTokenSha256);
      assertTransportAuthorityBinding(authority, request.transportIdentity);
      const protocolAuthority: RemoteWorkerResolvedAuthority = Object.freeze({
        kind: "credential",
        authorityId: authority.credentialId,
        authorityGeneration: authority.credentialGeneration,
        authorizationCredentialSha256: authority.authorizationCredentialSha256,
        publicKeySpkiDer: authority.publicKeySpkiDer,
        publicKeySpkiSha256: authority.publicKeySpkiSha256,
      });
      const prepared = prepareRemoteWorkerProofOfPossession({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body: request.body,
        expectedOperation: request.route.operation,
        authority: protocolAuthority,
        transportIdentity: request.transportIdentity,
        now,
      });
      const nonce = snapshotRemoteWorkerDurableNonceConsumption({
        authority: Object.freeze({
          kind: "credential",
          registryWorkspaceId: authority.registryWorkspaceId,
          workerId: authority.workerId,
          workerGeneration: authority.workerGeneration,
          credentialGeneration: authority.credentialGeneration,
          credentialId: authority.credentialId,
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
        throw rejected("Remote worker assignment replay protection is unavailable.");
      }
      if (!consumed) throw rejected("Remote worker assignment request nonce was already consumed.");
      return await this.executeAuthorized(request.route, request.payload, authority);
    } catch (error) {
      if (error instanceof RemoteWorkerAssignmentProtocolError) throw error;
      throw rejected("Remote worker assignment RPC could not be completed.");
    } finally {
      request?.transportIdentity.tlsExporter.fill(0);
    }
  }

  private async executeAuthorized(
    route: RemoteWorkerAssignmentRpcRoute,
    payload: NormalizedRpcPayload,
    credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentProtocolResponse> {
    switch (payload.kind) {
      case "sync":
        return await this.sync(route, payload.command, credential);
      case "renewLease":
        return await this.renewLease(route, payload.command, credential);
      case "appendEvents":
        return await this.appendEvents(route, payload.command, credential);
      case "readControl":
        return await this.readControl(route, payload.command, credential);
      case "settle":
        return await this.settle(route, payload.command, credential);
    }
  }

  private async sync(
    route: RemoteWorkerAssignmentRpcRoute,
    command: CommonAssignmentPayload,
    credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentProtocolResponse> {
    const resolved = await this.dependencies.assignments.resolveActiveAuthorityByLeaseTokenHash(
      command.leaseTokenSha256,
    );
    if (resolved === undefined) throw rejected("Remote worker assignment lease authority is unavailable.");
    const records = snapshotResolvedAssignmentAuthority(resolved);
    assertRequestBinding(records, command);
    assertCredentialAssignmentBinding(credential, records.assignment, records.generation);
    return Object.freeze({
      ...responseBase(route),
      disposition: "synchronized",
      ...records,
    });
  }

  private async renewLease(
    route: RemoteWorkerAssignmentRpcRoute,
    command: RenewRemoteWorkerAssignmentLeaseCommand,
    credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentProtocolResponse> {
    const records = await this.resolveMutationRecords(command.registryWorkspaceId, command.assignmentId);
    assertCredentialAssignmentBinding(credential, records.assignment, records.generation);
    assertGenerationBinding(records.generation, command.expectedAssignmentGeneration);
    if (
      records.lease.leaseRevision !== command.expectedLeaseRevision &&
      records.lease.leaseRevision !== command.expectedLeaseRevision + 1
    ) {
      throw rejected("Remote worker assignment lease revision is stale.");
    }
    const outcome = await this.dependencies.assignments.renewLease(command);
    return Object.freeze({
      ...responseBase(route),
      disposition: outcome.disposition,
      lease: snapshotLease(outcome.lease),
    });
  }

  private async appendEvents(
    route: RemoteWorkerAssignmentRpcRoute,
    command: AppendRemoteWorkerAssignmentEventsCommand,
    credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentProtocolResponse> {
    const records = await this.resolveMutationRecords(command.registryWorkspaceId, command.assignmentId);
    assertCredentialAssignmentBinding(credential, records.assignment, records.generation);
    assertGenerationBinding(records.generation, command.expectedAssignmentGeneration);
    if (command.expectedLeaseRevision > records.lease.leaseRevision) {
      throw rejected("Remote worker assignment lease revision is unavailable.");
    }
    const outcome = await this.dependencies.assignments.appendEvents(command);
    return Object.freeze({
      ...responseBase(route),
      disposition: outcome.disposition,
      acknowledgedThrough: outcome.acknowledgedThrough,
      workerSentThrough: outcome.workerSentThrough,
      pendingCount: outcome.pendingCount,
      flowControl: Object.freeze({ ...outcome.flowControl }),
    });
  }

  private async readControl(
    route: RemoteWorkerAssignmentRpcRoute,
    command: CommonAssignmentPayload,
    credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentProtocolResponse> {
    const resolved = await this.dependencies.assignments.resolveControlReadAuthorityByLeaseTokenHash({
      registryWorkspaceId: command.registryWorkspaceId,
      assignmentId: command.assignmentId,
      expectedAssignmentGeneration: command.assignmentGeneration,
      expectedLeaseRevision: command.leaseRevision,
      leaseTokenSha256: command.leaseTokenSha256,
    });
    if (resolved === undefined) throw rejected("Remote worker assignment control authority is unavailable.");
    const records = snapshotControlReadAuthority(resolved);
    assertCredentialAssignmentBinding(credential, records.assignment, records.generation);
    return Object.freeze({
      ...responseBase(route),
      disposition: records.disposition,
      assignmentId: records.assignment.assignmentId,
      assignmentGeneration: records.generation.assignmentGeneration,
      lease: records.lease,
      ...(records.control === undefined ? {} : { control: records.control }),
    });
  }

  private async settle(
    route: RemoteWorkerAssignmentRpcRoute,
    command: SettleRemoteWorkerAssignmentWorkerCommand,
    credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  ): Promise<RemoteWorkerAssignmentProtocolResponse> {
    const records = await this.resolveMutationRecords(command.registryWorkspaceId, command.assignmentId);
    assertCredentialAssignmentBinding(credential, records.assignment, records.generation);
    assertGenerationBinding(records.generation, command.expectedAssignmentGeneration);
    if (command.expectedLeaseRevision > records.lease.leaseRevision) {
      throw rejected("Remote worker assignment lease revision is unavailable.");
    }
    const outcome = await this.dependencies.assignments.settleAssignment(command);
    return Object.freeze({
      ...responseBase(route),
      disposition: outcome.disposition,
      settlement: snapshotSettlement(outcome.settlement),
    });
  }

  private async resolveMutationRecords(
    registryWorkspaceId: string,
    assignmentId: string,
  ): Promise<{
    readonly assignment: RemoteWorkerAssignmentRecord;
    readonly generation: RemoteWorkerAssignmentGenerationRecord;
    readonly lease: RemoteWorkerAssignmentLeaseRecord;
  }> {
    const aggregate = await this.dependencies.assignments.findAssignmentAggregate(registryWorkspaceId, assignmentId);
    if (aggregate === undefined || aggregate.generation === undefined || aggregate.lease === undefined) {
      throw rejected("Remote worker assignment authority is unavailable.");
    }
    return Object.freeze({
      assignment: snapshotAssignment(aggregate.assignment),
      generation: snapshotGeneration(aggregate.generation),
      lease: snapshotLease(aggregate.lease),
    });
  }
}

function snapshotRequest(value: unknown): SnapshotRequest {
  const fields = exactOwnDataFields(
    value,
    ["method", "rawPath", "headers", "body", "transportIdentity"],
    [],
    "assignment RPC input",
  );
  if (fields.method !== "POST" || typeof fields.rawPath !== "string") {
    throw rejected("Remote worker assignment RPC target is invalid.");
  }
  const route = routeForPath(fields.rawPath);
  const headers = snapshotHeaders(fields.headers);
  const body = normalizeRemoteWorkerProtocolBody(snapshotPlainJson(fields.body, 0, new Set<object>()));
  if (body.operation !== route.operation) throw rejected("Remote worker assignment RPC operation is invalid.");
  const payload = normalizeRpcPayload(route, body);
  return Object.freeze({
    method: "POST",
    rawPath: route.rawPath,
    route,
    headers,
    body,
    payload,
    credentialTokenSha256: credentialAuthorizationSha256(headers),
    transportIdentity: snapshotTransportIdentity(fields.transportIdentity),
  });
}

function routeForPath(rawPath: string): RemoteWorkerAssignmentRpcRoute {
  const routes = Object.values(REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES);
  const route = routes.find((candidate) => candidate.rawPath === rawPath);
  if (route === undefined) throw rejected("Remote worker assignment RPC route is unavailable.");
  return route;
}

function normalizeRpcPayload(
  route: RemoteWorkerAssignmentRpcRoute,
  body: RemoteWorkerProtocolBody,
): NormalizedRpcPayload {
  assertPayloadByteLimit(body.payload);
  if (route === REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync) {
    return Object.freeze({
      kind: "sync",
      command: normalizeCommonPayload(body.payload, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
    });
  }
  if (route === REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.readControl) {
    return Object.freeze({
      kind: "readControl",
      command: normalizeCommonPayload(body.payload, REMOTE_WORKER_ASSIGNMENT_CONTROL_READ_SCHEMA_VERSION),
    });
  }
  if (route === REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.renewLease) {
    return Object.freeze({
      kind: "renewLease",
      command: normalizeLeaseRenewalPayload(body.payload, body.idempotencyKey),
    });
  }
  if (route === REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents) {
    return Object.freeze({ kind: "appendEvents", command: normalizeEventAppendPayload(body.payload) });
  }
  return Object.freeze({ kind: "settle", command: normalizeSettlementPayload(body.payload, body.idempotencyKey) });
}

function normalizeCommonPayload(value: unknown, schemaVersion: string): CommonAssignmentPayload {
  const fields = exactOwnDataFields(
    value,
    ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "leaseToken"],
    [],
    "assignment RPC payload",
  );
  if (fields.schemaVersion !== schemaVersion) throw rejected("Remote worker assignment RPC payload schema is invalid.");
  return Object.freeze({
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(fields.assignmentGeneration, "assignmentGeneration"),
    leaseRevision: positiveInteger(fields.leaseRevision, "leaseRevision"),
    leaseTokenSha256: leaseTokenSha256(fields.leaseToken, "leaseToken"),
  });
}

function normalizeLeaseRenewalPayload(value: unknown, idempotencyKey: string): RenewRemoteWorkerAssignmentLeaseCommand {
  const fields = exactOwnDataFields(
    value,
    [
      "schemaVersion",
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "leaseRevision",
      "leaseToken",
      "nextLeaseToken",
      "workerSentThrough",
    ],
    [],
    "assignment lease renewal payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_LEASE_RENEWAL_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment lease renewal payload schema is invalid.");
  }
  const expectedLeaseTokenSha256 = leaseTokenSha256(fields.leaseToken, "leaseToken");
  const nextLeaseTokenSha256 = leaseTokenSha256(fields.nextLeaseToken, "nextLeaseToken");
  if (safeDigestEqual(expectedLeaseTokenSha256, nextLeaseTokenSha256)) {
    throw rejected("Remote worker assignment next lease token must rotate.");
  }
  return normalizeRenewRemoteWorkerAssignmentLeaseCommand({
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(fields.assignmentGeneration, "assignmentGeneration"),
    expectedLeaseRevision: positiveInteger(fields.leaseRevision, "leaseRevision"),
    expectedLeaseTokenSha256,
    leaseTokenSha256: nextLeaseTokenSha256,
    workerSentThrough: nonNegativeInteger(fields.workerSentThrough, "workerSentThrough"),
    idempotencyKey,
  });
}

function normalizeEventAppendPayload(value: unknown): AppendRemoteWorkerAssignmentEventsCommand {
  const fields = exactOwnDataFields(
    value,
    [
      "schemaVersion",
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "leaseRevision",
      "leaseToken",
      "events",
    ],
    [],
    "assignment event append payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment event append payload schema is invalid.");
  }
  return normalizeAppendRemoteWorkerAssignmentEventsCommand({
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(fields.assignmentGeneration, "assignmentGeneration"),
    expectedLeaseRevision: positiveInteger(fields.leaseRevision, "leaseRevision"),
    leaseTokenSha256: leaseTokenSha256(fields.leaseToken, "leaseToken"),
    events: fields.events as AppendRemoteWorkerAssignmentEventsCommand["events"],
  });
}

function normalizeSettlementPayload(value: unknown, idempotencyKey: string): SettleRemoteWorkerAssignmentWorkerCommand {
  const fields = exactOwnDataFields(
    value,
    [
      "schemaVersion",
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "leaseRevision",
      "leaseToken",
      "outcome",
      "finalEventSequence",
      "finalEventSha256",
    ],
    ["resultSha256", "outputManifestSha256", "failureSha256"],
    "assignment settlement payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_WORKER_SETTLEMENT_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment settlement payload schema is invalid.");
  }
  return normalizeSettleRemoteWorkerAssignmentCommand({
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(fields.assignmentGeneration, "assignmentGeneration"),
    expectedLeaseRevision: positiveInteger(fields.leaseRevision, "leaseRevision"),
    leaseTokenSha256: leaseTokenSha256(fields.leaseToken, "leaseToken"),
    outcome: fields.outcome as RemoteWorkerAssignmentSettlementOutcome,
    origin: "worker",
    finalEventSequence: nonNegativeInteger(fields.finalEventSequence, "finalEventSequence"),
    finalEventSha256: digest(fields.finalEventSha256, "finalEventSha256"),
    ...(fields.resultSha256 === undefined ? {} : { resultSha256: digest(fields.resultSha256, "resultSha256") }),
    ...(fields.outputManifestSha256 === undefined
      ? {}
      : { outputManifestSha256: digest(fields.outputManifestSha256, "outputManifestSha256") }),
    ...(fields.failureSha256 === undefined ? {} : { failureSha256: digest(fields.failureSha256, "failureSha256") }),
    idempotencyKey,
  }) as SettleRemoteWorkerAssignmentWorkerCommand;
}

function snapshotCredentialAuthority(
  value: unknown,
  expectedCredentialTokenSha256: string,
): RemoteWorkerAssignmentRuntimeCredentialAuthority {
  const fields = exactOwnDataFields(
    value,
    [
      "credentialId",
      "credentialGeneration",
      "authorizationCredentialSha256",
      "registryWorkspaceId",
      "workerId",
      "workerGeneration",
      "nodeId",
      "nodeAdmissionGeneration",
      "publicKeySpkiDer",
      "publicKeySpkiSha256",
      "clientCertificateSha256",
      "transportTrustAnchorSha256",
      "runtimeManifestSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "claims",
      "claimsSha256",
    ],
    [],
    "runtime credential authority",
  );
  if (
    !Buffer.isBuffer(fields.publicKeySpkiDer) ||
    nodeUtilTypes.isProxy(fields.publicKeySpkiDer) ||
    fields.publicKeySpkiDer.byteLength !== 44
  ) {
    throw rejected("Remote worker assignment admitted public key evidence is invalid.");
  }
  const claims = snapshotClaims(fields.claims);
  const authority = Object.freeze({
    credentialId: identifier(fields.credentialId, "credentialId"),
    credentialGeneration: positiveInteger(fields.credentialGeneration, "credentialGeneration"),
    authorizationCredentialSha256: digest(fields.authorizationCredentialSha256, "authorizationCredentialSha256"),
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    workerId: identifier(fields.workerId, "workerId"),
    workerGeneration: positiveInteger(fields.workerGeneration, "workerGeneration"),
    nodeId: identifier(fields.nodeId, "nodeId"),
    nodeAdmissionGeneration: positiveInteger(fields.nodeAdmissionGeneration, "nodeAdmissionGeneration"),
    publicKeySpkiDer: Buffer.from(fields.publicKeySpkiDer),
    publicKeySpkiSha256: digest(fields.publicKeySpkiSha256, "publicKeySpkiSha256"),
    clientCertificateSha256: digest(fields.clientCertificateSha256, "clientCertificateSha256"),
    transportTrustAnchorSha256: digest(fields.transportTrustAnchorSha256, "transportTrustAnchorSha256"),
    runtimeManifestSha256: digest(fields.runtimeManifestSha256, "runtimeManifestSha256"),
    workspaceCeilingSha256: digest(fields.workspaceCeilingSha256, "workspaceCeilingSha256"),
    capabilityCeilingSha256: digest(fields.capabilityCeilingSha256, "capabilityCeilingSha256"),
    claims,
    claimsSha256: digest(fields.claimsSha256, "claimsSha256"),
  });
  if (
    !safeDigestEqual(authority.authorizationCredentialSha256, expectedCredentialTokenSha256) ||
    !safeDigestEqual(sha256Bytes(authority.publicKeySpkiDer), authority.publicKeySpkiSha256) ||
    !safeDigestEqual(remoteWorkerRuntimeCredentialClaimsSha256(authority.claims), authority.claimsSha256) ||
    authority.claims.registryWorkspaceId !== authority.registryWorkspaceId ||
    authority.claims.workerId !== authority.workerId ||
    authority.claims.workerGeneration !== authority.workerGeneration ||
    authority.claims.workspaceCeilingSha256 !== authority.workspaceCeilingSha256 ||
    authority.claims.capabilityCeilingSha256 !== authority.capabilityCeilingSha256
  ) {
    throw rejected("Remote worker assignment runtime credential authority is inconsistent.");
  }
  return authority;
}

function snapshotClaims(value: unknown): RemoteWorkerRuntimeCredentialClaims {
  const snapshot = snapshotPlainJson(value, 0, new Set<object>());
  assertRemoteWorkerRuntimeCredentialClaims(snapshot);
  return snapshot as RemoteWorkerRuntimeCredentialClaims;
}

function assertTransportAuthorityBinding(
  authority: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  transport: RemoteWorkerTransportIdentity,
): void {
  if (
    transport.source !== "native_mtls" ||
    !safeDigestEqual(transport.publicKeySpkiSha256, authority.publicKeySpkiSha256) ||
    !safeDigestEqual(transport.certificateDerSha256, authority.clientCertificateSha256) ||
    !safeDigestEqual(transport.trustAnchorDerSha256, authority.transportTrustAnchorSha256)
  ) {
    throw rejected("Remote worker assignment mutual TLS authority is invalid.");
  }
}

function assertCredentialAssignmentBinding(
  credential: RemoteWorkerAssignmentRuntimeCredentialAuthority,
  assignment: RemoteWorkerAssignmentRecord,
  generation: RemoteWorkerAssignmentGenerationRecord,
): void {
  const claims = credential.claims;
  const routeDecision = evaluateRemoteWorkerRuntimeCredentialRoutePolicy(claims, {
    routeAccessClass: REMOTE_WORKER_ROUTE_ACCESS_CLASS,
    workspaceId: assignment.manifest.executionWorkspaceId,
    requiredCapabilityClasses: assignment.manifest.requiredCapabilityClasses,
  });
  if (
    !routeDecision.allowed ||
    credential.registryWorkspaceId !== assignment.registryWorkspaceId ||
    claims.registryWorkspaceId !== assignment.registryWorkspaceId ||
    !claims.allowedWorkspaceIds.includes(assignment.registryWorkspaceId) ||
    generation.registryWorkspaceId !== assignment.registryWorkspaceId ||
    generation.assignmentId !== assignment.assignmentId ||
    generation.executionWorkspaceId !== assignment.manifest.executionWorkspaceId ||
    generation.workerId !== credential.workerId ||
    generation.workerGeneration !== credential.workerGeneration ||
    generation.nodeId !== credential.nodeId ||
    generation.nodeAdmissionGeneration !== credential.nodeAdmissionGeneration ||
    generation.runtimeManifestSha256 !== credential.runtimeManifestSha256 ||
    generation.workspaceCeilingSha256 !== credential.workspaceCeilingSha256 ||
    generation.capabilityCeilingSha256 !== credential.capabilityCeilingSha256
  ) {
    throw rejected("Remote worker assignment credential does not bind the assignment authority.");
  }
}

function assertRequestBinding(
  records: {
    readonly assignment: RemoteWorkerAssignmentRecord;
    readonly generation: RemoteWorkerAssignmentGenerationRecord;
    readonly lease: RemoteWorkerAssignmentLeaseRecord;
  },
  command: CommonAssignmentPayload,
): void {
  if (
    records.assignment.registryWorkspaceId !== command.registryWorkspaceId ||
    records.assignment.assignmentId !== command.assignmentId ||
    records.generation.assignmentGeneration !== command.assignmentGeneration ||
    records.lease.assignmentGeneration !== command.assignmentGeneration ||
    records.lease.leaseRevision !== command.leaseRevision
  ) {
    throw rejected("Remote worker assignment request does not bind the active lease.");
  }
}

function assertGenerationBinding(generation: RemoteWorkerAssignmentGenerationRecord, expected: number): void {
  if (generation.assignmentGeneration !== expected) {
    throw rejected("Remote worker assignment generation is stale.");
  }
}

function snapshotResolvedAssignmentAuthority(value: ResolvedRemoteWorkerAssignmentAuthority): {
  readonly assignment: RemoteWorkerAssignmentRecord;
  readonly generation: RemoteWorkerAssignmentGenerationRecord;
  readonly lease: RemoteWorkerAssignmentLeaseRecord;
} {
  return Object.freeze({
    assignment: snapshotAssignment(value.assignment),
    generation: snapshotGeneration(value.generation),
    lease: snapshotLease(value.lease),
  });
}

function snapshotControlReadAuthority(value: ResolvedRemoteWorkerAssignmentControlReadAuthority): {
  readonly disposition: ResolvedRemoteWorkerAssignmentControlReadAuthority["disposition"];
  readonly assignment: RemoteWorkerAssignmentRecord;
  readonly generation: RemoteWorkerAssignmentGenerationRecord;
  readonly lease: RemoteWorkerAssignmentLeaseRecord;
  readonly control?: RemoteWorkerAssignmentControlRecord;
} {
  const common = {
    disposition: value.disposition,
    assignment: snapshotAssignment(value.assignment),
    generation: snapshotGeneration(value.generation),
    lease: snapshotLease(value.lease),
  };
  return value.disposition === "active"
    ? Object.freeze(common)
    : Object.freeze({ ...common, control: snapshotControl(value.control) });
}

function snapshotAssignment(value: RemoteWorkerAssignmentRecord): RemoteWorkerAssignmentRecord {
  assertRemoteWorkerAssignmentRecord(value);
  return canonicalSnapshot(value) as RemoteWorkerAssignmentRecord;
}

function snapshotGeneration(value: RemoteWorkerAssignmentGenerationRecord): RemoteWorkerAssignmentGenerationRecord {
  assertRemoteWorkerAssignmentGenerationRecord(value);
  return canonicalSnapshot(value) as RemoteWorkerAssignmentGenerationRecord;
}

function snapshotLease(value: RemoteWorkerAssignmentLeaseRecord): RemoteWorkerAssignmentLeaseRecord {
  assertRemoteWorkerAssignmentLeaseRecord(value);
  return canonicalSnapshot(value) as RemoteWorkerAssignmentLeaseRecord;
}

function snapshotControl(value: RemoteWorkerAssignmentControlRecord): RemoteWorkerAssignmentControlRecord {
  assertRemoteWorkerAssignmentControlRecord(value);
  return canonicalSnapshot(value) as RemoteWorkerAssignmentControlRecord;
}

function snapshotSettlement(value: RemoteWorkerAssignmentSettlementRecord): RemoteWorkerAssignmentSettlementRecord {
  assertRemoteWorkerAssignmentSettlementRecord(value);
  return canonicalSnapshot(value) as RemoteWorkerAssignmentSettlementRecord;
}

function canonicalSnapshot(value: unknown): unknown {
  const encoded = canonicalJsonString(value);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) {
    throw rejected("Remote worker assignment response exceeds its byte limit.");
  }
  return snapshotPlainJson(JSON.parse(encoded) as unknown, 0, new Set<object>());
}

function responseBase(route: RemoteWorkerAssignmentRpcRoute): BaseResponse {
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_RPC_RESPONSE_SCHEMA_VERSION,
    operation: route.operation,
  });
}

function credentialAuthorizationSha256(headers: RemoteWorkerRequestHeaders): string {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") throw rejected("Remote worker assignment authorization is invalid.");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (match === null) throw rejected("Remote worker assignment authorization is invalid.");
  return sha256Utf8(canonical32ByteSecret(match[1], "authorization credential"));
}

function snapshotHeaders(value: unknown): RemoteWorkerRequestHeaders {
  assertPlainRecord(value, "request headers");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw rejected("Remote worker assignment request headers are invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 32) throw rejected("Remote worker assignment request headers are invalid.");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, descriptor] of Object.entries(descriptors)) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      name.length < 1 ||
      name.length > 128 ||
      !/^[a-z0-9-]+$/u.test(name) ||
      name in result ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 8_192 ||
      /[\r\n]/u.test(descriptor.value)
    ) {
      throw rejected("Remote worker assignment request headers are invalid.");
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
    throw rejected("Remote worker assignment TLS exporter is invalid.");
  }
  const snapshot = Object.freeze({
    source: fields.source as "native_mtls",
    certificateDerSha256: digest(fields.certificateDerSha256, "certificateDerSha256"),
    publicKeySpkiSha256: digest(fields.publicKeySpkiSha256, "publicKeySpkiSha256"),
    trustAnchorDerSha256: digest(fields.trustAnchorDerSha256, "trustAnchorDerSha256"),
    tlsExporterSha256: digest(fields.tlsExporterSha256, "tlsExporterSha256"),
    tlsExporter: Buffer.from(fields.tlsExporter),
  });
  if (
    snapshot.source !== "native_mtls" ||
    !safeDigestEqual(sha256Bytes(snapshot.tlsExporter), snapshot.tlsExporterSha256)
  ) {
    snapshot.tlsExporter.fill(0);
    throw rejected("Remote worker assignment transport identity is invalid.");
  }
  return snapshot;
}

function assertPayloadByteLimit(value: unknown): void {
  if (Buffer.byteLength(canonicalJsonString(value), "utf8") > REMOTE_WORKER_ASSIGNMENT_RPC_MAX_PAYLOAD_BYTES) {
    throw rejected("Remote worker assignment RPC payload exceeds its byte limit.");
  }
}

function exactOwnDataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainRecord(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((name) => typeof name !== "string")) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = (ownKeys as string[]).sort();
  const permitted = new Set([...required, ...optional]);
  if (
    required.some((name) => !(name in descriptors)) ||
    actual.some((name) => !permitted.has(name)) ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of actual) result[name] = descriptors[name]?.value;
  return result;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw rejected(`Remote worker ${label} is invalid.`);
}

function snapshotPlainJson(value: unknown, depth: number, seen: Set<object>): unknown {
  if (depth > 64) throw rejected("Remote worker assignment data is invalid.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw rejected("Remote worker assignment data is invalid.");
    return value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      throw rejected("Remote worker assignment data is invalid.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors["length"];
    const length = lengthDescriptor?.value;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > 10_000 ||
      Reflect.ownKeys(value).length !== (length as number) + 1
    ) {
      throw rejected("Remote worker assignment data is invalid.");
    }
    seen.add(value);
    const snapshot: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw rejected("Remote worker assignment data is invalid.");
      }
      snapshot.push(snapshotPlainJson(descriptor.value, depth + 1, seen));
    }
    seen.delete(value);
    return Object.freeze(snapshot);
  }
  assertPlainRecord(value, "assignment data");
  if (seen.has(value)) throw rejected("Remote worker assignment data is invalid.");
  seen.add(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((name) => typeof name !== "string")) {
    throw rejected("Remote worker assignment data is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of (ownKeys as string[]).sort()) {
    const descriptor = descriptors[name] as PropertyDescriptor;
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw rejected("Remote worker assignment data is invalid.");
    }
    snapshot[name] = snapshotPlainJson(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return Object.freeze(snapshot);
}

function snapshotClock(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw rejected("Remote worker assignment RPC clock is invalid.");
  }
  return new Date(value.getTime());
}

function identifier(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw rejected(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw rejected(`Remote worker assignment ${field} is invalid.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw rejected(`Remote worker assignment ${field} is invalid.`);
  }
  return value as number;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw rejected(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function leaseTokenSha256(value: unknown, field: string): string {
  return sha256Utf8(canonical32ByteSecret(value, field));
}

function canonical32ByteSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw rejected(`Remote worker assignment ${field} is invalid.`);
  }
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
      throw rejected(`Remote worker assignment ${field} is invalid.`);
    }
  } finally {
    decoded.fill(0);
  }
  return value;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rejected(message: string): RemoteWorkerAssignmentProtocolError {
  return new RemoteWorkerAssignmentProtocolError(message);
}
