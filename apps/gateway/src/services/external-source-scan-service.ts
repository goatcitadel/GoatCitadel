import { createHash, randomUUID } from "node:crypto";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  canonicalJsonString,
  type ExternalSourceCatalogDisposition,
  type ExternalSourceCatalogItem,
  type ExternalSourceRecord,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import {
  sealExternalSourceCatalogItem,
  sealExternalSourceScanRecord,
  verifyExternalSourceRecord,
} from "@goatcitadel/storage";
import { claudeMemoryExternalSourceAdapter } from "./external-source-adapters/claude-memory-adapter.js";
import { claudeSessionExternalSourceAdapter } from "./external-source-adapters/claude-session-adapter.js";
import { codexMemoryExternalSourceAdapter } from "./external-source-adapters/codex-memory-adapter.js";
import { codexRolloutExternalSourceAdapter } from "./external-source-adapters/codex-rollout-adapter.js";
import {
  ExternalSourceAdapterError,
  type ExternalSourceAdapterErrorCode,
  type ExternalSourceAdapterReasonCode,
} from "./external-source-adapters/internal.js";
import {
  ExternalSourceAdapterRegistry,
  ExternalSourceAdapterRegistryError,
  EXTERNAL_SOURCE_FROZEN_COMPATIBILITY_VERSIONS,
  externalSourceAdapterPolicyView,
  type ExternalSourceAdapter,
  type ExternalSourceAdapterInspection,
  type ExternalSourceAdapterRegistryErrorCode,
} from "./external-source-adapters/types.js";
import {
  ExternalSourceReaderError,
  type ExternalSourceEnumeratedFile,
  type ExternalSourceReadResult,
  type ExternalSourceReaderErrorCode,
  type ExternalSourceReaderPort,
} from "./external-source-reader.js";

export type ExternalSourceScanServiceErrorCode =
  | "cancelled"
  | "invalid_scan_id"
  | "repository_failure"
  | "source_binding_invalid"
  | "source_not_active"
  | "source_revision_conflict";

const ERROR_MESSAGES: Readonly<Record<ExternalSourceScanServiceErrorCode, string>> = Object.freeze({
  cancelled: "External source scan was cancelled.",
  invalid_scan_id: "External source scan identity is invalid.",
  repository_failure: "External source scan repository sealing failed.",
  source_binding_invalid: "External source scan configuration binding is invalid.",
  source_not_active: "External source is not active.",
  source_revision_conflict: "External source revision does not match the scan request.",
});

export class ExternalSourceScanServiceError extends Error {
  public constructor(public readonly code: ExternalSourceScanServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceScanServiceError";
  }
}

export interface ExternalSourceConfigReadPort {
  get(workspaceId: string, sourceId: string): Promise<ExternalSourceRecord>;
}

export interface ExternalSourceScanWritePort {
  seal(scan: ExternalSourceScanRecord, items: readonly ExternalSourceCatalogItem[]): Promise<ExternalSourceScanRecord>;
}

export interface ExternalSourceScanClock {
  nowMs(): number;
}

export interface ExternalSourceScanScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ExternalSourceScanIdFactory {
  createScanId(): string;
}

export interface ExternalSourceScanServiceDependencies {
  configs: ExternalSourceConfigReadPort;
  scans: ExternalSourceScanWritePort;
  reader: ExternalSourceReaderPort;
  clock?: ExternalSourceScanClock;
  scheduler?: ExternalSourceScanScheduler;
  ids?: ExternalSourceScanIdFactory;
}

interface ObservedFileEvidence extends ExternalSourceEnumeratedFile {
  rawSha256: string;
}

interface InspectedObservation {
  file: ObservedFileEvidence;
  inspection: ExternalSourceAdapterInspection;
  inspectionCanonical: string;
}

interface ScanPhaseResult {
  examinedEntryCount: number;
  items: ExternalSourceCatalogItem[];
}

interface ScanTerminalDraft {
  blockerCodes: string[];
  examinedEntryCount: number;
  items: ExternalSourceCatalogItem[];
  status: "blocked" | "sealed";
}

class ExternalSourceScanBlockerError extends Error {
  public constructor(public readonly code: "alias_path_limit") {
    super("External source scan was blocked by a hard limit.");
    this.name = "ExternalSourceScanBlockerError";
  }
}

