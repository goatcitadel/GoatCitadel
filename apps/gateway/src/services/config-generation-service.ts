/* eslint-disable max-lines -- Config publication and rollback recovery intentionally remain a single transactional owner. */
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AssistantConfigInputSchema,
  BudgetConfigSchema,
  ConflictError,
  LlmConfigFileSchema,
  ToolPolicyConfigSchema,
  ValidationError,
} from "@goatcitadel/contracts";
import type { MeshRuntimeArtifactSnapshot } from "@goatcitadel/storage";

const ACTIVE_CONFIG_FILENAME = "goatcitadel.json";
const GENERATIONS_DIRNAME = ".generations";
const LAST_GOOD_FILENAME = "last-good.json";
const STAGING_DIRNAME = "staging";
const TRANSACTION_FILENAME = "transaction.json";

const SECTION_MIRRORS = [
  ["assistant", "assistant.config.json"],
  ["toolPolicy", "tool-policy.json"],
  ["budgets", "budgets.json"],
  ["llm", "llm-providers.json"],
  ["cronJobs", "cron-jobs.json"],
] as const;

export interface ConfigGenerationMetadata {
  revision: number;
  generationId: string;
  parentGenerationId?: string;
  createdAt: string;
  digest: string;
}

export interface CompleteUnifiedConfigPayload extends Record<string, unknown> {
  version: number;
  assistant: Record<string, unknown>;
  toolPolicy: Record<string, unknown>;
  budgets: Record<string, unknown>;
  llm: Record<string, unknown>;
  cronJobs: Record<string, unknown> | unknown[];
  generation?: ConfigGenerationMetadata;
}

export interface ConfigGenerationCandidate<T> {
  payload: CompleteUnifiedConfigPayload;
  runtime: T;
}

export interface ConfigGenerationCommitInput<T> {
  expectedRevision?: number;
  requireExpectedRevision?: boolean;
  buildCandidate(): ConfigGenerationCandidate<T> | Promise<ConfigGenerationCandidate<T>>;
  captureRuntimeOwnerRecoveryIntent?(
    candidate: T,
  ): ConfigGenerationRuntimeOwnerRecoveryIntent | Promise<ConfigGenerationRuntimeOwnerRecoveryIntent>;
  apply(candidate: T): void | Promise<void>;
  restore(candidate: T): void | Promise<void>;
  previousRuntime: T;
}

export interface ConfigGenerationRuntimeOwnerRecoveryIntent {
  version: 1;
  meshArtifact?: MeshRuntimeArtifactSnapshot;
  providerSecretEffects?: ConfigGenerationProviderSecretEffect[];
}

export interface ConfigGenerationProviderSecretVerification {
  algorithm: "scrypt-v1";
  saltBase64: string;
  digestBase64: string;
}

/**
 * Secret-free receipt for an external provider-secret owner effect. The
 * credential itself is deliberately never written to the config generation
 * marker; set effects carry only a slow, salted verifier so restart recovery
 * can prove that the intended keychain/env value was installed.
 */
export interface ConfigGenerationProviderSecretEffect {
  providerId: string;
  operation: "set" | "delete";
  target: "keychain" | "env";
  envVar?: string;
  verification?: ConfigGenerationProviderSecretVerification;
  previousState: {
    present: boolean;
    verification?: ConfigGenerationProviderSecretVerification;
  };
  /** Exact prior value-state for the durable .env owner, independent of shell precedence. */
  previousEnvFileState?: {
    present: boolean;
    verification?: ConfigGenerationProviderSecretVerification;
  };
}

export interface ConfigGenerationCommitResult {
  revision: number;
  generationId: string;
  mirrorRepairPending: boolean;
}

export interface ConfigGenerationServiceHooks {
  beforePublish?(payload: CompleteUnifiedConfigPayload): void | Promise<void>;
  /** Fault-injection seam that models process death after canonical publish. */
  afterPublish?(payload: CompleteUnifiedConfigPayload): void | Promise<void>;
  /** Fault-injection seam that models process death after the durable forward decision. */
  afterCommitMarker?(payload: CompleteUnifiedConfigPayload): void | Promise<void>;
  /** Fault-injection seam that models process death after owners applied the durable decision. */
  afterOwnerApply?(payload: CompleteUnifiedConfigPayload): void | Promise<void>;
  /** Fault-injection seam that models process death after rollback owners restore but before marker cleanup. */
  afterRollbackOwnerRestore?(payload: CompleteUnifiedConfigPayload): void | Promise<void>;
  /** Fault-injection seam for any durable transaction-marker write. */
  beforeTransactionMarkerWrite?(
    state: ConfigGenerationTransactionMarker["state"],
    payload: CompleteUnifiedConfigPayload,
  ): void | Promise<void>;
  beforeMirrorWrite?(filename: string): void | Promise<void>;
}

interface ConfigGenerationTransactionMarker {
  version: 1;
  state: "pending" | "committed";
  revision: number;
  generationId: string;
  digest: string;
  updatedAt: string;
  runtimeOwnerRecoveryIntent?: ConfigGenerationRuntimeOwnerRecoveryIntent;
  rollbackRuntimeOwnerRecoveryIntent?: ConfigGenerationRuntimeOwnerRecoveryIntent;
}

export interface ConfigGenerationRecoveryResult {
  recovered: boolean;
  revision?: number;
  reason?: string;
}

export type ConfigGenerationRecoveryOutcome =
  | "not_checked"
  | "no_config"
  | "not_needed"
  | "confirmed_generation"
  | "recovered_unconfirmed"
  | "recovered_invalid_active";

export interface ConfigGenerationHealthSnapshot {
  revision: number;
  generationId: string;
  transactionState: "idle" | "pending" | "committed";
  mirrorRepairPending: boolean;
  lastRecovery: {
    outcome: ConfigGenerationRecoveryOutcome;
    recovered: boolean;
    revision?: number;
  };
}

const recoveryOutcomes = new Map<string, ConfigGenerationHealthSnapshot["lastRecovery"]>();

