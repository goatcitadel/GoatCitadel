import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  canonicalJsonString,
  normalizeExternalSourceCatalogListInput,
  normalizeExternalSourceCreateInput,
  normalizeExternalSourceScanInput,
  normalizeExternalSourceUpdateInput,
  projectExternalSourceSummary,
  type ExternalSourceAdapterId,
  type ExternalSourceAuthActorSource,
  type ExternalSourceCatalogListInput,
  type ExternalSourceCreateInput,
  type ExternalSourceDetailResponse,
  type ExternalSourceListResponse,
  type ExternalSourcePage,
  type ExternalSourceRecord,
  type ExternalSourceScanInput,
  type ExternalSourceScanRecord,
  type ExternalSourceUpdateInput,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
  type WorkspaceRecord,
} from "@goatcitadel/contracts";
import { sealExternalSourceRecord } from "@goatcitadel/storage";
import { EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION } from "./external-source-adapters/internal.js";
import {
  EXTERNAL_SOURCE_ADAPTER_BINDINGS,
  EXTERNAL_SOURCE_FROZEN_COMPATIBILITY_VERSIONS,
} from "./external-source-adapters/types.js";
import {
  ExternalSourceReaderError,
  NodeExternalSourceReadOnlyFilesystem,
  computeExternalSourceFilesystemIdentity,
  type ExternalSourceFilesystemStat,
  type ExternalSourceIdentityResolver,
  type ExternalSourceReadOnlyFilesystem,
} from "./external-source-reader.js";
import { ExternalSourceScanServiceError, type ExternalSourceScanService } from "./external-source-scan-service.js";

export type ExternalSourceServiceErrorCode =
  | "cancelled"
  | "conflict"
  | "identity_drift"
  | "invalid_cursor"
  | "limit_exceeded"
  | "not_found"
  | "repository_failure"
  | "source_not_active"
  | "unsupported_producer_version";

const SERVICE_ERROR_MESSAGES: Readonly<Record<ExternalSourceServiceErrorCode, string>> = Object.freeze({
  cancelled: "External source operation was cancelled.",
  conflict: "External source state changed; refresh and retry.",
  identity_drift: "External source identity no longer matches its verified binding.",
  invalid_cursor: "External source catalog cursor is invalid.",
  limit_exceeded: "External source workspace reached a frozen hard limit.",
  not_found: "External source was not found.",
  repository_failure: "External source persistence failed.",
  source_not_active: "External source is not active.",
  unsupported_producer_version: "External source producer version is not fixture-authorized.",
});

export class ExternalSourceServiceError extends Error {
  public constructor(public readonly code: ExternalSourceServiceErrorCode) {
    super(SERVICE_ERROR_MESSAGES[code]);
    this.name = "ExternalSourceServiceError";
  }
}

export interface ExternalSourceRequestActor {
  actorId: string;
  source: Extract<ExternalSourceAuthActorSource, "token" | "basic" | "loopback">;
}

export interface ExternalSourceConfigRepositoryPort {
  createForActiveWorkspace(
    record: ExternalSourceRecord,
    expectedWorkspaceRevision: number,
    activeRootLimit: number,
  ): ExternalSourceRecord;
  updateCas(record: ExternalSourceRecord, expectedRevision: number, activeRootLimit: number): ExternalSourceRecord;
  find(workspaceId: string, sourceId: string): ExternalSourceRecord | undefined;
  get(workspaceId: string, sourceId: string): ExternalSourceRecord;
  listByWorkspace(workspaceId: string, limit?: number): ExternalSourceRecord[];
  listByWorkspaceActor(
    workspaceId: string,
    ownerActorId: string,
    authActorId: string,
    authActorSource: ExternalSourceRequestActor["source"],
    limit?: number,
  ): ExternalSourceRecord[];
}

export interface ExternalSourceScanRepositoryPort {
  listScans(workspaceId: string, sourceId: string, limit?: number): ExternalSourceScanRecord[];
  listPage(input: {
    workspaceId: string;
    sourceId: string;
    scanId: string;
    dispositions?: ExternalSourceCatalogListInput["dispositions"];
    cursor?: string;
    limit?: number;
  }): ExternalSourcePage;
}

