import { createHash, randomBytes } from "node:crypto";
import {
  NotFoundError,
  REMOTE_WORKER_ASSIGNMENT_CURSOR_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_DEFAULT_LIMIT,
  REMOTE_WORKER_ASSIGNMENT_EVENT_DEFAULT_LIMIT,
  REMOTE_WORKER_ASSIGNMENT_EVENT_MAX_LIMIT,
  REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MAX_LIMIT,
  REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION,
  REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT,
  REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES,
  REMOTE_WORKER_REGISTRY_MAX_LIMIT,
  REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
  canonicalJsonString,
  compareRemoteWorkerCanonicalIdentifiers,
  freezeRemoteWorkerAssignmentEventPage,
  freezeRemoteWorkerAssignmentPage,
  freezeRemoteWorkerReconciliation,
  freezeRemoteWorkerRegistryDetail,
  freezeRemoteWorkerRegistryPage,
  normalizeRemoteWorkerAssignmentCursor,
  normalizeCreateRemoteWorkerBootstrapRequest,
  normalizeRemoteWorkerRegistryCursor,
  redactSecretText,
  type CreateRemoteWorkerBootstrapRequest,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerCapabilityClass,
  type RemoteWorkerGenerationControlInput,
  type RemoteWorkerGenerationControlRecord,
  type RemoteWorkerRuntimeManifest,
  type RemoteWorkerAssignmentCursorV1,
  type RemoteWorkerAssignmentEventPage,
  type RemoteWorkerAssignmentEventRecord,
  type RemoteWorkerAssignmentEventSummary,
  type RemoteWorkerAssignmentFilters,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentPage,
  type RemoteWorkerAssignmentPhase,
  type RemoteWorkerAssignmentProjection,
  type RemoteWorkerReconciliation,
  type RemoteWorkerReconciliationObservation,
  type RemoteWorkerRegistryCursorV1,
  type RemoteWorkerRegistryDetail,
  type RemoteWorkerRegistryItem,
  type RemoteWorkerRegistryPage,
  type RemoteWorkerRegistryPosture,
  type RemoteWorkerTruth,
} from "@goatcitadel/contracts";
import type {
  ListRemoteWorkerAssignmentAggregatesOptions,
  ListRemoteWorkerAssignmentAggregatesResult,
  ListRemoteWorkerRegistryResult,
  RemoteWorkerAssignmentAggregate,
  RemoteWorkerRegistryRecord,
} from "@goatcitadel/storage";
import type { RemoteWorkerManifestVerifierPort } from "./remote-worker-manifest-verifier.js";

const ASSIGNMENTS_OWNER = "storage.remoteWorkerAssignments";
const GATEWAY_OWNER = "gateway.remoteWorkers";
const REMOTE_WORKER_RECONCILIATION_MAX_PAGES = 100;