export class ConfigGenerationService {
  private readonly configDir: string;
  private readonly activePath: string;
  private readonly generationsDir: string;
  private readonly lastGoodPath: string;
  private readonly stagingDir: string;
  private readonly transactionPath: string;
  private mutationTail: Promise<void> = Promise.resolve();
  private queuedMutationCount = 0;
  private activePayload: CompleteUnifiedConfigPayload;
  private mirrorRepairPending = false;
  private transactionState: ConfigGenerationHealthSnapshot["transactionState"] = "idle";
  private readonly lastRecovery: ConfigGenerationHealthSnapshot["lastRecovery"];
  private runtimeOwnerRecoveryIntent?: ConfigGenerationRuntimeOwnerRecoveryIntent;
  private rollbackRuntimeOwnerRecoveryIntent?: ConfigGenerationRuntimeOwnerRecoveryIntent;

  public constructor(
    rootDir: string,
    initialPayload?: CompleteUnifiedConfigPayload,
    private readonly hooks: ConfigGenerationServiceHooks = {},
  ) {
    this.configDir = path.join(rootDir, "config");
    this.activePath = path.join(this.configDir, ACTIVE_CONFIG_FILENAME);
    this.generationsDir = path.join(this.configDir, GENERATIONS_DIRNAME);
    this.lastGoodPath = path.join(this.generationsDir, LAST_GOOD_FILENAME);
    this.stagingDir = path.join(this.generationsDir, STAGING_DIRNAME);
    this.transactionPath = path.join(this.generationsDir, TRANSACTION_FILENAME);
    this.activePayload = initialPayload ?? readCompleteUnifiedConfigSync(this.activePath);
    assertValidCompleteUnifiedConfig(this.activePayload, this.activePath);
    assertGenerationDigest(this.activePayload, this.activePath);
    const marker = readTransactionMarkerIfExistsSync(this.transactionPath);
    if (marker && transactionMarkerMatchesPayload(marker, this.activePayload)) {
      this.transactionState = marker.state;
      this.runtimeOwnerRecoveryIntent = marker.runtimeOwnerRecoveryIntent
        ? structuredClone(marker.runtimeOwnerRecoveryIntent)
        : undefined;
      this.rollbackRuntimeOwnerRecoveryIntent = marker.rollbackRuntimeOwnerRecoveryIntent
        ? structuredClone(marker.rollbackRuntimeOwnerRecoveryIntent)
        : undefined;
    }
    this.lastRecovery = recoveryOutcomes.get(path.resolve(rootDir)) ?? {
      outcome: "not_checked",
      recovered: false,
    };
  }

  public getRevision(): number {
    return readGenerationRevision(this.activePayload);
  }

  public getGenerationId(): string {
    return this.activePayload.generation?.generationId ?? legacyGenerationId(this.activePayload);
  }

  public getActivePayload(): CompleteUnifiedConfigPayload {
    return structuredClone(this.activePayload);
  }

  public isMirrorRepairPending(): boolean {
    return this.mirrorRepairPending;
  }

  /**
   * A committed marker is a durable forward-recovery decision. Startup must
   * reconcile all runtime owners from the canonical generation before clearing
   * it; retaining the marker makes a second crash repeat that work safely.
   */
  public isRuntimeOwnerReconciliationPending(): boolean {
    return this.transactionState === "committed";
  }

  public getRollbackRuntimeOwnerRecoveryIntent(): ConfigGenerationRuntimeOwnerRecoveryIntent | undefined {
    return this.rollbackRuntimeOwnerRecoveryIntent
      ? structuredClone(this.rollbackRuntimeOwnerRecoveryIntent)
      : undefined;
  }

  public getRuntimeOwnerRecoveryIntent(): ConfigGenerationRuntimeOwnerRecoveryIntent | undefined {
    return this.runtimeOwnerRecoveryIntent ? structuredClone(this.runtimeOwnerRecoveryIntent) : undefined;
  }