export interface ExternalSourcePathSnapshotRepositoryPort {
  find(snapshotId: string): WorkspacePathBridgeSnapshotRecord | undefined;
}

export interface ExternalSourcePathVerifierPort {
  resolve(
    request: WorkspacePathBridgeResolveRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspacePathBridgeSnapshotRecord>;
}

export interface ExternalSourceWorkspaceRepositoryPort {
  find(workspaceId: string): WorkspaceRecord | undefined;
}

export interface ExternalSourceRootInspectorPort {
  inspect(canonicalRootPath: string, signal: AbortSignal): Promise<{ rootIdentitySha256: string }>;
}

export interface ExternalSourceServiceClock {
  now(): Date;
}

export interface ExternalSourceServiceIdFactory {
  createSourceId(): string;
}

export interface ExternalSourceCompatibilityRegistryPort {
  allowedProducerVersions(adapterId: ExternalSourceAdapterId): readonly string[];
}

export interface ExternalSourceServiceDependencies {
  configs: ExternalSourceConfigRepositoryPort;
  scans: ExternalSourceScanRepositoryPort;
  pathSnapshots: ExternalSourcePathSnapshotRepositoryPort;
  pathVerifier: ExternalSourcePathVerifierPort;
  workspaces: ExternalSourceWorkspaceRepositoryPort;
  scanner: Pick<ExternalSourceScanService, "scan">;
  rootInspector?: ExternalSourceRootInspectorPort;
  clock?: ExternalSourceServiceClock;
  ids?: ExternalSourceServiceIdFactory;
  compatibility?: ExternalSourceCompatibilityRegistryPort;
}

const DEFAULT_CLOCK: ExternalSourceServiceClock = Object.freeze({ now: () => new Date() });
const DEFAULT_IDS: ExternalSourceServiceIdFactory = Object.freeze({
  createSourceId: () => `external-source-${randomUUID()}`,
});
const DEFAULT_COMPATIBILITY: ExternalSourceCompatibilityRegistryPort = Object.freeze({
  allowedProducerVersions: (adapterId: ExternalSourceAdapterId) =>
    EXTERNAL_SOURCE_FROZEN_COMPATIBILITY_VERSIONS[adapterId],
});
type ExternalSourceRecordDraft = Omit<ExternalSourceRecord, "configSha256">;

export class ExternalSourceService {
  private readonly rootInspector: ExternalSourceRootInspectorPort;
  private readonly clock: ExternalSourceServiceClock;
  private readonly ids: ExternalSourceServiceIdFactory;
  private readonly compatibility: ExternalSourceCompatibilityRegistryPort;
  private readonly workspaceQueues = new Map<string, Promise<void>>();

  public constructor(private readonly dependencies: ExternalSourceServiceDependencies) {
    if (
      !dependencies.configs ||
      !dependencies.scans ||
      !dependencies.pathSnapshots ||
      !dependencies.pathVerifier ||
      !dependencies.workspaces ||
      !dependencies.scanner
    ) {
      throw new TypeError("External source service dependencies are required.");
    }
    this.rootInspector = dependencies.rootInspector ?? new NodeExternalSourceRootInspector();
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.ids = dependencies.ids ?? DEFAULT_IDS;
    this.compatibility = dependencies.compatibility ?? DEFAULT_COMPATIBILITY;
  }