export interface RemoteWorkerRegistryStore {
  listWorkerRegistry(
    registryWorkspaceId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<ListRemoteWorkerRegistryResult>;
  findWorkerRegistryEntry(
    registryWorkspaceId: string,
    workerId: string,
  ): Promise<RemoteWorkerRegistryRecord | undefined>;
}

export interface RemoteWorkerAssignmentStore {
  listAssignmentAggregates(
    registryWorkspaceId: string,
    options?: ListRemoteWorkerAssignmentAggregatesOptions,
  ): Promise<ListRemoteWorkerAssignmentAggregatesResult>;
  findAssignmentAggregate(
    registryWorkspaceId: string,
    assignmentId: string,
  ): Promise<RemoteWorkerAssignmentAggregate | undefined>;
  findCurrentGeneration(
    registryWorkspaceId: string,
    assignmentId: string,
  ): Promise<RemoteWorkerAssignmentGenerationRecord | undefined>;
  listEventsAfter(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    afterSequence?: number,
    limit?: number,
  ): Promise<RemoteWorkerAssignmentEventRecord[]>;
}

export interface RemoteWorkerAdmissionMutationStore {
  createBootstrap(input: {
    readonly registryWorkspaceId: string;
    readonly existingWorkerId?: string;
    readonly workerLabel: string;
    readonly platform: string;
    readonly architecture: string;
    readonly runtimeManifest: RemoteWorkerRuntimeManifest;
    readonly allowedWorkspaceIds: readonly string[];
    readonly capabilityClasses: readonly RemoteWorkerCapabilityClass[];
    readonly expiresInSeconds: number;
    readonly idempotencyKey: string;
    readonly createdByActorId: string;
    readonly bootstrapSecretSha256: string;
  }): Promise<{
    readonly disposition: "created" | "replayed_without_secret";
    readonly record: RemoteWorkerBootstrapRecord;
  }>;
  quarantineGeneration(input: RemoteWorkerGenerationControlInput): Promise<RemoteWorkerGenerationControlRecord>;
  revokeGeneration(input: RemoteWorkerGenerationControlInput): Promise<RemoteWorkerGenerationControlRecord>;
}

export interface RemoteWorkerOperatorAuditPort {
  append(
    stream: "approvals",
    payload: Record<string, unknown>,
    options: { readonly deliveryId: string },
  ): Promise<void>;
}

export interface RemoteWorkerOperatorControlDependencies {
  readonly admissions: RemoteWorkerAdmissionMutationStore;
  readonly audit: RemoteWorkerOperatorAuditPort;
  readonly manifestVerifier: RemoteWorkerManifestVerifierPort;
  readonly randomSecretBytes?: (size: number) => Buffer;
}

export interface ListRemoteWorkerAssignmentsInput {
  readonly workspaceId: string;
  readonly workerId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetRemoteWorkerAssignmentEventsInput {
  readonly workspaceId: string;
  readonly assignmentId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface GetRemoteWorkerReconciliationInput {
  readonly workspaceId: string;
  readonly workerId: string;
}

export interface ListRemoteWorkerRegistryInput {
  readonly workspaceId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetRemoteWorkerRegistryInput {
  readonly workspaceId: string;
  readonly workerId: string;
}

export interface IssueRemoteWorkerBootstrapInput {
  readonly workspaceId: string;
  readonly existingWorkerId?: string;
  readonly workerLabel: string;
  readonly platform: string;
  readonly architecture: string;
  readonly runtimeManifest: RemoteWorkerRuntimeManifest;
  readonly allowedWorkspaceIds: readonly string[];
  readonly capabilityClasses: readonly RemoteWorkerCapabilityClass[];
  readonly expiresInSeconds: number;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerBootstrapIssuance {
  readonly disposition: "created" | "replayed_without_secret";
  readonly workspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly nodeId: string;
  readonly targetWorkerGeneration: number;
  readonly state: RemoteWorkerBootstrapRecord["state"];
  readonly expiresAt: string;
  readonly manifestPayloadSha256: string;
  readonly auditDeliveryId: string;
  readonly bootstrapSecret?: string;
}

export interface ControlRemoteWorkerGenerationInput {
  readonly workspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerGenerationControlReceipt {
  readonly workspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly controlRevision: number;
  readonly action: "quarantine" | "revoke";
  readonly reasonCode: string;
  readonly reasonSha256: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly auditDeliveryId: string;
}

export class RemoteWorkerRegistryInputError extends Error {
  public constructor() {
    super("Remote worker registry request is invalid.");
    this.name = "RemoteWorkerRegistryInputError";
  }
}

export class RemoteWorkerOperatorControlUnavailableError extends Error {
  public constructor() {
    super("Remote worker operator control is unavailable.");
    this.name = "RemoteWorkerOperatorControlUnavailableError";
  }
}

export class RemoteWorkersRouteService {
  public constructor(
    private readonly registry: RemoteWorkerRegistryStore,
    private readonly assignments: RemoteWorkerAssignmentStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly operatorControl?: RemoteWorkerOperatorControlDependencies,
  ) {}

  public async issueBootstrap(input: IssueRemoteWorkerBootstrapInput): Promise<RemoteWorkerBootstrapIssuance> {
    const control = this.requireOperatorControl();
    let request: CreateRemoteWorkerBootstrapRequest;
    try {
      request = normalizeCreateRemoteWorkerBootstrapRequest({
        registryWorkspaceId: inputIdentifier(input.workspaceId),
        ...(input.existingWorkerId === undefined ? {} : { existingWorkerId: inputIdentifier(input.existingWorkerId) }),
        workerLabel: input.workerLabel,
        platform: input.platform,
        architecture: input.architecture,
        runtimeManifest: input.runtimeManifest,
        allowedWorkspaceIds: input.allowedWorkspaceIds,
        capabilityClasses: input.capabilityClasses,
        expiresInSeconds: input.expiresInSeconds,
        idempotencyKey: inputCanonicalIdentifier(input.idempotencyKey, 512),
      });
    } catch (error) {
      if (error instanceof RemoteWorkerRegistryInputError) throw error;
      throw new RemoteWorkerRegistryInputError();
    }
    const actorId = inputCanonicalIdentifier(input.actorId, 256);
    if (redactSecretText(request.workerLabel).redactionCount > 0) {
      throw new RemoteWorkerRegistryInputError();
    }
    const manifestVerification = await control.manifestVerifier.verify(request.runtimeManifest);
    const auditDeliveryId = `remote-worker-bootstrap-request:${sha256Utf8(
      canonicalJsonString({
        schemaVersion: "goatcitadel.remote-worker-bootstrap-audit-request.v1",
        request,
        actorId,
      }),
    )}`;

    // A bootstrap secret cannot be recovered from its durable hash. Persist the
    // secret-free request audit before generating or committing that one-time
    // value so an audit outage leaves no unusable bootstrap authority behind.
    // The immutable bootstrap row is the canonical post-effect issuance proof.
    await control.audit.append(
      "approvals",
      {
        event: "remote_worker.bootstrap.requested",
        registryWorkspaceId: request.registryWorkspaceId,
        existingWorkerId: request.existingWorkerId ?? null,
        platform: request.platform,
        architecture: request.architecture,
        manifestPayloadSha256: manifestVerification.payloadSha256,
        manifestVerificationReceiptSha256: manifestVerification.manifestVerificationReceiptSha256,
        allowedWorkspaceCount: request.allowedWorkspaceIds.length,
        capabilityClassCount: request.capabilityClasses.length,
        createdByActorId: actorId,
      },
      { deliveryId: auditDeliveryId },
    );

    const secretBytes = (control.randomSecretBytes ?? randomBytes)(32);
    if (!Buffer.isBuffer(secretBytes) || secretBytes.byteLength !== 32) {
      secretBytes?.fill?.(0);
      throw new RemoteWorkerOperatorControlUnavailableError();
    }
    const bootstrapSecret = secretBytes.toString("base64url");
    // Protocol authorization hashes the exact UTF-8 header/token text, not the
    // decoded random bytes. Keep issuance and live PoP resolution identical.
    const bootstrapSecretSha256 = sha256Utf8(bootstrapSecret);
    secretBytes.fill(0);

    const outcome = await control.admissions.createBootstrap({
      ...request,
      createdByActorId: actorId,
      bootstrapSecretSha256,
    });
    return Object.freeze({
      disposition: outcome.disposition,
      workspaceId: outcome.record.registryWorkspaceId,
      bootstrapId: outcome.record.bootstrapId,
      workerId: outcome.record.workerId,
      nodeId: outcome.record.nodeId,
      targetWorkerGeneration: outcome.record.targetWorkerGeneration,
      state: outcome.record.state,
      expiresAt: outcome.record.expiresAt,
      manifestPayloadSha256: outcome.record.runtimeManifest.payloadSha256,
      auditDeliveryId,
      ...(outcome.disposition === "created" ? { bootstrapSecret } : {}),
    });
  }

  public quarantineGeneration(
    input: ControlRemoteWorkerGenerationInput,
  ): Promise<RemoteWorkerGenerationControlReceipt> {
    return this.controlGeneration("quarantine", input);
  }

  public revokeGeneration(input: ControlRemoteWorkerGenerationInput): Promise<RemoteWorkerGenerationControlReceipt> {
    return this.controlGeneration("revoke", input);
  }

  public async listRegistry(input: ListRemoteWorkerRegistryInput): Promise<RemoteWorkerRegistryPage> {
    const workspaceId = inputIdentifier(input.workspaceId);
    const limit = inputLimit(input.limit);
    const cursor = input.cursor === undefined ? undefined : decodeRemoteWorkerRegistryCursor(input.cursor);
    if (cursor && cursor.workspaceId !== workspaceId) throw new RemoteWorkerRegistryInputError();
    const stored = await this.registry.listWorkerRegistry(workspaceId, {
      limit,
      ...(cursor ? { cursor: cursor.lastWorkerId } : {}),
    });
    if (
      stored.items.length > limit ||
      (cursor !== undefined &&
        stored.items.some(
          (record) => compareRemoteWorkerCanonicalIdentifiers(record.admission.workerId, cursor.lastWorkerId) <= 0,
        )) ||
      (stored.nextCursor !== undefined && stored.items.length < limit)
    ) {
      throw new TypeError("Remote worker registry storage page is inconsistent.");
    }
    const observedAt = this.now();
    const items = stored.items.map((record) => projectRegistryItem(record, observedAt));
    if (stored.nextCursor !== undefined && (items.length === 0 || stored.nextCursor !== items.at(-1)?.workerId)) {
      throw new TypeError("Remote worker registry storage cursor is inconsistent.");
    }
    return freezeRemoteWorkerRegistryPage({
      schemaVersion: REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      items,
      ...(stored.nextCursor
        ? {
            nextCursor: encodeRemoteWorkerRegistryCursor({
              schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
              workspaceId,
              lastWorkerId: stored.nextCursor,
            }),
          }
        : {}),
      observedAt,
    });
  }

  public async getRegistryEntry(input: GetRemoteWorkerRegistryInput): Promise<RemoteWorkerRegistryDetail> {
    const workspaceId = inputIdentifier(input.workspaceId);
    const workerId = inputIdentifier(input.workerId);
    const stored = await this.registry.findWorkerRegistryEntry(workspaceId, workerId);
    if (!stored) throw new NotFoundError({ entity: "remote worker registry entry", id: "unavailable" });
    if (stored.admission.workerId !== workerId) {
      throw new TypeError("Remote worker registry storage detail is inconsistent.");
    }
    const observedAt = this.now();
    return freezeRemoteWorkerRegistryDetail({
      schemaVersion: REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      item: projectRegistryItem(stored, observedAt),
      observedAt,
    });
  }

  public async listAssignments(input: ListRemoteWorkerAssignmentsInput): Promise<RemoteWorkerAssignmentPage> {
    const workspaceId = inputIdentifier(input.workspaceId);
    const filters: RemoteWorkerAssignmentFilters = {
      ...(input.workerId === undefined ? {} : { workerId: inputIdentifier(input.workerId) }),
      ...(input.sessionId === undefined ? {} : { sessionId: inputIdentifier(input.sessionId) }),
      ...(input.turnId === undefined ? {} : { turnId: inputIdentifier(input.turnId) }),
    };
    const limit = inputLimit(input.limit, REMOTE_WORKER_ASSIGNMENT_DEFAULT_LIMIT, REMOTE_WORKER_ASSIGNMENT_MAX_LIMIT);
    const cursor = input.cursor === undefined ? undefined : decodeRemoteWorkerAssignmentCursor(input.cursor);
    if (cursor && !cursorMatchesQuery(cursor, workspaceId, filters)) throw new RemoteWorkerRegistryInputError();
    const stored = await this.assignments.listAssignmentAggregates(workspaceId, {
      ...(filters.workerId === undefined ? {} : { workerId: filters.workerId }),
      ...(filters.sessionId === undefined ? {} : { sessionId: filters.sessionId }),
      ...(filters.turnId === undefined ? {} : { turnId: filters.turnId }),
      limit,
      ...(cursor ? { cursor: { lastCreatedAt: cursor.lastCreatedAt, lastAssignmentId: cursor.lastAssignmentId } } : {}),
    });
    if (stored.items.length > limit) throw new TypeError("Remote worker assignment storage page is inconsistent.");
    const observedAt = this.now();
    const items = stored.items.map((aggregate) => projectAssignment(aggregate, observedAt, this.now()));
    return freezeRemoteWorkerAssignmentPage({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      filters,
      items,
      ...(stored.nextCursor
        ? {
            nextCursor: encodeRemoteWorkerAssignmentCursor({
              schemaVersion: REMOTE_WORKER_ASSIGNMENT_CURSOR_SCHEMA_VERSION,
              workspaceId,
              workerId: filters.workerId ?? null,
              sessionId: filters.sessionId ?? null,
              turnId: filters.turnId ?? null,
              lastCreatedAt: stored.nextCursor.lastCreatedAt,
              lastAssignmentId: stored.nextCursor.lastAssignmentId,
            }),
          }
        : {}),
      observedAt,
    });
  }

  public async getAssignmentEvents(
    input: GetRemoteWorkerAssignmentEventsInput,
  ): Promise<RemoteWorkerAssignmentEventPage> {
    const workspaceId = inputIdentifier(input.workspaceId);
    const assignmentId = inputIdentifier(input.assignmentId);
    const afterSequence = inputNonNegative(input.afterSequence, 0);
    const limit = inputLimit(
      input.limit,
      REMOTE_WORKER_ASSIGNMENT_EVENT_DEFAULT_LIMIT,
      REMOTE_WORKER_ASSIGNMENT_EVENT_MAX_LIMIT,
    );
    const generation = await this.assignments.findCurrentGeneration(workspaceId, assignmentId);
    if (!generation) throw new NotFoundError({ entity: "remote worker assignment", id: "unavailable" });
    const events = await this.assignments.listEventsAfter(
      workspaceId,
      assignmentId,
      generation.assignmentGeneration,
      afterSequence,
      limit,
    );
    if (events.length > limit) throw new TypeError("Remote worker assignment event page is inconsistent.");
    const observedAt = this.now();
    const items: RemoteWorkerAssignmentEventSummary[] = events.map((event) => ({
      sequence: event.sequence,
      eventId: event.eventId,
      eventType: event.eventType,
      receivedAt: event.receivedAt,
      workerSentThrough: event.workerSentThrough,
    }));
    const omitted = {
      transcriptDeltas: events.filter((event) => event.eventType === "transcript_delta").length,
      terminalOutputs: events.filter((event) => event.eventType === "terminal_output").length,
      diagnostics: events.filter((event) => event.eventType === "diagnostic").length,
    };
    const nextAfterSequence = items.length > 0 ? items[items.length - 1]!.sequence : afterSequence;
    return freezeRemoteWorkerAssignmentEventPage({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      assignmentId,
      assignmentGeneration: generation.assignmentGeneration,
      items,
      nextAfterSequence,
      omitted,
      observedAt,
    });
  }

  public async getReconciliation(input: GetRemoteWorkerReconciliationInput): Promise<RemoteWorkerReconciliation> {
    const workspaceId = inputIdentifier(input.workspaceId);
    const workerId = inputIdentifier(input.workerId);
    const worker = await this.registry.findWorkerRegistryEntry(workspaceId, workerId);
    if (!worker) throw new NotFoundError({ entity: "remote worker registry entry", id: "unavailable" });
    const observedAt = this.now();
    const now = this.now();
    const posture: RemoteWorkerRegistryPosture =
      worker.control?.action === "quarantine" ? "quarantined" : worker.control ? "revoked" : "active";
    const workerAssignments: RemoteWorkerAssignmentAggregate[] = [];
    let cursor: ListRemoteWorkerAssignmentAggregatesOptions["cursor"];
    const seenCursors = new Set<string>();
    for (let pageNumber = 1; ; pageNumber += 1) {
      const page = await this.assignments.listAssignmentAggregates(workspaceId, {
        workerId,
        limit: REMOTE_WORKER_ASSIGNMENT_MAX_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.items.length > REMOTE_WORKER_ASSIGNMENT_MAX_LIMIT) {
        throw new TypeError("Remote worker assignment reconciliation page is inconsistent.");
      }
      workerAssignments.push(...page.items);
      if (page.nextCursor === undefined) break;
      if (pageNumber >= REMOTE_WORKER_RECONCILIATION_MAX_PAGES) {
        throw new TypeError(
          `Remote worker assignment reconciliation exceeded ${REMOTE_WORKER_RECONCILIATION_MAX_PAGES} pages.`,
        );
      }

      const cursorKey = `${page.nextCursor.lastCreatedAt}\u0000${page.nextCursor.lastAssignmentId}`;
      if (seenCursors.has(cursorKey)) {
        throw new TypeError("Remote worker assignment reconciliation cursor did not advance.");
      }
      seenCursors.add(cursorKey);
      cursor = page.nextCursor;
    }
    return freezeRemoteWorkerReconciliation({
      schemaVersion: REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      workerId,
      posture: derived<RemoteWorkerRegistryPosture>(posture, observedAt),
      admissionControl: derived<RemoteWorkerReconciliationObservation>(reconcileAdmissionControl(worker), observedAt),
      assignmentLease: derived<RemoteWorkerReconciliationObservation>(
        reconcileAssignmentLease(workerAssignments, now),
        observedAt,
      ),
      settlementMaterialization: derived<RemoteWorkerReconciliationObservation>(
        reconcileSettlementMaterialization(workerAssignments),
        observedAt,
      ),
      resourceCell: unavailableTruth("storage.remoteWorkerResourceCells", observedAt),
      cleanup: unavailableTruth("storage.remoteWorkerCleanup", observedAt),
      observedAt,
    });
  }

  private async controlGeneration(
    action: "quarantine" | "revoke",
    input: ControlRemoteWorkerGenerationInput,
  ): Promise<RemoteWorkerGenerationControlReceipt> {
    const control = this.requireOperatorControl();
    const workspaceId = inputIdentifier(input.workspaceId);
    const workerId = inputIdentifier(input.workerId);
    if (!Number.isSafeInteger(input.workerGeneration) || input.workerGeneration < 1) {
      throw new RemoteWorkerRegistryInputError();
    }
    const reasonCode = inputCanonicalReasonCode(input.reasonCode);
    const reason = inputCanonicalText(input.reason, 1_024);
    if (redactSecretText(reasonCode).redactionCount > 0 || redactSecretText(reason).redactionCount > 0) {
      throw new RemoteWorkerRegistryInputError();
    }
    // Secret-like evidence is rejected above before any durable fingerprint is
    // produced. Only this content digest crosses the repository/audit boundary.
    const reasonSha256 = sha256Utf8(reason);
    const actorId = inputCanonicalIdentifier(input.actorId, 256);
    const idempotencyKey = inputCanonicalIdentifier(input.idempotencyKey, 512);
    const record = await control.admissions[`${action}Generation`]({
      registryWorkspaceId: workspaceId,
      workerId,
      workerGeneration: input.workerGeneration,
      reasonCode,
      reasonSha256,
      actorId,
      idempotencyKey,
    });
    const auditDeliveryId = `remote-worker-control:${record.action}:${record.requestSha256}`;
    await control.audit.append(
      "approvals",
      {
        event: `remote_worker.generation.${record.action === "quarantine" ? "quarantined" : "revoked"}`,
        registryWorkspaceId: record.registryWorkspaceId,
        workerId: record.workerId,
        workerGeneration: record.workerGeneration,
        controlRevision: record.controlRevision,
        action: record.action,
        reasonCode: record.reasonCode,
        reasonSha256: record.reasonSha256,
        actorId: record.actorId,
        createdAt: record.createdAt,
      },
      { deliveryId: auditDeliveryId },
    );
    return Object.freeze({
      workspaceId: record.registryWorkspaceId,
      workerId: record.workerId,
      workerGeneration: record.workerGeneration,
      controlRevision: record.controlRevision,
      action: record.action,
      reasonCode: record.reasonCode,
      reasonSha256: record.reasonSha256,
      actorId: record.actorId,
      createdAt: record.createdAt,
      auditDeliveryId,
    });
  }

  private requireOperatorControl(): RemoteWorkerOperatorControlDependencies {
    if (!this.operatorControl) throw new RemoteWorkerOperatorControlUnavailableError();
    return this.operatorControl;
  }
}

export function encodeRemoteWorkerRegistryCursor(cursor: RemoteWorkerRegistryCursorV1): string {
  let normalized: RemoteWorkerRegistryCursorV1;
  try {
    normalized = normalizeRemoteWorkerRegistryCursor(cursor);
  } catch {
    throw new RemoteWorkerRegistryInputError();
  }
  const encoded = Buffer.from(canonicalJsonString(normalized), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES) {
    throw new RemoteWorkerRegistryInputError();
  }
  return encoded;
}

export function decodeRemoteWorkerRegistryCursor(value: string): RemoteWorkerRegistryCursorV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES
  ) {
    throw new RemoteWorkerRegistryInputError();
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES) throw new Error();
    const normalized = normalizeRemoteWorkerRegistryCursor(JSON.parse(bytes.toString("utf8")) as unknown);
    if (encodeRemoteWorkerRegistryCursor(normalized) !== value) throw new Error();
    return normalized;
  } catch {
    throw new RemoteWorkerRegistryInputError();
  }
}

function projectRegistryItem(record: RemoteWorkerRegistryRecord, observedAt: string): RemoteWorkerRegistryItem {
  const posture = record.control?.action === "quarantine" ? "quarantined" : record.control ? "revoked" : "active";
  return {
    schemaVersion: REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
    workerId: record.admission.workerId,
    admission: {
      value: record.admission,
      authorityClass: "canonical_record",
      owner: "storage.remoteWorkerAdmissions",
      observedAt,
    },
    control: {
      value: record.control ?? null,
      authorityClass: "canonical_record",
      owner: "storage.remoteWorkerAdmissions",
      observedAt,
    },
    posture: {
      value: posture,
      authorityClass: "derived_projection",
      owner: "gateway.remoteWorkers",
      observedAt,
    },
    unavailable: {
      connectionHealth: unavailableTruth("gateway.remoteWorkerListener", observedAt),
      assignments: unavailableTruth("storage.remoteWorkerAssignments", observedAt),
      usageAndCost: unavailableTruth("storage.remoteWorkerUsage", observedAt),
      resourceCell: unavailableTruth("storage.remoteWorkerResourceCells", observedAt),
      artifactAndEffects: unavailableTruth("storage.remoteWorkerArtifacts", observedAt),
    },
  };
}

function unavailableTruth(owner: string, observedAt: string): RemoteWorkerTruth<never> {
  return {
    value: null,
    authorityClass: "unavailable",
    owner,
    observedAt,
    caveat: "Unavailable in the server-only canonical registry read tranche.",
  };
}

function inputIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.normalize("NFKC").trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new RemoteWorkerRegistryInputError();
  }
  return value;
}

function inputCanonicalIdentifier(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.normalize("NFKC").trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new RemoteWorkerRegistryInputError();
  }
  return value;
}

function inputCanonicalText(value: unknown, maximumLength: number): string {
  return inputCanonicalIdentifier(value, maximumLength);
}

function inputCanonicalReasonCode(value: unknown): string {
  const reasonCode = inputCanonicalIdentifier(value, 128);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(reasonCode)) {
    throw new RemoteWorkerRegistryInputError();
  }
  return reasonCode;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inputLimit(
  value: number | undefined,
  defaultLimit: number = REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT,
  maxLimit: number = REMOTE_WORKER_REGISTRY_MAX_LIMIT,
): number {
  const normalized = value ?? defaultLimit;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maxLimit) {
    throw new RemoteWorkerRegistryInputError();
  }
  return normalized;
}