  public assertRuntimeReadsReady(): void {
    if (this.queuedMutationCount === 0 && this.transactionState === "idle") {
      return;
    }
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Settings are temporarily unavailable while runtime owners reconcile a config generation.",
      details: {
        currentRevision: this.getRevision(),
        transactionState: this.transactionState,
      },
    });
  }

  public async completeRuntimeOwnerReconciliation(): Promise<void> {
    if (this.transactionState !== "committed") {
      return;
    }
    const marker = await readTransactionMarkerIfExists(this.transactionPath);
    if (!marker || marker.state !== "committed" || !transactionMarkerMatchesPayload(marker, this.activePayload)) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Config generation owner reconciliation no longer matches the canonical generation.",
        details: { currentRevision: this.getRevision() },
      });
    }
    await removePathBestEffort(path.join(this.stagingDir, marker.generationId));
    await this.removeTransactionMarker();
  }

  public getHealthSnapshot(): ConfigGenerationHealthSnapshot {
    return {
      revision: this.getRevision(),
      generationId: this.getGenerationId(),
      transactionState: this.transactionState,
      mirrorRepairPending: this.mirrorRepairPending,
      lastRecovery: structuredClone(this.lastRecovery),
    };
  }

  public commit<T>(input: ConfigGenerationCommitInput<T>): Promise<ConfigGenerationCommitResult> {
    return this.serializeMutation(() => this.commitUnderLock(input));
  }

  /**
   * Compatibility bridge for runtime owners that still mutate before asking
   * the config layer to persist their projection. The bridge does not make
   * those callers transactional, but it does prevent them from erasing the
   * canonical generation/CAS metadata while they are migrated to commit().
   */
  public adoptAlreadyAppliedProjectionSync(candidate: CompleteUnifiedConfigPayload): ConfigGenerationCommitResult {
    if (this.queuedMutationCount > 0 || this.transactionState !== "idle") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "A config generation mutation is already in progress.",
        details: { currentRevision: this.getRevision() },
      });
    }
    assertValidCompleteUnifiedConfig(candidate, "legacy runtime projection");
    const onDisk = readCompleteUnifiedConfigSync(this.activePath);
    assertValidCompleteUnifiedConfig(onDisk, this.activePath);
    assertGenerationDigest(onDisk, this.activePath);
    if (
      readGenerationRevision(onDisk) !== this.getRevision() ||
      (onDisk.generation?.generationId ?? legacyGenerationId(onDisk)) !== this.getGenerationId() ||
      digestUnifiedSections(onDisk) !== digestUnifiedSections(this.activePayload)
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Canonical config changed outside this runtime instance.",
        details: { currentRevision: readGenerationRevision(onDisk) },
      });
    }

    if (digestUnifiedSections(candidate) === digestUnifiedSections(this.activePayload)) {
      this.publishMirrorsSync(this.activePayload);
      this.mirrorRepairPending = false;
      return {
        revision: this.getRevision(),
        generationId: this.getGenerationId(),
        mirrorRepairPending: false,
      };
    }

    const previousPayload = structuredClone(this.activePayload);
    const nextPayload = withNextGeneration(candidate, previousPayload, this.getRevision() + 1);
    assertValidCompleteUnifiedConfig(nextPayload, "legacy adopted config generation");
    assertGenerationDigest(nextPayload, "legacy adopted config generation");
    const generation = nextPayload.generation!;
    let canonicalPublished = false;
    let committedMarkerWritten = false;
    try {
      this.retainLastGoodSync(previousPayload);
      this.writeTransactionMarkerSync("pending", nextPayload);
      this.publishCanonicalSync(nextPayload);
      canonicalPublished = true;
      this.activePayload = nextPayload;
      this.writeTransactionMarkerSync("committed", nextPayload);
      committedMarkerWritten = true;
      this.retainLastGoodSync(nextPayload);
      try {
        this.publishMirrorsSync(nextPayload);
        this.mirrorRepairPending = false;
      } catch {
        this.mirrorRepairPending = true;
      }
      this.removeTransactionMarkerSync();
      return {
        revision: generation.revision,
        generationId: generation.generationId,
        mirrorRepairPending: this.mirrorRepairPending,
      };
    } catch (error) {
      // Before canonical publication there is no durable state to recover. Once
      // published, retain the pending/committed marker so startup recovery can
      // make the correct idempotent decision.
      if (!canonicalPublished) {
        this.removeTransactionMarkerSyncBestEffort();
      } else {
        this.transactionState = committedMarkerWritten ? "committed" : "pending";
      }
      throw error;
    }
  }

  public repairSplitMirrors(): Promise<void> {
    return this.serializeMutation(async () => {
      await this.publishMirrors(this.activePayload);
      this.mirrorRepairPending = false;
    });
  }

  private async commitUnderLock<T>(input: ConfigGenerationCommitInput<T>): Promise<ConfigGenerationCommitResult> {
    if (this.transactionState !== "idle") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Config generation owner reconciliation is still pending.",
        details: {
          currentRevision: this.getRevision(),
          transactionState: this.transactionState,
        },
      });
    }
    const currentRevision = this.getRevision();
    if (input.requireExpectedRevision && input.expectedRevision === undefined) {
      throw new ValidationError({ message: "expectedRevision is required for settings mutations." });
    }
    if (
      input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    ) {
      throw new ValidationError({ message: "expectedRevision must be a positive safe integer." });
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Settings changed after this client loaded them.",
        details: {
          expectedRevision: input.expectedRevision,
          currentRevision,
        },
      });
    }

    const candidate = await input.buildCandidate();
    assertValidCompleteUnifiedConfig(candidate.payload, "settings candidate");
    const previousPayload = structuredClone(this.activePayload);
    const nextPayload = withNextGeneration(candidate.payload, previousPayload, currentRevision + 1);
    assertValidCompleteUnifiedConfig(nextPayload, "staged settings generation");
    assertGenerationDigest(nextPayload, "staged settings generation");

    await fs.mkdir(this.stagingDir, { recursive: true });
    const stagedCanonicalPath = path.join(this.configDir, `.goatcitadel-${nextPayload.generation!.generationId}.tmp`);
    const stagedMirrorDir = path.join(this.stagingDir, nextPayload.generation!.generationId);
    await this.stagePayload(nextPayload, stagedCanonicalPath, stagedMirrorDir);
    await this.retainLastGood(previousPayload);
    await this.writeTransactionMarker("pending", nextPayload);

    try {
      await this.hooks.beforePublish?.(nextPayload);
      await replaceFileAtomically(stagedCanonicalPath, this.activePath);
    } catch (error) {
      await removePathBestEffort(stagedCanonicalPath);
      await removePathBestEffort(stagedMirrorDir);
      await this.removeTransactionMarkerBestEffort();
      throw error;
    }

    this.activePayload = nextPayload;
    await this.hooks.afterPublish?.(nextPayload);

    // The committed marker is the irreversible decision to finish this
    // generation. It must be durable before any owner side effect occurs so a
    // hard crash can only roll back a generation that no owner has observed.
    let runtimeOwnerRecoveryIntent: ConfigGenerationRuntimeOwnerRecoveryIntent | undefined;
    try {
      runtimeOwnerRecoveryIntent = await input.captureRuntimeOwnerRecoveryIntent?.(candidate.runtime);
      await this.writeTransactionMarker("committed", nextPayload, { runtimeOwnerRecoveryIntent });
    } catch (decisionError) {
      const rollbackPayload = withNextGeneration(previousPayload, nextPayload, currentRevision + 2);
      try {
        await this.publishCanonical(rollbackPayload);
        this.activePayload = rollbackPayload;
        await this.writeTransactionMarker("committed", rollbackPayload);
        await this.retainLastGood(rollbackPayload);
        await this.tryPublishMirrors(rollbackPayload);
        await this.removeTransactionMarker();
      } catch (rollbackError) {
        throw new ConfigGenerationRollbackError(decisionError, undefined, rollbackError);
      } finally {
        await removePathBestEffort(stagedMirrorDir);
      }
      throw new ConfigGenerationCommitDecisionError(decisionError, rollbackPayload.generation!.revision);
    }

    await this.hooks.afterCommitMarker?.(nextPayload);
    try {
      await input.apply(candidate.runtime);
    } catch (applyError) {
      const rollbackPayload = withNextGeneration(previousPayload, nextPayload, currentRevision + 2);
      try {
        // The monotonic rollback generation and its committed marker are the
        // durable reverse decision. Establish both before compensating any
        // entered owner so a process death can never expose prior canonical
        // state with candidate owners and no recovery receipt.
        await this.publishCanonical(rollbackPayload);
        this.activePayload = rollbackPayload;
        await this.writeTransactionMarker("committed", rollbackPayload, {
          ...(runtimeOwnerRecoveryIntent ? { rollbackRuntimeOwnerRecoveryIntent: runtimeOwnerRecoveryIntent } : {}),
        });
        await this.retainLastGood(rollbackPayload);
      } catch (rollbackError) {
        await removePathBestEffort(stagedMirrorDir);
        throw new ConfigGenerationRollbackError(applyError, undefined, rollbackError);
      }

      let restoreError: unknown;
      if (!(applyError instanceof RuntimeOwnerApplyAlreadyRestoredError)) {
        try {
          await input.restore(input.previousRuntime);
        } catch (error) {
          restoreError = error;
        }
      }
      if (restoreError !== undefined) {
        await this.tryPublishMirrors(rollbackPayload);
        await removePathBestEffort(stagedMirrorDir);
        // Keep the committed rollback marker. Startup must verify or finish
        // exact owner compensation before it may clear the recovery decision.
        throw new ConfigGenerationRollbackError(applyError, restoreError);
      }

      try {
        await this.hooks.afterRollbackOwnerRestore?.(rollbackPayload);
        await this.tryPublishMirrors(rollbackPayload);
        await this.removeTransactionMarker();
      } catch (rollbackCompletionError) {
        await removePathBestEffort(stagedMirrorDir);
        throw new ConfigGenerationRollbackError(applyError, undefined, rollbackCompletionError);
      }
      await removePathBestEffort(stagedMirrorDir);
      throw new ConfigGenerationApplyError(applyError, rollbackPayload.generation!.revision);
    }

    await this.hooks.afterOwnerApply?.(nextPayload);
    await this.retainLastGood(nextPayload);
    await this.tryPublishMirrors(nextPayload, stagedMirrorDir);
    await removePathBestEffort(stagedMirrorDir);
    await this.removeTransactionMarker();
    return {
      revision: nextPayload.generation!.revision,
      generationId: nextPayload.generation!.generationId,
      mirrorRepairPending: this.mirrorRepairPending,
    };
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedMutationCount += 1;
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.queuedMutationCount -= 1;
    });
  }

  private async stagePayload(
    payload: CompleteUnifiedConfigPayload,
    canonicalPath: string,
    mirrorDir: string,
  ): Promise<void> {
    await writeDurableJson(canonicalPath, payload);
    await fs.mkdir(mirrorDir, { recursive: true });
    for (const [section, filename] of SECTION_MIRRORS) {
      await writeDurableJson(path.join(mirrorDir, filename), payload[section]);
    }
  }

  private async publishCanonical(payload: CompleteUnifiedConfigPayload): Promise<void> {
    const tempPath = path.join(this.configDir, `.goatcitadel-rollback-${randomUUID()}.tmp`);
    await writeDurableJson(tempPath, payload);
    await replaceFileAtomically(tempPath, this.activePath);
  }

  private publishCanonicalSync(payload: CompleteUnifiedConfigPayload): void {
    const tempPath = path.join(this.configDir, `.goatcitadel-legacy-${randomUUID()}.tmp`);
    writeDurableJsonSync(tempPath, payload);
    replaceFileAtomicallySync(tempPath, this.activePath);
  }

  private async retainLastGood(payload: CompleteUnifiedConfigPayload): Promise<void> {
    await fs.mkdir(this.generationsDir, { recursive: true });
    const tempPath = path.join(this.generationsDir, `.last-good-${randomUUID()}.tmp`);
    await writeDurableJson(tempPath, payload);
    await replaceFileAtomically(tempPath, this.lastGoodPath);
  }

  private retainLastGoodSync(payload: CompleteUnifiedConfigPayload): void {
    fsSync.mkdirSync(this.generationsDir, { recursive: true });
    const tempPath = path.join(this.generationsDir, `.last-good-legacy-${randomUUID()}.tmp`);
    writeDurableJsonSync(tempPath, payload);
    replaceFileAtomicallySync(tempPath, this.lastGoodPath);
  }

  private async writeTransactionMarker(
    state: ConfigGenerationTransactionMarker["state"],
    payload: CompleteUnifiedConfigPayload,
    intents: Pick<
      ConfigGenerationTransactionMarker,
      "runtimeOwnerRecoveryIntent" | "rollbackRuntimeOwnerRecoveryIntent"
    > = {},
  ): Promise<void> {
    const generation = payload.generation;
    if (!generation) {
      throw new ValidationError({ message: "Config generation metadata is required for transaction markers." });
    }
    await this.hooks.beforeTransactionMarkerWrite?.(state, payload);
    await fs.mkdir(this.generationsDir, { recursive: true });
    const tempPath = path.join(this.generationsDir, `.transaction-${randomUUID()}.tmp`);
    const marker: ConfigGenerationTransactionMarker = {
      version: 1,
      state,
      revision: generation.revision,
      generationId: generation.generationId,
      digest: generation.digest,
      updatedAt: new Date().toISOString(),
      ...(intents.runtimeOwnerRecoveryIntent
        ? { runtimeOwnerRecoveryIntent: structuredClone(intents.runtimeOwnerRecoveryIntent) }
        : {}),
      ...(intents.rollbackRuntimeOwnerRecoveryIntent
        ? { rollbackRuntimeOwnerRecoveryIntent: structuredClone(intents.rollbackRuntimeOwnerRecoveryIntent) }
        : {}),
    };
    await writeDurableJson(tempPath, marker);
    await replaceFileAtomically(tempPath, this.transactionPath);
    this.transactionState = state;
    this.runtimeOwnerRecoveryIntent = marker.runtimeOwnerRecoveryIntent
      ? structuredClone(marker.runtimeOwnerRecoveryIntent)
      : undefined;
    this.rollbackRuntimeOwnerRecoveryIntent = marker.rollbackRuntimeOwnerRecoveryIntent
      ? structuredClone(marker.rollbackRuntimeOwnerRecoveryIntent)
      : undefined;
  }

  private writeTransactionMarkerSync(
    state: ConfigGenerationTransactionMarker["state"],
    payload: CompleteUnifiedConfigPayload,
  ): void {
    const generation = payload.generation;
    if (!generation) {
      throw new ValidationError({ message: "Config generation metadata is required for transaction markers." });
    }
    fsSync.mkdirSync(this.generationsDir, { recursive: true });
    const tempPath = path.join(this.generationsDir, `.transaction-legacy-${randomUUID()}.tmp`);
    const marker: ConfigGenerationTransactionMarker = {
      version: 1,
      state,
      revision: generation.revision,
      generationId: generation.generationId,
      digest: generation.digest,
      updatedAt: new Date().toISOString(),
    };
    writeDurableJsonSync(tempPath, marker);
    replaceFileAtomicallySync(tempPath, this.transactionPath);
    this.transactionState = state;
    this.runtimeOwnerRecoveryIntent = undefined;
    this.rollbackRuntimeOwnerRecoveryIntent = undefined;
  }

  private async removeTransactionMarker(): Promise<void> {
    await removeFileDurably(this.transactionPath);
    this.transactionState = "idle";
    this.runtimeOwnerRecoveryIntent = undefined;
    this.rollbackRuntimeOwnerRecoveryIntent = undefined;
  }

  private removeTransactionMarkerSync(): void {
    removeFileDurablySync(this.transactionPath);
    this.transactionState = "idle";
    this.runtimeOwnerRecoveryIntent = undefined;
    this.rollbackRuntimeOwnerRecoveryIntent = undefined;
  }

  private removeTransactionMarkerSyncBestEffort(): void {
    try {
      this.removeTransactionMarkerSync();
    } catch {
      // Startup recovery safely ignores a marker that does not match canonical.
      return;
    }
  }

  private async removeTransactionMarkerBestEffort(): Promise<void> {
    try {
      await this.removeTransactionMarker();
    } catch {
      // A stale pending marker is safe: startup compares it to the canonical
      // generation before deciding whether recovery is required.
      return;
    }
  }

  private async tryPublishMirrors(payload: CompleteUnifiedConfigPayload, stagedMirrorDir?: string): Promise<void> {
    try {
      await this.publishMirrors(payload, stagedMirrorDir);
      this.mirrorRepairPending = false;
    } catch {
      // Canonical config is the commit marker. Split JSON is a compatibility
      // projection and is repaired on the next explicit/startup sync.
      this.mirrorRepairPending = true;
    }
  }

  private async publishMirrors(payload: CompleteUnifiedConfigPayload, stagedMirrorDir?: string): Promise<void> {
    for (const [section, filename] of SECTION_MIRRORS) {
      await this.hooks.beforeMirrorWrite?.(filename);
      const stagedPath = stagedMirrorDir ? path.join(stagedMirrorDir, filename) : undefined;
      const tempPath = path.join(this.configDir, `.${filename}-${randomUUID()}.tmp`);
      if (stagedPath && fsSync.existsSync(stagedPath)) {
        await fs.copyFile(stagedPath, tempPath);
      } else {
        await writeDurableJson(tempPath, payload[section]);
      }
      await replaceFileAtomically(tempPath, path.join(this.configDir, filename));
    }
  }

  private publishMirrorsSync(payload: CompleteUnifiedConfigPayload): void {
    for (const [section, filename] of SECTION_MIRRORS) {
      const destination = path.join(this.configDir, filename);
      const tempPath = path.join(this.configDir, `.${filename}-legacy-${randomUUID()}.tmp`);
      writeDurableJsonSync(tempPath, payload[section]);
      replaceFileAtomicallySync(tempPath, destination);
    }
  }
}