  public async create(
    rawInput: ExternalSourceCreateInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceDetailResponse> {
    assertRequestActor(actor);
    const input = normalizeExternalSourceCreateInput(rawInput);
    assertSignal(signal);
    return this.withWorkspaceQueue(input.workspaceId, async () => {
      assertLive(signal);
      this.requireActiveWorkspace(input.workspaceId, input.expectedWorkspaceRevision);
      const adapterId = adapterIdForKind(input.kind);
      this.assertFixtureAuthorizedVersions(adapterId, input.acceptedProducerVersions);
      const snapshot = await this.requireCurrentSnapshot(input, signal);
      let inspected: { rootIdentitySha256: string };
      try {
        inspected = await this.rootInspector.inspect(input.canonicalRootPath, signal);
      } catch (error) {
        throw normalizeServiceFailure(error, signal, "identity_drift");
      }
      assertLive(signal);
      const sourceId = this.ids.createSourceId();
      assertServerIdentifier(sourceId);
      const timestamp = this.clock.now().toISOString();
      const draft: ExternalSourceRecordDraft = {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        sourceId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        label: input.label,
        ownerActorId: actor.actorId,
        authActorId: actor.actorId,
        authActorSource: actor.source,
        canonicalRootPath: input.canonicalRootPath,
        rootIdentitySha256: inspected.rootIdentitySha256,
        pathBridgeSnapshotId: snapshot.snapshotId,
        pathBridgeSnapshotSha256: snapshot.snapshotSha256,
        allowedRootsSha256: snapshot.allowedRootsHash,
        inputFlavor: snapshot.inputFlavor,
        targetFlavor: snapshot.targetFlavor,
        ...(snapshot.distro ? { distro: snapshot.distro } : {}),
        requireGitIdentity: snapshot.gitIdentityRequired,
        ...(snapshot.gitIdentity.identitySha256 ? { gitIdentitySha256: snapshot.gitIdentity.identitySha256 } : {}),
        ownershipAttestationSha256: serverOwnershipAttestation({
          workspaceId: input.workspaceId,
          workspaceRevision: input.expectedWorkspaceRevision,
          actor,
          snapshotSha256: snapshot.snapshotSha256,
          rootIdentitySha256: inspected.rootIdentitySha256,
        }),
        adapterId,
        adapterVersion: EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION,
        adapterPolicy: fixedAdapterPolicy(input.acceptedProducerVersions),
        revision: 1,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const record = sealExternalSourceRecord(draft);
      try {
        const stored = this.dependencies.configs.createForActiveWorkspace(
          record,
          input.expectedWorkspaceRevision,
          EXTERNAL_SOURCE_LIMITS.activeRootsPerWorkspace,
        );
        return detail(stored);
      } catch (error) {
        throw normalizeServiceFailure(error, signal, "repository_failure");
      }
    });
  }

  public list(workspaceId: string, actor: ExternalSourceRequestActor): ExternalSourceListResponse {
    assertRequestActor(actor);
    assertServerIdentifier(workspaceId);
    this.requireActiveWorkspace(workspaceId);
    let records: ExternalSourceRecord[];
    try {
      records = this.dependencies.configs.listByWorkspaceActor(
        workspaceId,
        actor.actorId,
        actor.actorId,
        actor.source,
        100,
      );
    } catch (error) {
      throw normalizeServiceFailure(error, undefined, "repository_failure");
    }
    return {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId,
      items: records.map((source) => projectExternalSourceSummary(source, this.latestScan(source))),
    };
  }

  public get(workspaceId: string, sourceId: string, actor: ExternalSourceRequestActor): ExternalSourceDetailResponse {
    const source = this.requireOwnedSource(workspaceId, sourceId, actor);
    return detail(source, this.latestScan(source));
  }

  public async update(
    sourceId: string,
    rawInput: ExternalSourceUpdateInput,
    actor: ExternalSourceRequestActor,
  ): Promise<ExternalSourceDetailResponse> {
    assertRequestActor(actor);
    const input = normalizeExternalSourceUpdateInput(rawInput);
    return this.withWorkspaceQueue(input.workspaceId, async () => {
      const current = this.requireOwnedSource(input.workspaceId, sourceId, actor);
      if (current.revision !== input.expectedRevision) throw new ExternalSourceServiceError("conflict");
      if (current.status === "revoked") throw new ExternalSourceServiceError("conflict");
      const updatedAt = nextTimestamp(current.updatedAt, this.clock.now());
      const acceptedProducerVersions = input.acceptedProducerVersions ?? current.adapterPolicy.acceptedProducerVersions;
      this.assertFixtureAuthorizedVersions(current.adapterId, acceptedProducerVersions);
      const updated = sealExternalSourceRecord({
        ...withoutConfigHash(current),
        label: input.label ?? current.label,
        status: input.status ?? current.status,
        adapterVersion: EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION,
        adapterPolicy: fixedAdapterPolicy(acceptedProducerVersions),
        revision: current.revision + 1,
        updatedAt,
      });
      let stored: ExternalSourceRecord;
      try {
        stored = this.dependencies.configs.updateCas(
          updated,
          input.expectedRevision,
          EXTERNAL_SOURCE_LIMITS.activeRootsPerWorkspace,
        );
      } catch (error) {
        throw normalizeServiceFailure(error, undefined, "repository_failure");
      }
      let latestScan: ExternalSourceScanRecord | undefined;
      try {
        latestScan = this.latestScan(stored);
      } catch {
        // The CAS commit is authoritative. Optional list projection failure
        // cannot turn a successful mutation into an apparent retryable write.
      }
      return detail(stored, latestScan);
    });
  }

  public async scan(
    sourceId: string,
    rawInput: ExternalSourceScanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceScanRecord> {
    assertRequestActor(actor);
    const input = normalizeExternalSourceScanInput(rawInput);
    const source = this.requireOwnedSource(input.workspaceId, sourceId, actor);
    if (source.status !== "active") throw new ExternalSourceServiceError("source_not_active");
    if (source.revision !== input.expectedRevision) throw new ExternalSourceServiceError("conflict");
    assertSignal(signal);
    try {
      return await this.dependencies.scanner.scan({
        workspaceId: input.workspaceId,
        sourceId,
        expectedConfigRevision: input.expectedRevision,
        signal,
      });
    } catch (error) {
      if (error instanceof ExternalSourceScanServiceError) {
        switch (error.code) {
          case "cancelled":
            throw new ExternalSourceServiceError("cancelled");
          case "source_not_active":
            throw new ExternalSourceServiceError("source_not_active");
          case "source_binding_invalid":
            throw new ExternalSourceServiceError("identity_drift");
          case "source_revision_conflict":
            throw new ExternalSourceServiceError("conflict");
          case "invalid_scan_id":
          case "repository_failure":
            throw new ExternalSourceServiceError("repository_failure");
        }
      }
      throw normalizeServiceFailure(error, signal, "repository_failure");
    }
  }

  public listCatalog(
    sourceId: string,
    rawInput: ExternalSourceCatalogListInput,
    actor: ExternalSourceRequestActor,
  ): ExternalSourcePage {
    assertRequestActor(actor);
    const input = normalizeExternalSourceCatalogListInput(rawInput);
    this.requireOwnedSource(input.workspaceId, sourceId, actor);
    try {
      return this.dependencies.scans.listPage({
        workspaceId: input.workspaceId,
        sourceId,
        scanId: input.scanId,
        ...(input.dispositions ? { dispositions: input.dispositions } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });
    } catch (error) {
      throw normalizeServiceFailure(
        error,
        undefined,
        isExternalSourceCursorFailure(error) ? "invalid_cursor" : "repository_failure",
      );
    }
  }

  private async requireCurrentSnapshot(
    input: ExternalSourceCreateInput,
    signal: AbortSignal,
  ): Promise<WorkspacePathBridgeSnapshotRecord> {
    let snapshot: WorkspacePathBridgeSnapshotRecord | undefined;
    try {
      snapshot = this.dependencies.pathSnapshots.find(input.pathBridgeSnapshotId);
    } catch (error) {
      throw normalizeServiceFailure(error, undefined, "repository_failure");
    }
    if (!snapshot || !matchesCreateSnapshot(snapshot, input)) {
      throw new ExternalSourceServiceError("identity_drift");
    }
    let current: WorkspacePathBridgeSnapshotRecord;
    try {
      current = await this.dependencies.pathVerifier.resolve(pathVerificationRequestForInput(input), { signal });
    } catch (error) {
      throw normalizeServiceFailure(error, signal, "identity_drift");
    }
    assertLive(signal);
    if (canonicalJsonString(current) !== canonicalJsonString(snapshot) || !matchesCreateSnapshot(current, input)) {
      throw new ExternalSourceServiceError("identity_drift");
    }
    return current;
  }

  private requireOwnedSource(
    workspaceId: string,
    sourceId: string,
    actor: ExternalSourceRequestActor,
  ): ExternalSourceRecord {
    assertRequestActor(actor);
    assertServerIdentifier(workspaceId);
    assertServerIdentifier(sourceId);
    this.requireActiveWorkspace(workspaceId);
    let source: ExternalSourceRecord | undefined;
    try {
      source = this.dependencies.configs.find(workspaceId, sourceId);
    } catch (error) {
      throw normalizeServiceFailure(error, undefined, "repository_failure");
    }
    if (!source || !isOwnedBy(source, actor)) throw new ExternalSourceServiceError("not_found");
    return source;
  }

  private requireActiveWorkspace(workspaceId: string, expectedRevision?: number): void {
    let workspace: WorkspaceRecord | undefined;
    try {
      workspace = this.dependencies.workspaces.find(workspaceId);
    } catch (error) {
      throw normalizeServiceFailure(error, undefined, "repository_failure");
    }
    if (!workspace || workspace.lifecycleStatus !== "active") throw new ExternalSourceServiceError("not_found");
    if (expectedRevision !== undefined && workspace.revision !== expectedRevision) {
      throw new ExternalSourceServiceError("conflict");
    }
  }

  private latestScan(source: ExternalSourceRecord): ExternalSourceScanRecord | undefined {
    try {
      return this.dependencies.scans.listScans(source.workspaceId, source.sourceId, 1)[0];
    } catch (error) {
      throw normalizeServiceFailure(error, undefined, "repository_failure");
    }
  }

  private assertFixtureAuthorizedVersions(adapterId: ExternalSourceAdapterId, requested: readonly string[]): void {
    let allowed: readonly string[];
    try {
      allowed = this.compatibility.allowedProducerVersions(adapterId);
    } catch {
      throw new ExternalSourceServiceError("unsupported_producer_version");
    }
    if (
      !Array.isArray(allowed) ||
      allowed.length < 1 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some(
        (version) =>
          typeof version !== "string" ||
          !version ||
          version !== version.normalize("NFKC").trim() ||
          version.length > 128 ||
          containsAsciiControlCharacter(version),
      )
    ) {
      throw new ExternalSourceServiceError("unsupported_producer_version");
    }
    const allowedSet = new Set(allowed);
    if (requested.some((version) => !allowedSet.has(version))) {
      throw new ExternalSourceServiceError("unsupported_producer_version");
    }
  }

  private async withWorkspaceQueue<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.workspaceQueues.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => current);
    this.workspaceQueues.set(workspaceId, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceQueues.get(workspaceId) === tail) this.workspaceQueues.delete(workspaceId);
    }
  }
}

export class StorageExternalSourceIdentityResolver implements ExternalSourceIdentityResolver {
  public constructor(
    private readonly dependencies: {
      configs: Pick<ExternalSourceConfigRepositoryPort, "find">;
      pathSnapshots: ExternalSourcePathSnapshotRepositoryPort;
      pathVerifier: ExternalSourcePathVerifierPort;
    },
  ) {}

