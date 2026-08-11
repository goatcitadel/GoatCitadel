import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  governedRemediationRecipeSha256,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationScope,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import { configMirrorContentEquals, renderConfigMirrorBytes } from "../config-sync-lib.js";
import type { ConfigGenerationService } from "./config-generation-service.js";
import {
  GovernedFileHandlePortRefusalError,
  GovernedFileHandlePortUncertainError,
  captureGovernedFileEntry,
  isGovernedFileHandlePortAvailable,
  publishGovernedFileEntry,
  removeGovernedFileEntry,
  type GovernedFileCaptureEvidence,
  type GovernedFileExpectedPrior,
  type GovernedFileHandleIdentity,
  type GovernedFilePublishEvidence,
  type GovernedFileRemoveEvidence,
} from "./governed-file-windows-handle-port.js";
import type {
  GovernedRemediationCompletionNotice,
  GovernedRemediationCompletionPort,
} from "./governed-remediation-coordinator.js";
import type {
  GovernedRemediationActivationResult,
  GovernedRemediationApplyResult,
  GovernedRemediationOwnerContext,
  GovernedRemediationOwnerPort,
  GovernedRemediationPreflightResult,
  GovernedRemediationProbeResult,
  GovernedRemediationRecipeRegistration,
  GovernedRemediationReconcileResult,
  GovernedRemediationRollbackResult,
} from "./governed-remediation-registry.js";

/**
 * First callable governed self-configuration recipe: repair of the fixed
 * `config/budgets.json` compatibility mirror from the canonical unified
 * configuration owner.
 *
 * Every file mutation goes through the native handle-relative
 * capture/publish/restore port, so prior state, effect identity, and rollback
 * custody are handle-bound rather than path-based. A durable pre-effect
 * journal entry is persisted before the publish boundary is crossed; journal
 * replay on boot plus the coordinator completion callback retire entries
 * boundedly once the durable receipt lineage owns the evidence.
 *
 * The recipe is callable but approval-gated (`required_before_apply`) and is
 * never auto-fired: remediation creation is side-effect free and only an
 * explicit continuation carrying the purpose-specific pre-effect approval can
 * reach the apply boundary.
 */

export const GOVERNED_BUDGETS_MIRROR_OWNER_ID = "gateway.config.budgets-mirror" as const;
export const GOVERNED_BUDGETS_MIRROR_TARGET_ID = "gateway.config.budgets-mirror-file" as const;
export const GOVERNED_BUDGETS_MIRROR_CAPABILITY_ID = "runtime.configuration.budgets-mirror-consistent" as const;
export const GOVERNED_BUDGETS_MIRROR_PROBE_ID = "gateway.config.budgets-mirror.probe" as const;
export const GOVERNED_BUDGETS_MIRROR_JOURNAL_SCHEMA_VERSION = "goatcitadel.budgets-mirror-journal.v1" as const;

const MIRROR_FILENAME = "budgets.json";
const JOURNAL_DIRNAME = path.join(".generations", "governed-remediation", "budgets-mirror");
const MAX_JOURNAL_CONTENT_BYTES = 1024 * 1024;
const JOURNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const GOVERNED_BUDGETS_MIRROR_RECIPE: GovernedRemediationRecipe = normalizeGovernedRemediationRecipe({
  schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  recipeId: "gateway.config.budgets-mirror.governed-repair",
  recipeVersion: 1,
  repairClass: "declarative_configuration",
  ownerId: GOVERNED_BUDGETS_MIRROR_OWNER_ID,
  targetId: GOVERNED_BUDGETS_MIRROR_TARGET_ID,
  requestedCapabilityId: GOVERNED_BUDGETS_MIRROR_CAPABILITY_ID,
  executionMode: "governed",
  allowedScopeKinds: ["installation"],
  // remote_hardened is deliberately excluded until the remote custody boundary
  // exists; the registry then fails closed for that profile.
  allowedDeploymentProfiles: ["local_dev", "trusted_local"],
  inputKind: "none",
  preEffectApproval: "required_before_apply",
  activationMode: "not_applicable",
  activationApproval: "not_applicable",
  verificationProbeId: GOVERNED_BUDGETS_MIRROR_PROBE_ID,
  rollbackStrategy: "restore_previous",
  maxApplyAttempts: 1,
});