export class ConfigGenerationApplyError extends Error {
  public constructor(
    cause: unknown,
    public readonly currentRevision: number,
  ) {
    super("Runtime owner rejected the committed settings generation; the prior generation was restored.", { cause });
    this.name = "ConfigGenerationApplyError";
  }
}

export class ConfigGenerationCommitDecisionError extends Error {
  public constructor(
    cause: unknown,
    public readonly currentRevision: number,
  ) {
    super("The settings generation could not record its durable commit decision; the prior generation was restored.", {
      cause,
    });
    this.name = "ConfigGenerationCommitDecisionError";
  }
}

/**
 * Signals that an atomic owner apply aborted without exposing any effect.
 * The coordinator still publishes a monotonic rollback decision before it
 * skips the unnecessary restore. Do not use this after visible compensation.
 */
export class RuntimeOwnerApplyAlreadyRestoredError extends Error {
  public constructor(cause: unknown) {
    super("Runtime owner apply aborted atomically without a visible owner effect.", { cause });
    this.name = "RuntimeOwnerApplyAlreadyRestoredError";
  }
}

export class ConfigGenerationRollbackError extends Error {
  public constructor(applyError: unknown, restoreError?: unknown, rollbackError?: unknown) {
    super("Settings generation failed and rollback could not be completed safely.", {
      cause: { applyError, restoreError, rollbackError },
    });
    this.name = "ConfigGenerationRollbackError";
  }
}