  public async resolveCurrent(input: {
    workspaceId: string;
    sourceId: string;
    signal: AbortSignal;
  }): Promise<{ source: ExternalSourceRecord; snapshot: WorkspacePathBridgeSnapshotRecord } | undefined> {
    assertLive(input.signal);
    const source = this.dependencies.configs.find(input.workspaceId, input.sourceId);
    if (!source || source.status !== "active") return undefined;
    const snapshot = this.dependencies.pathSnapshots.find(source.pathBridgeSnapshotId);
    if (!snapshot) return undefined;
    let current: WorkspacePathBridgeSnapshotRecord;
    try {
      current = await this.dependencies.pathVerifier.resolve(pathVerificationRequestForSource(source), {
        signal: input.signal,
      });
    } catch {
      if (input.signal.aborted) throw new ExternalSourceServiceError("cancelled");
      throw new ExternalSourceReaderError("identity_drift");
    }
    assertLive(input.signal);
    if (canonicalJsonString(current) !== canonicalJsonString(snapshot)) {
      throw new ExternalSourceReaderError("identity_drift");
    }
    return { source, snapshot: current };
  }
}

export class NodeExternalSourceRootInspector implements ExternalSourceRootInspectorPort {
  private readonly filesystem: ExternalSourceReadOnlyFilesystem;