function inputNonNegative(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RemoteWorkerRegistryInputError();
  }
  return normalized;
}

export function encodeRemoteWorkerAssignmentCursor(cursor: RemoteWorkerAssignmentCursorV1): string {
  let normalized: RemoteWorkerAssignmentCursorV1;
  try {
    normalized = normalizeRemoteWorkerAssignmentCursor(cursor);
  } catch {
    throw new RemoteWorkerRegistryInputError();
  }
  const encoded = Buffer.from(canonicalJsonString(normalized), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES) {
    throw new RemoteWorkerRegistryInputError();
  }
  return encoded;
}

export function decodeRemoteWorkerAssignmentCursor(value: string): RemoteWorkerAssignmentCursorV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES
  ) {
    throw new RemoteWorkerRegistryInputError();
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES) throw new Error();
    const normalized = normalizeRemoteWorkerAssignmentCursor(JSON.parse(bytes.toString("utf8")) as unknown);
    if (encodeRemoteWorkerAssignmentCursor(normalized) !== value) throw new Error();
    return normalized;
  } catch {
    throw new RemoteWorkerRegistryInputError();
  }
}

function cursorMatchesQuery(
  cursor: RemoteWorkerAssignmentCursorV1,
  workspaceId: string,
  filters: RemoteWorkerAssignmentFilters,
): boolean {
  return (
    cursor.workspaceId === workspaceId &&
    cursor.workerId === (filters.workerId ?? null) &&
    cursor.sessionId === (filters.sessionId ?? null) &&
    cursor.turnId === (filters.turnId ?? null)
  );
}