export async function recoverLastGoodConfigGeneration(rootDir: string): Promise<ConfigGenerationRecoveryResult> {
  const result = await recoverLastGoodConfigGenerationInternal(rootDir);
  recoveryOutcomes.set(path.resolve(rootDir), {
    outcome: classifyRecoveryOutcome(result),
    recovered: result.recovered,
    ...(result.revision !== undefined ? { revision: result.revision } : {}),
  });
  return result;
}

async function recoverLastGoodConfigGenerationInternal(rootDir: string): Promise<ConfigGenerationRecoveryResult> {
  const configDir = path.join(rootDir, "config");
  const activePath = path.join(configDir, ACTIVE_CONFIG_FILENAME);
  const generationsDir = path.join(configDir, GENERATIONS_DIRNAME);
  const lastGoodPath = path.join(generationsDir, LAST_GOOD_FILENAME);
  const transactionPath = path.join(generationsDir, TRANSACTION_FILENAME);
  const marker = await readTransactionMarkerIfExists(transactionPath);
  if (!fsSync.existsSync(activePath) && !marker) {
    return { recovered: false };
  }

  let active: CompleteUnifiedConfigPayload | undefined;
  let activeError: unknown;
  try {
    active = await readCompleteUnifiedConfig(activePath);
    assertValidCompleteUnifiedConfig(active, activePath);
    assertGenerationDigest(active, activePath);
  } catch (error) {
    activeError = error;
  }

  if (marker && active && transactionMarkerMatchesPayload(marker, active)) {
    if (marker.state === "pending") {
      const lastGood = await readValidatedLastGood(lastGoodPath, activeError ?? new Error("Unconfirmed generation"));
      await publishRecoveryPayload(configDir, activePath, lastGood);
      await removeFileDurably(transactionPath);
      return {
        recovered: true,
        revision: readGenerationRevision(lastGood),
        reason: `Recovered unconfirmed config generation ${marker.generationId}.`,
      };
    }

    // The durable decision is to finish this generation. Repair last-good but
    // retain the marker until Gateway startup has idempotently reconciled every
    // runtime owner. A second crash therefore repeats forward recovery instead
    // of losing the decision between config recovery and owner initialization.
    await retainRecoveryLastGood(generationsDir, lastGoodPath, active);
    return {
      recovered: false,
      revision: readGenerationRevision(active),
      reason: `Confirmed config generation ${marker.generationId}.`,
    };
  }

  if (active) {
    if (marker) {
      // The marker can lag a canonical rollback when a process dies after the
      // rollback rename but before its marker replacement. Treat the valid
      // canonical payload as a new forward-reconciliation decision; otherwise
      // stale durable owner projections could be re-promoted on startup.
      let authoritative = active;
      if (!authoritative.generation) {
        authoritative = withNextGeneration(
          authoritative,
          authoritative,
          Math.max(marker.revision, readGenerationRevision(authoritative)) + 1,
        );
        await publishRecoveryPayload(configDir, activePath, authoritative);
      }
      await writeRecoveryTransactionMarker(generationsDir, transactionPath, authoritative, {
        rollbackRuntimeOwnerRecoveryIntent:
          marker.rollbackRuntimeOwnerRecoveryIntent ?? marker.runtimeOwnerRecoveryIntent,
      });
      await retainRecoveryLastGood(generationsDir, lastGoodPath, authoritative);
      return {
        recovered: false,
        revision: readGenerationRevision(authoritative),
        reason: `Confirmed config generation ${authoritative.generation!.generationId} after replacing a stale transaction marker.`,
      };
    }
    return { recovered: false, revision: readGenerationRevision(active) };
  }

  const lastGood = await readValidatedLastGood(lastGoodPath, activeError);
  let recoveryPayload = lastGood;
  if (marker?.state === "committed" && !recoveryPayload.generation) {
    recoveryPayload = withNextGeneration(
      recoveryPayload,
      recoveryPayload,
      Math.max(marker.revision, readGenerationRevision(recoveryPayload)) + 1,
    );
  }
  await publishRecoveryPayload(configDir, activePath, recoveryPayload);
  if (marker?.state === "committed") {
    await writeRecoveryTransactionMarker(generationsDir, transactionPath, recoveryPayload, {
      rollbackRuntimeOwnerRecoveryIntent:
        marker.rollbackRuntimeOwnerRecoveryIntent ?? marker.runtimeOwnerRecoveryIntent,
    });
    await retainRecoveryLastGood(generationsDir, lastGoodPath, recoveryPayload);
  } else if (marker) {
    await removeFileDurably(transactionPath);
  }
  return {
    recovered: true,
    revision: readGenerationRevision(recoveryPayload),
    reason: activeError instanceof Error ? activeError.message : String(activeError),
  };
}