  public constructor(filesystem?: ExternalSourceReadOnlyFilesystem) {
    this.filesystem = filesystem ?? new NodeExternalSourceReadOnlyFilesystem();
  }

  public async inspect(canonicalRootPath: string, signal: AbortSignal): Promise<{ rootIdentitySha256: string }> {
    assertSignal(signal);
    assertLive(signal);
    const resolved = path.resolve(canonicalRootPath);
    if (!sameCanonicalPath(resolved, canonicalRootPath)) throw new ExternalSourceReaderError("identity_drift");
    const stat = await this.filesystem.lstat(canonicalRootPath, signal);
    assertSafeRoot(stat);
    const realpath = await this.filesystem.realpath(canonicalRootPath, signal);
    if (!sameCanonicalPath(realpath, canonicalRootPath)) throw new ExternalSourceReaderError("identity_drift");
    assertLive(signal);
    return { rootIdentitySha256: computeExternalSourceFilesystemIdentity(stat) };
  }
}

function adapterIdForKind(kind: ExternalSourceCreateInput["kind"]): ExternalSourceAdapterId {
  const found = Object.entries(EXTERNAL_SOURCE_ADAPTER_BINDINGS).find(([, sourceKind]) => sourceKind === kind)?.[0];
  if (!found) throw new ExternalSourceServiceError("identity_drift");
  return found as ExternalSourceAdapterId;
}

function fixedAdapterPolicy(acceptedProducerVersions: readonly string[]) {
  return {
    unknownVariantDisposition: "block" as const,
    followLinks: false as const,
    followMarkdownImports: false as const,
    retainRawBytes: false as const,
    acceptedProducerVersions: [...acceptedProducerVersions].sort(),
  };
}

function serverOwnershipAttestation(input: {
  workspaceId: string;
  workspaceRevision: number;
  actor: ExternalSourceRequestActor;
  snapshotSha256: string;
  rootIdentitySha256: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        kind: "server_verified_in_jail",
        workspaceId: input.workspaceId,
        workspaceRevision: input.workspaceRevision,
        actorId: input.actor.actorId,
        authActorSource: input.actor.source,
        snapshotSha256: input.snapshotSha256,
        rootIdentitySha256: input.rootIdentitySha256,
        approvalRequired: false,
      }),
      "utf8",
    )
    .digest("hex");
}