export function governedBudgetsMirrorRecipeSha256(): string {
  return governedRemediationRecipeSha256(GOVERNED_BUDGETS_MIRROR_RECIPE);
}

export function governedBudgetsMirrorScope(input: {
  deploymentId: string;
  installationId: string;
}): GovernedRemediationScope {
  return normalizeGovernedRemediationScope({
    schemaVersion: "goatcitadel.governed-remediation-scope.v1",
    deploymentId: input.deploymentId,
    scopeKind: "installation",
    scopeId: input.installationId,
    targetId: GOVERNED_BUDGETS_MIRROR_TARGET_ID,
  });
}

/**
 * Injectable seam over the native handle port. The default binding is the
 * Windows helper; deterministic tests may substitute a fake that honors the
 * same CAS semantics, but refusal-proof authority stays with the native tests.
 */
export interface GovernedFileMutationPort {
  available(): boolean;
  capture(rootPath: string, relativePath: string): Promise<GovernedFileCaptureEvidence>;
  publish(input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: GovernedFileHandleIdentity;
    readonly expectedPrior: GovernedFileExpectedPrior;
    readonly content: Buffer;
  }): Promise<GovernedFilePublishEvidence>;
  remove(input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: GovernedFileHandleIdentity;
    readonly expectedSha256: string;
  }): Promise<GovernedFileRemoveEvidence>;
}

// The helper hosts an Add-Type compile on first use; a busy host can exceed
// the protocol default, so the recipe binding uses a wider fixed deadline.
const NATIVE_PORT_DEADLINE_MS = 60_000;
const nativePort: GovernedFileMutationPort = {
  available: () => isGovernedFileHandlePortAvailable(),
  capture: (rootPath, relativePath) =>
    captureGovernedFileEntry(rootPath, relativePath, { deadlineMs: NATIVE_PORT_DEADLINE_MS }),
  publish: (input) => publishGovernedFileEntry(input, { deadlineMs: NATIVE_PORT_DEADLINE_MS }),
  remove: (input) => removeGovernedFileEntry(input, { deadlineMs: NATIVE_PORT_DEADLINE_MS }),
};
export const nativeGovernedFileMutationPort: GovernedFileMutationPort = Object.freeze(nativePort);

export type GovernedBudgetsMirrorJournalPhase = "intent" | "published" | "rolled_back";

export interface GovernedBudgetsMirrorJournalEntry {
  readonly schemaVersion: typeof GOVERNED_BUDGETS_MIRROR_JOURNAL_SCHEMA_VERSION;
  readonly remediationId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly generationRevision: number;
  readonly parentIdentity: GovernedFileHandleIdentity;
  readonly capturedPresent: boolean;
  readonly capturedSha256: string | null;
  readonly capturedContentBase64: string | null;
  readonly intendedSha256: string;
  readonly intendedContentBase64: string;
  readonly phase: GovernedBudgetsMirrorJournalPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type GovernedBudgetsMirrorJournalRead =
  | { readonly status: "present"; readonly entry: GovernedBudgetsMirrorJournalEntry }
  | { readonly status: "absent" }
  | { readonly status: "corrupt" };

/**
 * Durable owner-private pre-effect journal. One active entry per remediation,
 * written and fsynced before the publish boundary is crossed. Entries hold the
 * exact captured and intended mirror bytes as rollback/recovery custody; they
 * never contain any other configuration section.
 */
export class GovernedBudgetsMirrorJournalStore {
  private readonly journalDir: string;

  public constructor(rootDir: string) {
    this.journalDir = path.join(rootDir, "config", JOURNAL_DIRNAME);
  }

  public directory(): string {
    return this.journalDir;
  }

  public async write(entry: GovernedBudgetsMirrorJournalEntry): Promise<void> {
    const validated = validateJournalEntry(entry);
    await fs.mkdir(this.journalDir, { recursive: true });
    const finalPath = this.entryPath(validated.remediationId);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await retryTransientWindowsError(() => fs.rename(tempPath, finalPath));
    await this.syncDirectoryBestEffort();
  }