function canonicalTruth<T>(value: T | null, observedAt: string): RemoteWorkerTruth<T> {
  return { value, authorityClass: "canonical_record", owner: ASSIGNMENTS_OWNER, observedAt };
}

function derived<T>(value: T, observedAt: string): RemoteWorkerTruth<T> {
  return { value, authorityClass: "derived_projection", owner: GATEWAY_OWNER, observedAt };
}

function derivedNull(observedAt: string): RemoteWorkerTruth<never> {
  return { value: null, authorityClass: "derived_projection", owner: GATEWAY_OWNER, observedAt };
}

function projectAssignment(
  aggregate: RemoteWorkerAssignmentAggregate,
  observedAt: string,
  now: string,
): RemoteWorkerAssignmentProjection {
  const { assignment, generation, lease, control, settlement, materialization } = aggregate;
  const leaseFresh = lease ? lease.expiresAt > now : false;
  const phase: RemoteWorkerAssignmentPhase = settlement
    ? "settled"
    : control
      ? "cancelling"
      : lease
        ? leaseFresh
          ? "leased"
          : "lease_expired"
        : "created";
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION,
    assignmentId: assignment.assignmentId,
    lineage: canonicalTruth(
      {
        registryWorkspaceId: assignment.registryWorkspaceId,
        assignmentId: assignment.assignmentId,
        sessionId: assignment.manifest.sessionId ?? null,
        turnId: assignment.manifest.turnId ?? null,
        durableRunId: assignment.manifest.durableRunId,
        createdAt: assignment.createdAt,
      },
      observedAt,
    ),
    identity: canonicalTruth(
      generation
        ? {
            assignmentGeneration: generation.assignmentGeneration,
            workerId: generation.workerId,
            workerGeneration: generation.workerGeneration,
            nodeId: generation.nodeId,
            startedAt: generation.startedAt,
          }
        : null,
      observedAt,
    ),
    lease: canonicalTruth(
      lease
        ? {
            assignmentGeneration: lease.assignmentGeneration,
            leaseRevision: lease.leaseRevision,
            workerSentThrough: lease.workerSentThrough,
            serverAcknowledgedThrough: lease.serverAcknowledgedThrough,
            heartbeatAt: lease.heartbeatAt,
            expiresAt: lease.expiresAt,
          }
        : null,
      observedAt,
    ),
    leaseFreshness: lease
      ? derived({ fresh: leaseFresh, expiresAt: lease.expiresAt }, observedAt)
      : derivedNull(observedAt),
    control: canonicalTruth(
      control
        ? {
            assignmentGeneration: control.expectedAssignmentGeneration,
            controlRevision: control.controlRevision,
            action: control.action,
            createdAt: control.createdAt,
          }
        : null,
      observedAt,
    ),
    settlement: canonicalTruth(
      settlement
        ? {
            assignmentGeneration: settlement.assignmentGeneration,
            outcome: settlement.outcome,
            origin: settlement.origin,
            finalEventSequence: settlement.finalEventSequence,
            settledAt: settlement.settledAt,
          }
        : null,
      observedAt,
    ),
    materialization: canonicalTruth(
      materialization.count > 0 && materialization.latestMaterializedAt !== undefined
        ? {
            count: materialization.count,
            chatTranscriptCount: materialization.chatTranscriptCount,
            durableRunResultCount: materialization.durableRunResultCount,
            latestMaterializedAt: materialization.latestMaterializedAt,
          }
        : null,
      observedAt,
    ),
    phase: derived(phase, observedAt),
    unavailable: {
      usageAndCost: unavailableTruth("storage.remoteWorkerUsage", observedAt),
      resourceCell: unavailableTruth("storage.remoteWorkerResourceCells", observedAt),
      artifactAndEffects: unavailableTruth("storage.remoteWorkerArtifacts", observedAt),
    },
  };
}