function detail(source: ExternalSourceRecord, latestScan?: ExternalSourceScanRecord): ExternalSourceDetailResponse {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    source,
    ...(latestScan ? { latestScan: projectExternalSourceSummary(source, latestScan).latestScan } : {}),
  };
}

function withoutConfigHash(source: ExternalSourceRecord): ExternalSourceRecordDraft {
  const { configSha256: _configSha256, ...draft } = source;
  return draft;
}

function isOwnedBy(source: ExternalSourceRecord, actor: ExternalSourceRequestActor): boolean {
  return (
    source.ownerActorId === actor.actorId &&
    source.authActorId === actor.actorId &&
    source.authActorSource === actor.source
  );
}

function assertRequestActor(actor: ExternalSourceRequestActor): void {
  if (
    !actor ||
    !["token", "basic", "loopback"].includes(actor.source) ||
    typeof actor.actorId !== "string" ||
    actor.actorId !== actor.actorId.normalize("NFKC").trim() ||
    actor.actorId === "anonymous" ||
    actor.actorId === "auth:none" ||
    actor.actorId.length < 1 ||
    actor.actorId.length > 256 ||
    containsAsciiControlCharacter(actor.actorId)
  ) {
    throw new ExternalSourceServiceError("not_found");
  }
}

function assertSignal(signal: AbortSignal): void {
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    throw new TypeError("External source operation requires an AbortSignal.");
  }
}

function assertLive(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceServiceError("cancelled");
}

function assertServerIdentifier(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFKC").trim() ||
    value.length > 256 ||
    containsAsciiControlCharacter(value)
  ) {
    throw new ExternalSourceServiceError("not_found");
  }
}