function classifyRecoveryOutcome(result: ConfigGenerationRecoveryResult): ConfigGenerationRecoveryOutcome {
  if (!result.recovered) {
    if (result.reason?.startsWith("Confirmed config generation")) {
      return "confirmed_generation";
    }
    return result.revision === undefined ? "no_config" : "not_needed";
  }
  return result.reason?.startsWith("Recovered unconfirmed config generation")
    ? "recovered_unconfirmed"
    : "recovered_invalid_active";
}

export function assertValidCompleteUnifiedConfig(
  value: unknown,
  source = "unified config",
): asserts value is CompleteUnifiedConfigPayload {
  if (!isRecord(value)) {
    throw new ValidationError({ message: `Complete unified config must be an object: ${source}` });
  }
  for (const section of ["assistant", "toolPolicy", "budgets", "llm", "cronJobs"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, section)) {
      throw new ValidationError({ message: `Complete unified config is missing ${section}: ${source}` });
    }
  }

  parseSection(AssistantConfigInputSchema, value.assistant, "assistant", source);
  parseSection(ToolPolicyConfigSchema, value.toolPolicy, "toolPolicy", source);
  parseSection(BudgetConfigSchema, value.budgets, "budgets", source);
  parseSection(LlmConfigFileSchema, value.llm, "llm", source);
  if (!isRecord(value.cronJobs) && !Array.isArray(value.cronJobs)) {
    throw new ValidationError({ message: `Invalid cronJobs section in ${source}` });
  }
  if (value.generation !== undefined) {
    assertGenerationMetadata(value.generation, source);
  }
}