const DEFAULT_CLOCK: ExternalSourceScanClock = Object.freeze({ nowMs: () => Date.now() });
const DEFAULT_SCHEDULER: ExternalSourceScanScheduler = Object.freeze({
  schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
const DEFAULT_IDS: ExternalSourceScanIdFactory = Object.freeze({
  createScanId: () => `external-scan-${randomUUID()}`,
});
const UTF8 = new TextEncoder();
const READER_ERROR_CODES = new Set<ExternalSourceReaderErrorCode>([
  "cancelled",
  "cycle_detected",
  "filesystem_error",
  "identity_drift",
  "invalid_path",
  "limit_exceeded",
  "not_found",
  "not_regular_file",
  "outside_jail",
  "source_changed",
  "unsafe_path",
]);
const ADAPTER_REASON_CODES = new Set<ExternalSourceAdapterReasonCode>([
  "conflicting_session_identity",
  "corrupt_jsonl",
  "duplicate_id_conflict",
  "invalid_policy",
  "invalid_utf8",
  "jsonl_line_limit",
  "lineage_cycle",
  "lineage_depth_limit",
  "lineage_missing_parent",
  "lineage_node_limit",
  "markdown_item_limit",
  "message_count_limit",
  "missing_session_identity",
  "normalized_artifact_limit",
  "normalized_message_limit",
  "source_file_limit",
  "source_integrity_mismatch",
  "unknown_envelope_type",
  "unknown_field_shape",
  "unknown_record_type",
  "unrecognized_path",
  "unsupported_producer_version",
]);
const ADAPTER_ERROR_CODES = new Set<ExternalSourceAdapterErrorCode>([
  "cancelled",
  "catalog_mismatch",
  "invalid_signal",
  "unsupported_item",
  ...ADAPTER_REASON_CODES,
]);
const REGISTRY_ERROR_CODES = new Set<ExternalSourceAdapterRegistryErrorCode>([
  "duplicate_adapter",
  "incomplete_registry",
  "invalid_adapter",
  "kind_mismatch",
  "missing_adapter",
  "version_mismatch",
]);

export function createFixedExternalSourceAdapterRegistry(): ExternalSourceAdapterRegistry {
  return new ExternalSourceAdapterRegistry([
    codexRolloutExternalSourceAdapter,
    codexMemoryExternalSourceAdapter,
    claudeSessionExternalSourceAdapter,
    claudeMemoryExternalSourceAdapter,
  ]);
}

export class ExternalSourceScanService {
  private readonly registry: ExternalSourceAdapterRegistry;
  private readonly clock: ExternalSourceScanClock;
  private readonly scheduler: ExternalSourceScanScheduler;
  private readonly ids: ExternalSourceScanIdFactory;

  public constructor(private readonly dependencies: ExternalSourceScanServiceDependencies) {
    if (!dependencies.configs || !dependencies.scans || !dependencies.reader) {
      throw new TypeError("External source scan service dependencies are required.");
    }
    this.registry = createFixedExternalSourceAdapterRegistry();
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.scheduler = dependencies.scheduler ?? DEFAULT_SCHEDULER;
    this.ids = dependencies.ids ?? DEFAULT_IDS;
  }

  public async scan(input: {
    workspaceId: string;
    sourceId: string;
    expectedConfigRevision: number;
    signal: AbortSignal;
  }): Promise<ExternalSourceScanRecord> {
    assertAbortSignal(input.signal);
    if (!Number.isSafeInteger(input.expectedConfigRevision) || input.expectedConfigRevision < 1) {
      throw new ExternalSourceScanServiceError("source_revision_conflict");
    }
    if (input.signal.aborted) throw new ExternalSourceScanServiceError("cancelled");
    const startedAtMs = this.clock.nowMs();
    const startedAt = toIso(startedAtMs);
    const controller = new AbortController();
    let timedOut = false;
    let resolveInterruption!: (reason: "cancelled" | "timeout") => void;
    const interruption = new Promise<"cancelled" | "timeout">((resolve) => {
      resolveInterruption = resolve;
    });
    const forwardCancellation = () => {
      controller.abort(new ExternalSourceScanServiceError("cancelled"));
      resolveInterruption("cancelled");
    };
    input.signal.addEventListener("abort", forwardCancellation, { once: true });
    let timeoutHandle: unknown;
    let timeoutScheduled = false;
    try {
      timeoutHandle = this.scheduler.schedule(() => {
        timedOut = true;
        controller.abort(new ExternalSourceReaderError("cancelled"));
        resolveInterruption("timeout");
      }, EXTERNAL_SOURCE_LIMITS.scanWallTimeMs);
      timeoutScheduled = true;
      if (input.signal.aborted) forwardCancellation();

      let source: ExternalSourceRecord;
      try {
        source = await this.readSourceSnapshot(input.workspaceId, input.sourceId);
      } catch (error) {
        if (input.signal.aborted) throw new ExternalSourceScanServiceError("cancelled");
        throw error;
      }
      if (source.workspaceId !== input.workspaceId || source.sourceId !== input.sourceId) {
        throw new ExternalSourceScanServiceError("source_binding_invalid");
      }
      if (source.revision !== input.expectedConfigRevision) {
        throw new ExternalSourceScanServiceError("source_revision_conflict");
      }
      if (source.status !== "active") throw new ExternalSourceScanServiceError("source_not_active");
      const scanId = this.ids.createScanId();
      assertScanId(scanId);

      let examinedEntryCount = 0;
      let terminal: ScanTerminalDraft;
      if (timedOut || this.deadlineExpired(startedAtMs)) {
        timedOut = true;
        controller.abort(new ExternalSourceReaderError("cancelled"));
        terminal = timeoutTerminal(examinedEntryCount);
      } else {
        const phase = this.runScanPhase(source, scanId, controller.signal, (count) => {
          examinedEntryCount = count;
        }).then(
          (value) => ({ kind: "success" as const, value }),
          (error: unknown) => ({ error, kind: "failure" as const }),
        );
        const outcome = await Promise.race([
          phase,
          interruption.then((reason) =>
            reason === "cancelled" ? ({ kind: "cancelled" } as const) : ({ kind: "timeout" } as const),
          ),
        ]);
        if (input.signal.aborted || outcome.kind === "cancelled") {
          throw new ExternalSourceScanServiceError("cancelled");
        }
        if (timedOut || outcome.kind === "timeout" || this.deadlineExpired(startedAtMs)) {
          timedOut = true;
          controller.abort(new ExternalSourceReaderError("cancelled"));
          terminal = timeoutTerminal(examinedEntryCount);
        } else if (outcome.kind === "failure") {
          if (isCancellationError(outcome.error)) throw new ExternalSourceScanServiceError("cancelled");
          terminal = {
            blockerCodes: [blockerCodeFor(outcome.error)],
            examinedEntryCount,
            items: [],
            status: "blocked",
          };
        } else {
          terminal = {
            blockerCodes: [],
            examinedEntryCount: outcome.value.examinedEntryCount,
            items: outcome.value.items,
            status: "sealed",
          };
        }
      }

      if (input.signal.aborted) throw new ExternalSourceScanServiceError("cancelled");
      if (timedOut || this.deadlineExpired(startedAtMs)) terminal = timeoutTerminal(terminal.examinedEntryCount);
      await this.assertCurrentSourceBinding(source, input.expectedConfigRevision);
      if (input.signal.aborted) throw new ExternalSourceScanServiceError("cancelled");
      if (timedOut || this.deadlineExpired(startedAtMs)) terminal = timeoutTerminal(terminal.examinedEntryCount);

      const completedAtMs = this.currentClockMs(startedAtMs);
      if (completedAtMs >= startedAtMs + EXTERNAL_SOURCE_LIMITS.scanWallTimeMs) {
        terminal = timeoutTerminal(terminal.examinedEntryCount);
      }
      const scan = sealExternalSourceScanRecord(
        {
          schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
          scanId,
          workspaceId: source.workspaceId,
          sourceId: source.sourceId,
          configRevision: source.revision,
          configSha256: source.configSha256,
          rootIdentitySha256: source.rootIdentitySha256,
          pathBridgeSnapshotSha256: source.pathBridgeSnapshotSha256,
          adapterId: source.adapterId,
          adapterVersion: source.adapterVersion,
          examinedEntryCount: terminal.examinedEntryCount,
          blockerCodes: terminal.blockerCodes,
          status: terminal.status,
          startedAt,
          completedAt: toIso(Math.min(completedAtMs, startedAtMs + EXTERNAL_SOURCE_LIMITS.scanWallTimeMs)),
        },
        terminal.items,
      );
      if (input.signal.aborted) throw new ExternalSourceScanServiceError("cancelled");
      sealRepositoryBundle(scan, terminal.items);
      const expectedScanCanonical = canonicalJsonString(scan);
      const expectedItemsCanonical = canonicalJsonString(terminal.items);
      try {
        const stored = await this.dependencies.scans.seal(scan, terminal.items);
        if (
          canonicalJsonString(scan) !== expectedScanCanonical ||
          canonicalJsonString(terminal.items) !== expectedItemsCanonical ||
          canonicalJsonString(stored) !== expectedScanCanonical
        ) {
          throw new ExternalSourceScanServiceError("repository_failure");
        }
        return scan;
      } catch (error) {
        if (isSourceRevisionConflict(error)) {
          throw new ExternalSourceScanServiceError("source_revision_conflict");
        }
        throw new ExternalSourceScanServiceError("repository_failure");
      }
    } finally {
      if (timeoutScheduled) {
        try {
          this.scheduler.cancel(timeoutHandle);
        } catch {
          // Cleanup failure must not alter an already sealed terminal result.
        }
      }
      input.signal.removeEventListener("abort", forwardCancellation);
      controller.abort(new ExternalSourceScanServiceError("cancelled"));
    }
  }

  private async runScanPhase(
    source: ExternalSourceRecord,
    scanId: string,
    signal: AbortSignal,
    onEnumerated: (count: number) => void,
  ): Promise<ScanPhaseResult> {
    assertOperationLive(signal);
    const adapter = this.registry.requireForSource(source);
    const policy = externalSourceAdapterPolicyView(source);
    const enumeration = immutableEnumerationSnapshot(await this.dependencies.reader.enumerate({ source, signal }));
    assertOperationLive(signal);
    onEnumerated(enumeration.examinedEntryCount);
    const candidates = selectRecognizedFiles(adapter, enumeration.files);
    const observations = await this.inspectCandidates({ adapter, policy, source, candidates, signal });
    assertOperationLive(signal);
    return {
      examinedEntryCount: enumeration.examinedEntryCount,
      items: foldCatalogObservations(source, scanId, observations),
    };
  }

  private async readSourceSnapshot(workspaceId: string, sourceId: string): Promise<ExternalSourceRecord> {
    try {
      return immutableSourceSnapshot(await this.dependencies.configs.get(workspaceId, sourceId));
    } catch (error) {
      if (error instanceof ExternalSourceScanServiceError) throw error;
      throw new ExternalSourceScanServiceError("source_binding_invalid");
    }
  }

  private async assertCurrentSourceBinding(
    expected: ExternalSourceRecord,
    expectedConfigRevision: number,
  ): Promise<void> {
    const current = await this.readSourceSnapshot(expected.workspaceId, expected.sourceId);
    if (current.status !== "active") throw new ExternalSourceScanServiceError("source_not_active");
    if (current.revision !== expectedConfigRevision) {
      throw new ExternalSourceScanServiceError("source_revision_conflict");
    }
    if (canonicalJsonString(current) !== canonicalJsonString(expected)) {
      throw new ExternalSourceScanServiceError("source_binding_invalid");
    }
  }

  private async inspectCandidates(input: {
    adapter: ExternalSourceAdapter;
    policy: ReturnType<typeof externalSourceAdapterPolicyView>;
    source: ExternalSourceRecord;
    candidates: readonly ExternalSourceEnumeratedFile[];
    signal: AbortSignal;
  }): Promise<InspectedObservation[]> {
    const observations = new Array<InspectedObservation>(input.candidates.length);
    const errors = new Map<number, unknown>();
    let cursor = 0;
    let halted = false;

    const worker = async (): Promise<void> => {
      while (!halted) {
        assertOperationLive(input.signal);
        const index = cursor;
        cursor += 1;
        if (index >= input.candidates.length) return;
        try {
          const candidate = input.candidates[index];
          if (!candidate) throw new Error("External source scan candidate is missing.");
          const read = await this.dependencies.reader.readFile({
            source: input.source,
            relativePath: candidate.relativePath,
            signal: input.signal,
          });
          assertOperationLive(input.signal);
          const file = immutableReadSnapshot(candidate, read);
          const inspected = await input.adapter.inspect({ policy: input.policy, file, signal: input.signal });
          assertOperationLive(input.signal);
          assertReadSnapshotIntegrity(candidate, file);
          const inspection = immutableInspectionSnapshot(inspected);
          observations[index] = {
            file: withoutRawBytes(file),
            inspection,
            inspectionCanonical: canonicalJsonString(inspection),
          };
        } catch (error) {
          errors.set(index, error);
          halted = true;
        }
      }
    };

    const workerCount = Math.min(EXTERNAL_SOURCE_LIMITS.concurrentFileReads, input.candidates.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    const firstError = [...errors.entries()].sort(([left], [right]) => left - right)[0]?.[1];
    if (firstError !== undefined) throw firstError;
    for (let index = 0; index < observations.length; index += 1) {
      if (!observations[index]) {
        throw new Error("External source scan inspection did not produce a complete result set.");
      }
    }
    return observations;
  }

  private currentClockMs(startedAtMs: number): number {
    const currentMs = this.clock.nowMs();
    if (!Number.isFinite(currentMs) || currentMs < startedAtMs) {
      throw new TypeError("External source scan clock returned an invalid value.");
    }
    return currentMs;
  }

  private deadlineExpired(startedAtMs: number): boolean {
    const nowMs = this.clock.nowMs();
    if (!Number.isFinite(nowMs) || nowMs < startedAtMs) {
      throw new TypeError("External source scan clock returned an invalid value.");
    }
    return nowMs >= startedAtMs + EXTERNAL_SOURCE_LIMITS.scanWallTimeMs;
  }
}

function immutableEnumerationSnapshot(enumeration: {
  examinedEntryCount: number;
  files: readonly ExternalSourceEnumeratedFile[];
}): Readonly<{ examinedEntryCount: number; files: readonly ExternalSourceEnumeratedFile[] }> {
  const files = enumeration?.files;
  const examinedEntryCount = enumeration?.examinedEntryCount;
  if (
    !enumeration ||
    !Array.isArray(files) ||
    !Number.isSafeInteger(examinedEntryCount) ||
    examinedEntryCount < files.length ||
    examinedEntryCount > EXTERNAL_SOURCE_LIMITS.directoryEntriesPerScan ||
    files.length > EXTERNAL_SOURCE_LIMITS.directoryEntriesPerScan
  ) {
    throw new ExternalSourceReaderError("limit_exceeded");
  }
  const fileCount = files.length;
  const snapshots: ExternalSourceEnumeratedFile[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    if (!Object.hasOwn(files, index)) throw new ExternalSourceReaderError("source_changed");
    snapshots.push(immutableEnumeratedFile(files[index]!));
  }
  if (files.length !== fileCount) throw new ExternalSourceReaderError("source_changed");
  Object.freeze(snapshots);
  return Object.freeze({ examinedEntryCount, files: snapshots });
}

function selectRecognizedFiles(
  adapter: ExternalSourceAdapter,
  files: readonly ExternalSourceEnumeratedFile[],
): ExternalSourceEnumeratedFile[] {
  const seenPaths = new Set<string>();
  return files
    .filter((file) => {
      if (seenPaths.has(file.relativePath)) throw new ExternalSourceReaderError("source_changed");
      seenPaths.add(file.relativePath);
      return adapter.recognizes(file.relativePath) === true;
    })
    .sort((left, right) => compareCanonicalPaths(left.relativePath, right.relativePath));
}

function foldCatalogObservations(
  source: ExternalSourceRecord,
  scanId: string,
  observations: readonly InspectedObservation[],
): ExternalSourceCatalogItem[] {
  const byForeignId = new Map<string, InspectedObservation[]>();
  for (const observation of observations) {
    const group = byForeignId.get(observation.inspection.foreignIdSha256) ?? [];
    group.push(observation);
    byForeignId.set(observation.inspection.foreignIdSha256, group);
  }

  const items: ExternalSourceCatalogItem[] = [];
  for (const [foreignIdSha256, foreignGroup] of [...byForeignId.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const byRawSha256 = new Map<string, InspectedObservation[]>();
    for (const observation of foreignGroup) {
      const variants = byRawSha256.get(observation.file.rawSha256) ?? [];
      variants.push(observation);
      byRawSha256.set(observation.file.rawSha256, variants);
    }
    const conflictingForeignIdentity = byRawSha256.size > 1;
    for (const [rawSha256, variantGroup] of [...byRawSha256.entries()].sort(([left], [right]) =>
      compareText(left, right),
    )) {
      const sorted = [...variantGroup].sort((left, right) =>
        compareCanonicalPaths(left.file.relativePath, right.file.relativePath),
      );
      const canonical = sorted[0];
      if (!canonical) throw new Error("External source alias group is empty.");
      const aliasRelativePaths = sorted
        .slice(1)
        .map((entry) => entry.file.relativePath)
        .sort(compareText);
      if (aliasRelativePaths.length > 32) throw new ExternalSourceScanBlockerError("alias_path_limit");

      const inspectionMismatch = sorted.some((entry) => entry.inspectionCanonical !== canonical.inspectionCanonical);
      const forceConflict = conflictingForeignIdentity || inspectionMismatch;
      const reasonCodes = forceConflict
        ? sortedReasonCodes([...canonical.inspection.reasonCodes, "duplicate_id_conflict"])
        : sortedReasonCodes(canonical.inspection.reasonCodes);
      const disposition: ExternalSourceCatalogDisposition = forceConflict
        ? "conflicting"
        : canonical.inspection.disposition;

      items.push(
        sealExternalSourceCatalogItem({
          schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
          workspaceId: source.workspaceId,
          sourceId: source.sourceId,
          scanId,
          itemId: deriveCatalogItemId(source.adapterId, foreignIdSha256, rawSha256),
          adapterId: source.adapterId,
          adapterVersion: source.adapterVersion,
          normalizedRelativePath: canonical.file.relativePath,
          aliasRelativePaths,
          foreignIdSha256,
          ...(canonical.inspection.producerVersion === undefined
            ? {}
            : { producerVersion: canonical.inspection.producerVersion }),
          observedMtimeNs: canonical.file.observedMtimeNs,
          fileIdentitySha256: canonical.file.filesystemIdentitySha256,
          statFingerprintSha256: canonical.file.statFingerprintSha256,
          rawSha256: canonical.file.rawSha256,
          rawByteCount: canonical.file.byteCount,
          messageCount: canonical.inspection.messageCount,
          lineageNodeCount: canonical.inspection.lineageNodeCount,
          lineageDepth: canonical.inspection.lineageDepth,
          lineageSha256: canonical.inspection.lineageSha256,
          disposition,
          reasonCodes,
        }),
      );
      if (items.length > EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan) {
        throw new ExternalSourceReaderError("limit_exceeded");
      }
    }
  }
  return items;
}

function compareCanonicalPaths(left: string, right: string): number {
  const rankDelta = pathRank(left) - pathRank(right);
  return rankDelta === 0 ? compareText(left, right) : rankDelta;
}

function pathRank(relativePath: string): number {
  return relativePath.startsWith("archived_sessions/") ? 1 : 0;
}

function deriveCatalogItemId(adapterId: string, foreignIdSha256: string, rawSha256: string): string {
  const material = canonicalJsonString({ adapterId, foreignIdSha256, rawSha256 });
  return `external-item-${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

function sortedReasonCodes(reasonCodes: readonly (string | ExternalSourceAdapterReasonCode)[]): string[] {
  return [...new Set(reasonCodes)].sort(compareText);
}

function assertEnumeratedFileBinding(candidate: ExternalSourceEnumeratedFile, file: ExternalSourceReadResult): void {
  if (
    candidate.relativePath !== file.relativePath ||
    candidate.byteCount !== file.byteCount ||
    candidate.observedMtimeNs !== file.observedMtimeNs ||
    candidate.filesystemIdentitySha256 !== file.filesystemIdentitySha256 ||
    candidate.statFingerprintSha256 !== file.statFingerprintSha256
  ) {
    throw new ExternalSourceReaderError("source_changed");
  }
}

function immutableSourceSnapshot(source: ExternalSourceRecord): ExternalSourceRecord {
  verifyExternalSourceRecord(source);
  const frozenProducerVersions = new Set<string>(EXTERNAL_SOURCE_FROZEN_COMPATIBILITY_VERSIONS[source.adapterId]);
  if (
    hasSparseEntries(source.adapterPolicy.acceptedProducerVersions) ||
    source.adapterPolicy.acceptedProducerVersions.some((version) => !frozenProducerVersions.has(version))
  ) {
    throw new ExternalSourceScanServiceError("source_binding_invalid");
  }
  const acceptedProducerVersions = [...source.adapterPolicy.acceptedProducerVersions];
  const adapterPolicy = { ...source.adapterPolicy, acceptedProducerVersions };
  const snapshot: ExternalSourceRecord = { ...source, adapterPolicy };
  Object.freeze(acceptedProducerVersions);
  Object.freeze(adapterPolicy);
  Object.freeze(snapshot);
  verifyExternalSourceRecord(snapshot);
  return snapshot;
}

function immutableEnumeratedFile(file: ExternalSourceEnumeratedFile): ExternalSourceEnumeratedFile {
  if (!file || typeof file !== "object") throw new ExternalSourceReaderError("source_changed");
  const snapshot: ExternalSourceEnumeratedFile = {
    byteCount: file.byteCount,
    filesystemIdentitySha256: file.filesystemIdentitySha256,
    observedMtimeNs: file.observedMtimeNs,
    relativePath: file.relativePath,
    statFingerprintSha256: file.statFingerprintSha256,
  };
  assertEnumeratedFileShape(snapshot);
  return Object.freeze(snapshot);
}

function immutableReadSnapshot(
  candidate: ExternalSourceEnumeratedFile,
  file: ExternalSourceReadResult,
): ExternalSourceReadResult {
  if (!file || typeof file !== "object") throw new ExternalSourceReaderError("source_changed");
  const sourceBytes = file.bytes;
  if (!(sourceBytes instanceof Uint8Array)) throw new ExternalSourceReaderError("source_changed");
  const bytes = sourceBytes.slice();
  const rawSha256 = file.rawSha256;
  const snapshot: ExternalSourceReadResult = {
    ...immutableEnumeratedFile(file),
    bytes,
    rawSha256,
  };
  assertReadSnapshotIntegrity(candidate, snapshot);
  return Object.freeze(snapshot);
}

function assertReadSnapshotIntegrity(candidate: ExternalSourceEnumeratedFile, file: ExternalSourceReadResult): void {
  assertEnumeratedFileBinding(candidate, file);
  if (
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength !== file.byteCount ||
    !isSha256(file.rawSha256) ||
    createHash("sha256").update(file.bytes).digest("hex") !== file.rawSha256
  ) {
    throw new ExternalSourceReaderError("source_changed");
  }
}

function withoutRawBytes(file: ExternalSourceReadResult): ObservedFileEvidence {
  return Object.freeze({
    byteCount: file.byteCount,
    filesystemIdentitySha256: file.filesystemIdentitySha256,
    observedMtimeNs: file.observedMtimeNs,
    rawSha256: file.rawSha256,
    relativePath: file.relativePath,
    statFingerprintSha256: file.statFingerprintSha256,
  });
}

function immutableInspectionSnapshot(inspection: ExternalSourceAdapterInspection): ExternalSourceAdapterInspection {
  const allowedKeys = new Set([
    "disposition",
    "foreignIdSha256",
    "lineageDepth",
    "lineageNodeCount",
    "lineageSha256",
    "messageCount",
    "producerVersion",
    "reasonCodes",
  ]);
  if (
    !inspection ||
    typeof inspection !== "object" ||
    Object.keys(inspection).some((key) => !allowedKeys.has(key)) ||
    !isSha256(inspection.foreignIdSha256) ||
    !isSha256(inspection.lineageSha256) ||
    !isBoundedCount(inspection.messageCount, EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem) ||
    !isBoundedCount(inspection.lineageNodeCount, EXTERNAL_SOURCE_LIMITS.lineageNodes) ||
    !isBoundedCount(inspection.lineageDepth, EXTERNAL_SOURCE_LIMITS.lineageDepth) ||
    !["blocked", "conflicting", "quarantined", "supported", "unsupported_variant"].includes(inspection.disposition) ||
    (inspection.producerVersion !== undefined && !isBoundedText(inspection.producerVersion, 128)) ||
    !isCanonicalReasonCodeList(inspection.reasonCodes) ||
    (inspection.disposition === "supported" && inspection.reasonCodes.length > 0)
  ) {
    throw new ExternalSourceAdapterError("catalog_mismatch");
  }
  const reasonCodes = Object.freeze([...inspection.reasonCodes]);
  const snapshot: ExternalSourceAdapterInspection = {
    disposition: inspection.disposition,
    foreignIdSha256: inspection.foreignIdSha256,
    lineageDepth: inspection.lineageDepth,
    lineageNodeCount: inspection.lineageNodeCount,
    lineageSha256: inspection.lineageSha256,
    messageCount: inspection.messageCount,
    ...(inspection.producerVersion === undefined ? {} : { producerVersion: inspection.producerVersion }),
    reasonCodes,
  };
  return Object.freeze(snapshot);
}

function assertEnumeratedFileShape(file: ExternalSourceEnumeratedFile): void {
  if (
    !file ||
    typeof file !== "object" ||
    !isStrictCatalogPath(file.relativePath) ||
    !isBoundedCount(file.byteCount, EXTERNAL_SOURCE_LIMITS.sourceFileBytes) ||
    !/^\d{20}$/u.test(file.observedMtimeNs) ||
    !isSha256(file.filesystemIdentitySha256) ||
    !isSha256(file.statFingerprintSha256)
  ) {
    throw new ExternalSourceReaderError("source_changed");
  }
}

function isStrictCatalogPath(relativePath: string): boolean {
  const segments = typeof relativePath === "string" ? relativePath.split("/") : [];
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    UTF8.encode(relativePath).byteLength <= EXTERNAL_SOURCE_LIMITS.rootPathBytes &&
    relativePath === relativePath.normalize("NFKC") &&
    !relativePath.includes("\\") &&
    !relativePath.startsWith("/") &&
    !/^[A-Za-z]:/u.test(relativePath) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        UTF8.encode(segment).byteLength <= 255 &&
        segment !== "." &&
        segment !== ".." &&
        !containsAsciiControlCharacter(segment) &&
        !segment.includes(":") &&
        !/[. ]$/u.test(segment) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    )
  );
}

function isBoundedCount(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isBoundedText(value: string, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    value === value.normalize("NFKC") &&
    !containsAsciiControlCharacter(value)
  );
}

function isCanonicalReasonCodeList(value: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length > 64 || hasSparseEntries(value)) return false;
  return (
    value.every((code) => isBoundedText(code, 128)) &&
    value.every((code) => ADAPTER_REASON_CODES.has(code as ExternalSourceAdapterReasonCode)) &&
    new Set(value).size === value.length &&
    value.every((code, index) => index === 0 || compareText(code, value[index - 1]!) >= 0)
  );
}

function hasSparseEntries(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return true;
  }
  return false;
}

function sealRepositoryBundle(scan: ExternalSourceScanRecord, items: readonly ExternalSourceCatalogItem[]): void {
  Object.freeze(scan.blockerCodes);
  if (scan.highWater) Object.freeze(scan.highWater);
  Object.freeze(scan);
  for (const item of items) {
    Object.freeze(item.aliasRelativePaths);
    Object.freeze(item.reasonCodes);
    Object.freeze(item);
  }
  Object.freeze(items);
}

function isSha256(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function blockerCodeFor(error: unknown): string {
  if (error instanceof ExternalSourceReaderError) {
    return READER_ERROR_CODES.has(error.code) ? error.code : "scan_failed";
  }
  if (error instanceof ExternalSourceAdapterError) {
    return ADAPTER_ERROR_CODES.has(error.code) ? `adapter_${error.code}` : "scan_failed";
  }
  if (error instanceof ExternalSourceAdapterRegistryError) {
    return REGISTRY_ERROR_CODES.has(error.code) ? `adapter_${error.code}` : "scan_failed";
  }
  if (error instanceof ExternalSourceScanBlockerError) return error.code;
  return "scan_failed";
}

function isCancellationError(error: unknown): boolean {
  return (
    (error instanceof ExternalSourceReaderError && error.code === "cancelled") ||
    (error instanceof ExternalSourceAdapterError && error.code === "cancelled")
  );
}

function isSourceRevisionConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "STATE_CONFLICT" ||
      (error as { code?: unknown }).code === "WRITE_CONFLICT") &&
    "details" in error &&
    (error as { details?: { reason?: unknown } }).details?.reason === "source_revision_conflict",
  );
}

function assertOperationLive(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceReaderError("cancelled");
}

function timeoutTerminal(examinedEntryCount: number): ScanTerminalDraft {
  return {
    blockerCodes: ["scan_timeout"],
    examinedEntryCount,
    items: [],
    status: "blocked",
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertAbortSignal(signal: AbortSignal): void {
  if (
    !signal ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("External source scan requires an AbortSignal.");
  }
}

function assertScanId(scanId: string): void {
  if (
    typeof scanId !== "string" ||
    !scanId ||
    scanId !== scanId.trim() ||
    scanId !== scanId.normalize("NFKC") ||
    scanId.length > 256 ||
    containsAsciiControlCharacter(scanId)
  ) {
    throw new ExternalSourceScanServiceError("invalid_scan_id");
  }
}

function toIso(epochMs: number): string {
  if (!Number.isFinite(epochMs)) throw new TypeError("External source scan clock returned an invalid value.");
  return new Date(epochMs).toISOString();
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