function reconcileAdmissionControl(worker: RemoteWorkerRegistryRecord): RemoteWorkerReconciliationObservation {
  const generation = worker.admission.workerGeneration;
  if (!worker.control) {
    return { status: "consistent", summary: `Generation ${generation} admitted with no containment control.` };
  }
  const consistent = worker.control.workerGeneration === generation;
  const action = worker.control.action === "quarantine" ? "quarantined" : "revoked";
  return {
    status: consistent ? "consistent" : "divergent",
    summary: consistent
      ? `Generation ${generation} ${action} at control revision ${worker.control.controlRevision}.`
      : `Control targets generation ${worker.control.workerGeneration}; current admission is generation ${generation}.`,
  };
}

function reconcileAssignmentLease(
  aggregates: readonly RemoteWorkerAssignmentAggregate[],
  now: string,
): RemoteWorkerReconciliationObservation {
  if (aggregates.length === 0) {
    return { status: "empty", summary: "No assignments reference this worker generation." };
  }
  const expired = aggregates.filter((a) => a.lease && !a.settlement && a.lease.expiresAt <= now).length;
  const fresh = aggregates.filter((a) => a.lease && !a.settlement && a.lease.expiresAt > now).length;
  return {
    status: expired > 0 ? "divergent" : "consistent",
    summary: `${aggregates.length} assignment(s): ${fresh} with a fresh lease, ${expired} with an expired unsettled lease.`,
  };
}

function reconcileSettlementMaterialization(
  aggregates: readonly RemoteWorkerAssignmentAggregate[],
): RemoteWorkerReconciliationObservation {
  const settled = aggregates.filter((a) => a.settlement).length;
  if (settled === 0) {
    return { status: "empty", summary: "No settlements are recorded for this worker's assignments." };
  }
  const materialized = aggregates.filter((a) => a.settlement && a.materialization.count > 0).length;
  return {
    status: materialized < settled ? "divergent" : "consistent",
    summary: `${settled} settled assignment(s); ${materialized} carry recorded materialization receipts.`,
  };
}