export function readGenerationRevision(payload: CompleteUnifiedConfigPayload): number {
  const revision = payload.generation?.revision;
  return Number.isSafeInteger(revision) && (revision ?? 0) > 0 ? revision! : 1;
}

function withNextGeneration(
  candidate: CompleteUnifiedConfigPayload,
  parent: CompleteUnifiedConfigPayload,
  revision: number,
): CompleteUnifiedConfigPayload {
  const withoutGeneration = structuredClone(candidate);
  delete withoutGeneration.generation;
  const generationId = randomUUID();
  const parentGenerationId = parent.generation?.generationId ?? legacyGenerationId(parent);
  const digest = digestUnifiedSections(withoutGeneration);
  return {
    ...withoutGeneration,
    generation: {
      revision,
      generationId,
      parentGenerationId,
      createdAt: new Date().toISOString(),
      digest,
    },
  };
}

function assertGenerationMetadata(value: unknown, source: string): asserts value is ConfigGenerationMetadata {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.generationId !== "string" ||
    !value.generationId.trim() ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest)
  ) {
    throw new ValidationError({ message: `Invalid config generation metadata: ${source}` });
  }
}

function assertGenerationDigest(payload: CompleteUnifiedConfigPayload, source: string): void {
  if (!payload.generation) {
    return;
  }
  const expected = digestUnifiedSections(payload);
  if (payload.generation.digest !== expected) {
    throw new ValidationError({ message: `Config generation digest mismatch: ${source}` });
  }
}

function digestUnifiedSections(payload: CompleteUnifiedConfigPayload): string {
  const candidate = structuredClone(payload);
  delete candidate.generation;
  return createHash("sha256").update(JSON.stringify(candidate), "utf8").digest("hex");
}

function legacyGenerationId(payload: CompleteUnifiedConfigPayload): string {
  return `legacy-${digestUnifiedSections(payload).slice(0, 24)}`;
}

function parseSection(
  schema: { safeParse(value: unknown): { success: boolean; error?: { message?: string } } },
  value: unknown,
  section: string,
  source: string,
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError({
      message: `Invalid ${section} section in ${source}${parsed.error?.message ? `: ${parsed.error.message}` : ""}`,
    });
  }
}

async function readCompleteUnifiedConfig(filePath: string): Promise<CompleteUnifiedConfigPayload> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseCompleteUnifiedConfig(raw, filePath);
}

async function readTransactionMarkerIfExists(filePath: string): Promise<ConfigGenerationTransactionMarker | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config generation transaction marker: ${filePath}`, { cause: error });
  }
  assertTransactionMarker(value, filePath);
  return value;
}

function readTransactionMarkerIfExistsSync(filePath: string): ConfigGenerationTransactionMarker | undefined {
  let raw: string;
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config generation transaction marker: ${filePath}`, { cause: error });
  }
  assertTransactionMarker(value, filePath);
  return value;
}

function assertTransactionMarker(value: unknown, source: string): asserts value is ConfigGenerationTransactionMarker {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.state !== "pending" && value.state !== "committed") ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.generationId !== "string" ||
    !value.generationId.trim() ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new ValidationError({ message: `Invalid config generation transaction marker: ${source}` });
  }
  if (value.runtimeOwnerRecoveryIntent !== undefined) {
    assertRuntimeOwnerRecoveryIntent(value.runtimeOwnerRecoveryIntent, source);
  }
  if (value.rollbackRuntimeOwnerRecoveryIntent !== undefined) {
    assertRuntimeOwnerRecoveryIntent(value.rollbackRuntimeOwnerRecoveryIntent, source);
  }
}

function assertRuntimeOwnerRecoveryIntent(
  value: unknown,
  source: string,
): asserts value is ConfigGenerationRuntimeOwnerRecoveryIntent {
  if (!isRecord(value) || value.version !== 1) {
    throw new ValidationError({ message: `Invalid runtime owner recovery intent: ${source}` });
  }
  if (value.providerSecretEffects !== undefined) {
    if (!Array.isArray(value.providerSecretEffects)) {
      throw new ValidationError({ message: `Invalid provider secret recovery effects: ${source}` });
    }
    for (const effect of value.providerSecretEffects) {
      assertProviderSecretRecoveryEffect(effect, source);
    }
  }
  if (value.meshArtifact === undefined) {
    return;
  }
  const artifact = value.meshArtifact;
  if (
    !isRecord(artifact) ||
    typeof artifact.nodeId !== "string" ||
    !artifact.nodeId.trim() ||
    (artifact.tokenHash !== undefined &&
      (typeof artifact.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.tokenHash))) ||
    (artifact.node !== undefined && (!isRecord(artifact.node) || typeof artifact.node.nodeId !== "string")) ||
    (artifact.joinToken !== undefined &&
      (!isRecord(artifact.joinToken) ||
        typeof artifact.joinToken.tokenHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(artifact.joinToken.tokenHash)))
  ) {
    throw new ValidationError({ message: `Invalid mesh runtime recovery artifact: ${source}` });
  }
}

function assertProviderSecretRecoveryEffect(value: unknown, source: string): void {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    !value.providerId.trim() ||
    (value.operation !== "set" && value.operation !== "delete") ||
    (value.target !== "keychain" && value.target !== "env") ||
    (value.target === "env" && (typeof value.envVar !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.envVar))) ||
    (value.target === "keychain" && value.envVar !== undefined) ||
    (value.target === "keychain" && value.previousEnvFileState !== undefined)
  ) {
    throw new ValidationError({ message: `Invalid provider secret recovery effect: ${source}` });
  }
  assertProviderSecretPreviousState(value.previousState, source, "provider secret");
  if (value.target === "env") {
    assertProviderSecretPreviousState(value.previousEnvFileState, source, "provider env-file");
  }
  if (value.operation === "delete") {
    if (value.verification !== undefined) {
      throw new ValidationError({ message: `Invalid provider secret delete verifier: ${source}` });
    }
    return;
  }
  assertProviderSecretVerification(value.verification, source);
}