function assertSafeRoot(stat: ExternalSourceFilesystemStat): void {
  if (stat.kind !== "directory" || stat.symbolicLink || stat.reparsePoint) {
    throw new ExternalSourceReaderError("unsafe_path");
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path
      .resolve(value)
      .replace(/[\\/]+$/u, "")
      .normalize("NFKC");
    return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  };
  return normalize(left) === normalize(right);
}

function matchesCreateSnapshot(snapshot: WorkspacePathBridgeSnapshotRecord, input: ExternalSourceCreateInput): boolean {
  const gitIdentitySha256 =
    snapshot.gitIdentity.status === "verified" ? snapshot.gitIdentity.identitySha256 : undefined;
  return (
    snapshot.workspaceId === input.workspaceId &&
    snapshot.status === "verified" &&
    snapshot.callable === true &&
    snapshot.snapshotSha256 === input.pathBridgeSnapshotSha256 &&
    snapshot.canonicalHostPath === input.canonicalRootPath &&
    snapshot.inputFlavor === input.inputFlavor &&
    snapshot.targetFlavor === input.targetFlavor &&
    snapshot.distro === input.distro &&
    snapshot.gitIdentityRequired === input.requireGitIdentity &&
    gitIdentitySha256 === input.gitIdentitySha256
  );
}

function pathVerificationRequestForInput(input: ExternalSourceCreateInput): WorkspacePathBridgeResolveRequest {
  return {
    verificationId: input.pathBridgeSnapshotId,
    workspaceId: input.workspaceId,
    inputPath: input.canonicalRootPath,
    inputFlavor: input.inputFlavor,
    targetFlavor: input.targetFlavor,
    requireGitIdentity: input.requireGitIdentity,
    ...(input.distro ? { distro: input.distro } : {}),
    ...(input.gitIdentitySha256 ? { expectedGitIdentitySha256: input.gitIdentitySha256 } : {}),
  };
}

function pathVerificationRequestForSource(source: ExternalSourceRecord): WorkspacePathBridgeResolveRequest {
  return {
    verificationId: source.pathBridgeSnapshotId,
    workspaceId: source.workspaceId,
    inputPath: source.canonicalRootPath,
    inputFlavor: source.inputFlavor,
    targetFlavor: source.targetFlavor,
    requireGitIdentity: source.requireGitIdentity,
    ...(source.distro ? { distro: source.distro } : {}),
    ...(source.gitIdentitySha256 ? { expectedGitIdentitySha256: source.gitIdentitySha256 } : {}),
  };
}

function nextTimestamp(previous: string, now: Date): string {
  const next = Math.max(Date.parse(previous) + 1, now.getTime());
  return new Date(next).toISOString();
}

function normalizeServiceFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: ExternalSourceServiceErrorCode,
): ExternalSourceServiceError {
  if (error instanceof ExternalSourceServiceError) return error;
  if (signal?.aborted) return new ExternalSourceServiceError("cancelled");
  if (error instanceof ExternalSourceReaderError) {
    if (error.code === "cancelled") return new ExternalSourceServiceError("cancelled");
    if (error.code === "limit_exceeded") return new ExternalSourceServiceError("limit_exceeded");
    return new ExternalSourceServiceError("identity_drift");
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "STATE_CONFLICT" &&
      "details" in error &&
      (error as { details?: { reason?: unknown } }).details?.reason === "active_root_limit"
    ) {
      return new ExternalSourceServiceError("limit_exceeded");
    }
    if (code === "ENTITY_NOT_FOUND") return new ExternalSourceServiceError("not_found");
    if (code === "ALREADY_EXISTS" || code === "STATE_CONFLICT" || code === "WRITE_CONFLICT") {
      return new ExternalSourceServiceError("conflict");
    }
  }
  return new ExternalSourceServiceError(fallback);
}

function isExternalSourceCursorFailure(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    "code" in error &&
    (error as TypeError & { code?: unknown }).code === "INVALID_EXTERNAL_SOURCE_CURSOR"
  );
}

export function externalSourceDetailCanonicalMaterial(detailValue: ExternalSourceDetailResponse): string {
  return canonicalJsonString(detailValue);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