  public async read(remediationId: string): Promise<GovernedBudgetsMirrorJournalRead> {
    let raw: string;
    try {
      raw = await retryTransientWindowsError(() =>
        fs.readFile(this.entryPath(journalId(remediationId, "remediation ID")), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    try {
      return { status: "present", entry: validateJournalEntry(JSON.parse(raw)) };
    } catch {
      return { status: "corrupt" };
    }
  }

  public async setPhase(remediationId: string, phase: GovernedBudgetsMirrorJournalPhase, at: string): Promise<void> {
    const read = await this.read(remediationId);
    if (read.status !== "present") {
      throw new Error("Budgets mirror journal entry is unavailable for a phase transition.");
    }
    await this.write({ ...read.entry, phase, updatedAt: timestamp(at, "journal update timestamp") });
  }

  public async retire(remediationId: string): Promise<boolean> {
    try {
      await retryTransientWindowsError(() => fs.rm(this.entryPath(journalId(remediationId, "remediation ID"))));
      await this.syncDirectoryBestEffort();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  public async list(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    return Object.freeze(
      names
        .filter((name) => name.endsWith(".journal.json"))
        .map((name) => decodeJournalFilename(name))
        .filter((value): value is string => value !== null)
        .sort(),
    );
  }

  private entryPath(remediationId: string): string {
    return path.join(this.journalDir, `${encodeURIComponent(remediationId)}.journal.json`);
  }

  private async syncDirectoryBestEffort(): Promise<void> {
    // Windows cannot fsync a directory handle through Node; the entry file
    // itself is always fsynced before rename.
    if (process.platform === "win32") return;
    try {
      const dir = await fs.open(this.journalDir, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Best effort only; entry-file durability is already guaranteed.
    }
  }
}

export interface GovernedBudgetsMirrorBootReplaySummary {
  readonly retired: readonly string[];
  readonly retained: readonly string[];
  readonly corrupt: readonly string[];
}

export interface GovernedBudgetsMirrorRecipeOwnerOptions {
  readonly rootDir: string;
  readonly configGeneration: ConfigGenerationService;
  readonly port?: GovernedFileMutationPort;
  readonly journal?: GovernedBudgetsMirrorJournalStore;
  readonly now?: () => string;
}

export class GovernedBudgetsMirrorRecipeOwner
  implements GovernedRemediationOwnerPort, GovernedRemediationCompletionPort
{
  public readonly ownerId = GOVERNED_BUDGETS_MIRROR_OWNER_ID;
  public readonly targetId = GOVERNED_BUDGETS_MIRROR_TARGET_ID;
  public readonly requestedCapabilityId = GOVERNED_BUDGETS_MIRROR_CAPABILITY_ID;
  public readonly activationMode = "not_applicable" as const;

  private readonly configDir: string;
  private readonly configGeneration: ConfigGenerationService;
  private readonly port: GovernedFileMutationPort;
  private readonly journal: GovernedBudgetsMirrorJournalStore;
  private readonly now: () => string;

  public constructor(options: GovernedBudgetsMirrorRecipeOwnerOptions) {
    this.configDir = path.join(options.rootDir, "config");
    this.configGeneration = options.configGeneration;
    this.port = options.port ?? nativeGovernedFileMutationPort;
    this.journal = options.journal ?? new GovernedBudgetsMirrorJournalStore(options.rootDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public journalStore(): GovernedBudgetsMirrorJournalStore {
    return this.journal;
  }

  /** Secret-free owner revision for the mirror target, or null when unprovable. */
  public async currentOwnerRevision(): Promise<string | null> {
    if (!this.port.available()) return null;
    try {
      const capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
      return this.revisionFor(this.configGeneration.getRevision(), capture.sha256);
    } catch {
      return null;
    }
  }

  public async preflight(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationPreflightResult> {
    if (!this.port.available()) {
      return { status: "rejected", reason: "owner_unavailable", ownerRevisionObserved: null };
    }
    if (this.configGeneration.getHealthSnapshot().transactionState !== "idle") {
      return { status: "rejected", reason: "precondition_drift", ownerRevisionObserved: null };
    }
    let capture: GovernedFileCaptureEvidence;
    try {
      capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
    } catch (error) {
      return {
        status: "rejected",
        reason: error instanceof GovernedFileHandlePortRefusalError ? "precondition_drift" : "owner_unavailable",
        ownerRevisionObserved: null,
      };
    }
    const journalRead = await this.journal.read(context.remediationId);
    if (journalRead.status === "corrupt") {
      return { status: "rejected", reason: "precondition_drift", ownerRevisionObserved: null };
    }
    return { status: "ready", ownerRevision: this.revisionFor(this.configGeneration.getRevision(), capture.sha256) };
  }

  public async apply(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationApplyResult> {
    if (!this.port.available()) {
      return { status: "rejected", reason: "owner_unavailable", ownerRevisionObserved: null };
    }
    const journalRead = await this.journal.read(context.remediationId);
    if (journalRead.status === "corrupt") {
      return { status: "uncertain", reason: "internal_error", ownerRevisionObserved: null };
    }
    if (journalRead.status === "present") {
      return this.applyWithExistingJournal(context, journalRead.entry);
    }
    return this.applyFresh(context);
  }

  public async probe(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationProbeResult> {
    if (!this.port.available()) {
      return { status: "rejected", reason: "owner_unavailable", ownerRevisionObserved: null };
    }
    const journalRead = await this.journal.read(context.remediationId);
    if (journalRead.status !== "present" || journalRead.entry.phase !== "published") {
      return { status: "rejected", reason: "verification_failed", ownerRevisionObserved: null };
    }
    const entry = journalRead.entry;
    if (entry.effectId !== context.effectId) {
      return { status: "rejected", reason: "verification_failed", ownerRevisionObserved: null };
    }
    let capture: GovernedFileCaptureEvidence;
    try {
      capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
    } catch {
      return { status: "rejected", reason: "owner_unavailable", ownerRevisionObserved: null };
    }
    const observed = this.revisionFor(this.configGeneration.getRevision(), capture.sha256);
    if (
      capture.present &&
      capture.sha256 === entry.intendedSha256 &&
      this.configGeneration.getRevision() === entry.generationRevision &&
      this.configGeneration.getHealthSnapshot().transactionState === "idle" &&
      this.mirrorMatchesActiveBudgets(capture)
    ) {
      return { status: "accepted", probeId: GOVERNED_BUDGETS_MIRROR_PROBE_ID, ownerRevisionObserved: observed };
    }
    return { status: "rejected", reason: "verification_failed", ownerRevisionObserved: observed };
  }

  public async activate(_context: GovernedRemediationOwnerContext): Promise<GovernedRemediationActivationResult> {
    return { status: "rejected", reason: "internal_error", ownerRevisionObserved: null };
  }

  public async rollback(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationRollbackResult> {
    if (!this.port.available()) {
      return { status: "failed", ownerRevisionObserved: null, effectState: "unknown" };
    }
    const journalRead = await this.journal.read(context.remediationId);
    if (journalRead.status !== "present" || journalRead.entry.effectId !== context.effectId) {
      return { status: "failed", ownerRevisionObserved: null, effectState: "unknown" };
    }
    const entry = journalRead.entry;
    const beforeRevision = this.revisionFor(entry.generationRevision, entry.intendedSha256);
    const afterRevision = this.revisionFor(entry.generationRevision, entry.capturedSha256);
    if (entry.phase === "rolled_back") {
      return { status: "rolled_back", ownerRevisionBefore: beforeRevision, ownerRevisionAfter: afterRevision };
    }
    let capture: GovernedFileCaptureEvidence;
    try {
      capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
    } catch {
      return { status: "failed", ownerRevisionObserved: null, effectState: "unknown" };
    }
    if (this.captureMatchesJournalPrior(capture, entry)) {
      await this.journal.setPhase(entry.remediationId, "rolled_back", this.now());
      return { status: "rolled_back", ownerRevisionBefore: beforeRevision, ownerRevisionAfter: afterRevision };
    }
    if (!(capture.present && capture.sha256 === entry.intendedSha256)) {
      const observed = this.revisionFor(this.configGeneration.getRevision(), capture.sha256);
      return { status: "failed", ownerRevisionObserved: observed, effectState: "unknown" };
    }
    try {
      if (entry.capturedPresent) {
        await this.port.publish({
          rootPath: this.configDir,
          relativePath: MIRROR_FILENAME,
          expectedParent: entry.parentIdentity,
          expectedPrior: { present: true, sha256: entry.intendedSha256 },
          content: Buffer.from(entry.capturedContentBase64 ?? "", "base64"),
        });
      } else {
        await this.port.remove({
          rootPath: this.configDir,
          relativePath: MIRROR_FILENAME,
          expectedParent: entry.parentIdentity,
          expectedSha256: entry.intendedSha256,
        });
      }
    } catch (error) {
      const effectState = error instanceof GovernedFileHandlePortRefusalError ? "present" : "unknown";
      const observed =
        error instanceof GovernedFileHandlePortRefusalError
          ? this.revisionFor(this.configGeneration.getRevision(), capture.sha256)
          : null;
      return { status: "failed", ownerRevisionObserved: observed, effectState };
    }
    await this.journal.setPhase(entry.remediationId, "rolled_back", this.now());
    return { status: "rolled_back", ownerRevisionBefore: beforeRevision, ownerRevisionAfter: afterRevision };
  }

  public async reconcile(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationReconcileResult> {
    if (!this.port.available()) return { observation: "unknown", ownerRevisionObserved: null };
    const journalRead = await this.journal.read(context.remediationId);
    if (journalRead.status === "corrupt") return { observation: "unknown", ownerRevisionObserved: null };
    let capture: GovernedFileCaptureEvidence;
    try {
      capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
    } catch {
      return { observation: "unknown", ownerRevisionObserved: null };
    }
    const currentRevision = this.revisionFor(this.configGeneration.getRevision(), capture.sha256);
    if (journalRead.status === "absent") {
      // The durable journal always precedes the effect boundary, so a missing
      // entry proves this owner never crossed it for the remediation.
      return { observation: "effect_absent", ownerRevisionObserved: currentRevision };
    }
    const entry = journalRead.entry;
    if (entry.effectId !== context.effectId) return { observation: "unknown", ownerRevisionObserved: currentRevision };
    const application = Object.freeze({
      effectId: entry.effectId,
      ownerRevisionBefore: this.revisionFor(entry.generationRevision, entry.capturedSha256),
      ownerRevisionAfter: this.revisionFor(entry.generationRevision, entry.intendedSha256),
    });
    if (entry.phase === "rolled_back" && this.captureMatchesJournalPrior(capture, entry)) {
      return {
        observation: "rolled_back",
        application,
        ownerRevisionBefore: application.ownerRevisionAfter,
        ownerRevisionAfter: application.ownerRevisionBefore,
      };
    }
    if (capture.present && capture.sha256 === entry.intendedSha256) {
      const verified =
        this.configGeneration.getRevision() === entry.generationRevision &&
        this.configGeneration.getHealthSnapshot().transactionState === "idle" &&
        this.mirrorMatchesActiveBudgets(capture);
      return {
        observation: verified ? "effect_verified" : "effect_present_unverified",
        application,
        ownerRevisionObserved: verified ? application.ownerRevisionAfter : currentRevision,
      };
    }
    if (this.captureMatchesJournalPrior(capture, entry)) {
      return { observation: "effect_absent", ownerRevisionObserved: currentRevision };
    }
    return { observation: "unknown", ownerRevisionObserved: currentRevision };
  }

  /**
   * Coordinator completion callback: prompt, idempotent journal retirement
   * once the durable receipts decisively settle the effect. Entries with an
   * unresolved effect stay as recovery custody.
   */
  public async onRemediationSettled(notice: GovernedRemediationCompletionNotice): Promise<void> {
    if (notice.ownerId !== this.ownerId || notice.recipeId !== GOVERNED_BUDGETS_MIRROR_RECIPE.recipeId) return;
    if (notice.effectDisposition === "effect_unknown") return;
    await this.journal.retire(notice.remediationId);
  }

  /**
   * Bounded journal retirement across restart windows: replay every journal
   * entry against durable coordinator truth. Settled entries retire, active or
   * unresolved ones stay, corrupt files are quarantined in place.
   */
  public async replayJournalOnBoot(completion: {
    completionNoticeFor(remediationId: string): GovernedRemediationCompletionNotice | null;
  }): Promise<GovernedBudgetsMirrorBootReplaySummary> {
    const retired: string[] = [];
    const retained: string[] = [];
    const corrupt: string[] = [];
    for (const remediationId of await this.journal.list()) {
      const read = await this.journal.read(remediationId);
      if (read.status === "corrupt") {
        corrupt.push(remediationId);
        continue;
      }
      if (read.status === "absent") continue;
      const notice = completion.completionNoticeFor(remediationId);
      if (!notice || notice.effectDisposition === "effect_unknown") {
        retained.push(remediationId);
        continue;
      }
      await this.journal.retire(remediationId);
      retired.push(remediationId);
    }
    return Object.freeze({
      retired: Object.freeze(retired),
      retained: Object.freeze(retained),
      corrupt: Object.freeze(corrupt),
    });
  }

  private async applyWithExistingJournal(
    context: GovernedRemediationOwnerContext,
    entry: GovernedBudgetsMirrorJournalEntry,
  ): Promise<GovernedRemediationApplyResult> {
    const beforeRevision = this.revisionFor(entry.generationRevision, entry.capturedSha256);
    const afterRevision = this.revisionFor(entry.generationRevision, entry.intendedSha256);
    if (entry.phase === "published") {
      if (entry.operationId !== context.operationId || entry.effectId !== context.effectId) {
        return { status: "rejected", reason: "owner_revision_conflict", ownerRevisionObserved: afterRevision };
      }
      return {
        status: "applied",
        effectId: entry.effectId,
        ownerRevisionBefore: beforeRevision,
        ownerRevisionAfter: afterRevision,
      };
    }
    if (entry.phase === "rolled_back") {
      return { status: "rejected", reason: "owner_revision_conflict", ownerRevisionObserved: null };
    }
    // Crash window: the intent was journaled but the publish outcome is not
    // marked. Resolve it from the real file before deciding.
    let capture: GovernedFileCaptureEvidence;
    try {
      capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
    } catch {
      return { status: "uncertain", reason: "internal_error", ownerRevisionObserved: null };
    }
    if (capture.present && capture.sha256 === entry.intendedSha256) {
      if (entry.operationId !== context.operationId || entry.effectId !== context.effectId) {
        return { status: "rejected", reason: "owner_revision_conflict", ownerRevisionObserved: afterRevision };
      }
      await this.journal.setPhase(entry.remediationId, "published", this.now());
      return {
        status: "applied",
        effectId: entry.effectId,
        ownerRevisionBefore: beforeRevision,
        ownerRevisionAfter: afterRevision,
      };
    }
    if (this.captureMatchesJournalPrior(capture, entry)) {
      // The effect boundary was provably not crossed; restart the attempt.
      await this.journal.retire(entry.remediationId);
      return this.applyFresh(context);
    }
    return {
      status: "uncertain",
      reason: "precondition_drift",
      ownerRevisionObserved: this.revisionFor(this.configGeneration.getRevision(), capture.sha256),
    };
  }

  private async applyFresh(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationApplyResult> {
    if (this.configGeneration.getHealthSnapshot().transactionState !== "idle") {
      return { status: "rejected", reason: "precondition_drift", ownerRevisionObserved: null };
    }
    let capture: GovernedFileCaptureEvidence;
    try {
      capture = await this.port.capture(this.configDir, MIRROR_FILENAME);
    } catch (error) {
      return {
        status: "rejected",
        reason: error instanceof GovernedFileHandlePortRefusalError ? "precondition_drift" : "owner_unavailable",
        ownerRevisionObserved: null,
      };
    }
    const generationRevision = this.configGeneration.getRevision();
    const ownerRevisionBefore = this.revisionFor(generationRevision, capture.sha256);
    if (context.expectedOwnerRevision !== null && ownerRevisionBefore !== context.expectedOwnerRevision) {
      return { status: "rejected", reason: "owner_revision_conflict", ownerRevisionObserved: ownerRevisionBefore };
    }
    const currentContent = capture.content ? capture.content.toString("utf8") : null;
    const intendedContent = renderConfigMirrorBytes(currentContent, this.activeBudgetsSection());
    const intendedBuffer = Buffer.from(intendedContent, "utf8");
    if (intendedBuffer.byteLength > MAX_JOURNAL_CONTENT_BYTES) {
      return { status: "rejected", reason: "invalid_candidate", ownerRevisionObserved: ownerRevisionBefore };
    }
    const intendedSha256 = sha256Hex(intendedBuffer);
    const entry: GovernedBudgetsMirrorJournalEntry = {
      schemaVersion: GOVERNED_BUDGETS_MIRROR_JOURNAL_SCHEMA_VERSION,
      remediationId: context.remediationId,
      effectId: context.effectId,
      operationId: context.operationId,
      recipeId: context.recipe.recipeId,
      recipeVersion: context.recipe.recipeVersion,
      recipeSha256: context.recipeSha256,
      generationRevision,
      parentIdentity: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
      capturedPresent: capture.present,
      capturedSha256: capture.sha256,
      capturedContentBase64: capture.content ? capture.content.toString("base64") : null,
      intendedSha256,
      intendedContentBase64: intendedBuffer.toString("base64"),
      phase: "intent",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    // Durable journal callback strictly before the effect boundary.
    try {
      await this.journal.write(entry);
    } catch {
      return { status: "rejected", reason: "owner_unavailable", ownerRevisionObserved: ownerRevisionBefore };
    }
    const alreadyExact = capture.present && capture.sha256 === intendedSha256;
    if (!alreadyExact) {
      try {
        await this.port.publish({
          rootPath: this.configDir,
          relativePath: MIRROR_FILENAME,
          expectedParent: entry.parentIdentity,
          expectedPrior: capture.present ? { present: true, sha256: capture.sha256 as string } : { present: false },
          content: intendedBuffer,
        });
      } catch (error) {
        if (error instanceof GovernedFileHandlePortRefusalError) {
          // The helper proved no mutation happened; the intent retires now.
          await this.journal.retire(entry.remediationId);
          return {
            status: "rejected",
            reason: error.reason === "posix_semantics_unsupported" ? "owner_unavailable" : "precondition_drift",
            ownerRevisionObserved: ownerRevisionBefore,
          };
        }
        const reason = error instanceof GovernedFileHandlePortUncertainError ? "precondition_drift" : "internal_error";
        return { status: "uncertain", reason, ownerRevisionObserved: null };
      }
    }
    await this.journal.setPhase(entry.remediationId, "published", this.now());
    return {
      status: "applied",
      effectId: context.effectId,
      ownerRevisionBefore,
      ownerRevisionAfter: this.revisionFor(generationRevision, intendedSha256),
    };
  }

  private activeBudgetsSection(): unknown {
    return this.configGeneration.getActivePayload().budgets;
  }

  private mirrorMatchesActiveBudgets(capture: GovernedFileCaptureEvidence): boolean {
    if (!capture.present || !capture.content) return false;
    const current = capture.content.toString("utf8");
    return configMirrorContentEquals(current, renderConfigMirrorBytes(current, this.activeBudgetsSection()));
  }

  private captureMatchesJournalPrior(
    capture: GovernedFileCaptureEvidence,
    entry: GovernedBudgetsMirrorJournalEntry,
  ): boolean {
    if (!entry.capturedPresent) return !capture.present;
    return capture.present && capture.sha256 === entry.capturedSha256;
  }

  private revisionFor(generationRevision: number, sha256: string | null): string {
    return `budgets-mirror:v1:g${generationRevision}:${sha256 ?? "absent"}`;
  }
}

export function governedBudgetsMirrorRecipeRegistration(
  owner: GovernedBudgetsMirrorRecipeOwner,
): GovernedRemediationRecipeRegistration {
  return Object.freeze({ recipe: GOVERNED_BUDGETS_MIRROR_RECIPE, owner });
}

/** Exists so tests can build faithful crash fixtures without touching fs APIs twice. */
export function readJournalEntrySync(filePath: string): GovernedBudgetsMirrorJournalEntry {
  return validateJournalEntry(JSON.parse(fsSync.readFileSync(filePath, "utf8")));
}

function validateJournalEntry(value: unknown): GovernedBudgetsMirrorJournalEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Budgets mirror journal entry must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "schemaVersion",
    "remediationId",
    "effectId",
    "operationId",
    "recipeId",
    "recipeVersion",
    "recipeSha256",
    "generationRevision",
    "parentIdentity",
    "capturedPresent",
    "capturedSha256",
    "capturedContentBase64",
    "intendedSha256",
    "intendedContentBase64",
    "phase",
    "createdAt",
    "updatedAt",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("Budgets mirror journal entry has an invalid key set.");
  }
  if (record.schemaVersion !== GOVERNED_BUDGETS_MIRROR_JOURNAL_SCHEMA_VERSION) {
    throw new TypeError("Budgets mirror journal entry schema version is unsupported.");
  }
  const parent = record.parentIdentity as Record<string, unknown>;
  if (
    typeof parent !== "object" ||
    parent === null ||
    Object.keys(parent).sort().join(",") !== "fileId,volumeSerial" ||
    !/^[0-9a-f]{16}$/u.test(String(parent.volumeSerial)) ||
    !/^[0-9a-f]{32}$/u.test(String(parent.fileId))
  ) {
    throw new TypeError("Budgets mirror journal parent identity is invalid.");
  }
  const capturedPresent = record.capturedPresent;
  if (typeof capturedPresent !== "boolean") throw new TypeError("Budgets mirror journal presence flag is invalid.");
  const capturedSha256 = record.capturedSha256;
  const capturedContentBase64 = record.capturedContentBase64;
  if (capturedPresent) {
    if (typeof capturedSha256 !== "string" || !SHA256_PATTERN.test(capturedSha256)) {
      throw new TypeError("Budgets mirror journal captured hash is invalid.");
    }
    if (typeof capturedContentBase64 !== "string" || !isBoundedBase64(capturedContentBase64, capturedSha256)) {
      throw new TypeError("Budgets mirror journal captured content is invalid.");
    }
  } else if (capturedSha256 !== null || capturedContentBase64 !== null) {
    throw new TypeError("Budgets mirror journal captured state is inconsistent.");
  }
  if (typeof record.intendedSha256 !== "string" || !SHA256_PATTERN.test(record.intendedSha256)) {
    throw new TypeError("Budgets mirror journal intended hash is invalid.");
  }
  if (
    typeof record.intendedContentBase64 !== "string" ||
    !isBoundedBase64(record.intendedContentBase64, record.intendedSha256)
  ) {
    throw new TypeError("Budgets mirror journal intended content is invalid.");
  }
  const phase = record.phase;
  if (phase !== "intent" && phase !== "published" && phase !== "rolled_back") {
    throw new TypeError("Budgets mirror journal phase is invalid.");
  }
  if (
    !Number.isSafeInteger(record.generationRevision) ||
    (record.generationRevision as number) < 0 ||
    (record.generationRevision as number) > Number.MAX_SAFE_INTEGER - 1
  ) {
    throw new TypeError("Budgets mirror journal generation revision is invalid.");
  }
  return Object.freeze({
    schemaVersion: GOVERNED_BUDGETS_MIRROR_JOURNAL_SCHEMA_VERSION,
    remediationId: journalId(record.remediationId, "remediation ID"),
    effectId: journalId(record.effectId, "effect ID"),
    operationId: journalId(record.operationId, "operation ID"),
    recipeId: journalId(record.recipeId, "recipe ID"),
    recipeVersion: boundedInteger(record.recipeVersion, 1, Number.MAX_SAFE_INTEGER, "recipe version"),
    recipeSha256: sha256Field(record.recipeSha256, "recipe digest"),
    generationRevision: record.generationRevision as number,
    parentIdentity: Object.freeze({
      volumeSerial: String(parent.volumeSerial),
      fileId: String(parent.fileId),
    }),
    capturedPresent,
    capturedSha256: capturedPresent ? (capturedSha256 as string) : null,
    capturedContentBase64: capturedPresent ? (capturedContentBase64 as string) : null,
    intendedSha256: record.intendedSha256,
    intendedContentBase64: record.intendedContentBase64,
    phase,
    createdAt: timestamp(record.createdAt, "journal creation timestamp"),
    updatedAt: timestamp(record.updatedAt, "journal update timestamp"),
  });
}

/**
 * Windows can surface transient EPERM/EBUSY on files that were just renamed
 * into place (indexer/AV holds). Retry briefly; real failures still propagate.
 */
async function retryTransientWindowsError<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function isBoundedBase64(value: string, expectedSha256: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > MAX_JOURNAL_CONTENT_BYTES || decoded.toString("base64") !== value) return false;
  return sha256Hex(decoded) === expectedSha256;
}

function decodeJournalFilename(name: string): string | null {
  try {
    const decoded = decodeURIComponent(name.slice(0, -".journal.json".length));
    return JOURNAL_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function journalId(value: unknown, label: string): string {
  if (typeof value !== "string" || !JOURNAL_ID_PATTERN.test(value)) {
    throw new TypeError(`Budgets mirror journal ${label} is invalid.`);
  }
  return value;
}

function sha256Field(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`Budgets mirror journal ${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Budgets mirror journal ${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Budgets mirror journal ${label} is invalid.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