function assertProviderSecretPreviousState(value: unknown, source: string, label: string): void {
  if (!isRecord(value) || typeof value.present !== "boolean") {
    throw new ValidationError({ message: `Invalid ${label} previous state: ${source}` });
  }
  if (value.present) {
    assertProviderSecretVerification(value.verification, source);
  } else if (value.verification !== undefined) {
    throw new ValidationError({ message: `Invalid absent ${label} previous-state verifier: ${source}` });
  }
}

function assertProviderSecretVerification(value: unknown, source: string): void {
  if (
    !isRecord(value) ||
    value.algorithm !== "scrypt-v1" ||
    typeof value.saltBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.saltBase64) ||
    typeof value.digestBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.digestBase64)
  ) {
    throw new ValidationError({ message: `Invalid provider secret verifier: ${source}` });
  }
}

function transactionMarkerMatchesPayload(
  marker: ConfigGenerationTransactionMarker,
  payload: CompleteUnifiedConfigPayload,
): boolean {
  return (
    payload.generation?.revision === marker.revision &&
    payload.generation.generationId === marker.generationId &&
    payload.generation.digest === marker.digest
  );
}

async function readValidatedLastGood(
  lastGoodPath: string,
  activeError: unknown,
): Promise<CompleteUnifiedConfigPayload> {
  try {
    const lastGood = await readCompleteUnifiedConfig(lastGoodPath);
    assertValidCompleteUnifiedConfig(lastGood, lastGoodPath);
    assertGenerationDigest(lastGood, lastGoodPath);
    return lastGood;
  } catch (lastGoodError) {
    throw new AggregateError(
      [activeError, lastGoodError],
      "Active unified config is invalid or unconfirmed and no valid last-good generation is available.",
      { cause: lastGoodError },
    );
  }
}

async function publishRecoveryPayload(
  configDir: string,
  activePath: string,
  payload: CompleteUnifiedConfigPayload,
): Promise<void> {
  const tempPath = path.join(configDir, `.goatcitadel-recovery-${randomUUID()}.tmp`);
  await writeDurableJson(tempPath, payload);
  await replaceFileAtomically(tempPath, activePath);
}

async function retainRecoveryLastGood(
  generationsDir: string,
  lastGoodPath: string,
  payload: CompleteUnifiedConfigPayload,
): Promise<void> {
  await fs.mkdir(generationsDir, { recursive: true });
  const tempPath = path.join(generationsDir, `.last-good-recovery-${randomUUID()}.tmp`);
  await writeDurableJson(tempPath, payload);
  await replaceFileAtomically(tempPath, lastGoodPath);
}

async function writeRecoveryTransactionMarker(
  generationsDir: string,
  transactionPath: string,
  payload: CompleteUnifiedConfigPayload,
  intents: Pick<
    ConfigGenerationTransactionMarker,
    "runtimeOwnerRecoveryIntent" | "rollbackRuntimeOwnerRecoveryIntent"
  > = {},
): Promise<void> {
  const generation = payload.generation;
  if (!generation) {
    throw new ValidationError({ message: "Config generation metadata is required for recovery markers." });
  }
  await fs.mkdir(generationsDir, { recursive: true });
  const tempPath = path.join(generationsDir, `.transaction-recovery-${randomUUID()}.tmp`);
  await writeDurableJson(tempPath, {
    version: 1,
    state: "committed",
    revision: generation.revision,
    generationId: generation.generationId,
    digest: generation.digest,
    updatedAt: new Date().toISOString(),
    ...(intents.runtimeOwnerRecoveryIntent
      ? { runtimeOwnerRecoveryIntent: structuredClone(intents.runtimeOwnerRecoveryIntent) }
      : {}),
    ...(intents.rollbackRuntimeOwnerRecoveryIntent
      ? { rollbackRuntimeOwnerRecoveryIntent: structuredClone(intents.rollbackRuntimeOwnerRecoveryIntent) }
      : {}),
  } satisfies ConfigGenerationTransactionMarker);
  await replaceFileAtomically(tempPath, transactionPath);
}

function readCompleteUnifiedConfigSync(filePath: string): CompleteUnifiedConfigPayload {
  const raw = fsSync.readFileSync(filePath, "utf8");
  return parseCompleteUnifiedConfig(raw, filePath);
}

function parseCompleteUnifiedConfig(raw: string, source: string): CompleteUnifiedConfigPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}`, { cause: error });
  }
  assertValidCompleteUnifiedConfig(value, source);
  return value;
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function writeDurableJsonSync(filePath: string, value: unknown): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fsSync.openSync(filePath, "w");
  try {
    fsSync.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
}

async function replaceFileAtomically(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
    await syncDirectoryBestEffort(path.dirname(destination));
  } finally {
    await removePathBestEffort(source);
  }
}

function replaceFileAtomicallySync(source: string, destination: string): void {
  try {
    fsSync.renameSync(source, destination);
    syncDirectoryBestEffortSync(path.dirname(destination));
  } finally {
    try {
      fsSync.rmSync(source, { force: true });
    } catch (cleanupError) {
      // Destination is authoritative after a successful same-directory rename.
      void cleanupError;
    }
  }
}

async function removeFileDurably(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  await syncDirectoryBestEffort(path.dirname(filePath));
}

function removeFileDurablySync(filePath: string): void {
  fsSync.rmSync(filePath, { force: true });
  syncDirectoryBestEffortSync(path.dirname(filePath));
}

async function removePathBestEffort(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // Cleanup failure cannot change the active canonical generation.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not consistently permit opening a directory handle for
    // fsync. File fsync plus same-directory rename remains the strongest
    // portable primitive available there; other failures remain fatal.
    if (
      process.platform !== "win32" ||
      !isNodeError(error) ||
      !["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function syncDirectoryBestEffortSync(directoryPath: string): void {
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(directoryPath, "r");
    fsSync.fsyncSync(fd);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !isNodeError(error) ||
      !["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fsSync.closeSync(fd);
    }
  }
}
