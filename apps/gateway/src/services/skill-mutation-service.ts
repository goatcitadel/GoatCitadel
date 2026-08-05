import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { SkillLifecycleRecord } from "@goatcitadel/contracts";
import { normalizeSkillId } from "./skill-import-service.js";
import { validateSkillContent, type SkillContentValidationResult } from "./skill-content-validation.js";
import { assertSkillSourceManifestSize, readBoundedSkillSourceManifestTextSync } from "./skill-content-integrity.js";

/**
 * S2 — Skill self-authoring (full autonomy + rollback).
 *
 * Governed write path that lets the agent author its OWN skills. Every mutation
 * is validated + security-scanned (shared {@link validateSkillContent}), has
 * secrets blocked, is written under a dedicated self-skills jail, recorded in
 * the skill lifecycle as a non-callable `candidate`, and snapshotted so the
 * change is fully reversible.
 *
 * This service NEVER promotes a skill to a callable state. Promotion is the sole
 * responsibility of the governed activation path (improvement-service
 * `applyActivationChange("skill_revision")`), so `isSkillCallable` stays the
 * single execution chokepoint. A freshly authored skill is `candidate` and
 * therefore not callable.
 */

/** Lifecycle store surface this service needs. Matches `Storage["skillLifecycle"]`. */
export interface SkillMutationLifecycleStore {
  find(skillId: string): Promise<SkillLifecycleRecord | undefined>;
  upsert(input: SkillLifecycleRecord): Promise<SkillLifecycleRecord>;
}

export interface SkillMutationServiceOptions {
  /** Workspace/runtime root; the self-skills jail lives under it. */
  readonly rootDir: string;
  readonly skillLifecycle: SkillMutationLifecycleStore;
  readonly now?: () => Date;
}

export interface DraftSkillMutationInput {
  /** Raw `SKILL.md` (frontmatter + body) the agent wants to author. */
  readonly skillMarkdown: string;
  /** Optional explicit skill id; otherwise derived from the frontmatter name. */
  readonly skillId?: string;
  /** Provenance: the evaluation run that produced this draft. */
  readonly evaluationRunId?: string;
  /** Provenance: the chat turn that triggered this draft. */
  readonly sourceTurnId?: string;
  /** Optional human-readable summary persisted into provenance. */
  readonly summary?: string;
}

export interface SkillMutationProvenance {
  readonly source: "self_generated";
  readonly evaluationRunId?: string;
  readonly sourceTurnId?: string;
  readonly summary?: string;
  readonly authoredAt: string;
}

/**
 * Pre-mutation snapshot. Captures the prior `SKILL.md` bytes (if any) and the
 * prior lifecycle row so the write is reversible. `existed:false` means the
 * skill did not exist before and restoring removes it.
 */
export interface SkillMutationSnapshot {
  readonly skillId: string;
  readonly skillFilePath: string;
  readonly existed: boolean;
  readonly priorSkillMarkdown?: string;
  readonly priorSourceJson?: string;
  readonly priorLifecycle?: SkillLifecycleRecord;
  readonly capturedAt: string;
}

export interface SkillMutationResult {
  readonly skillId: string;
  readonly skillDir: string;
  readonly skillFilePath: string;
  readonly lifecycle: SkillLifecycleRecord;
  readonly snapshot: SkillMutationSnapshot;
  readonly validation: SkillContentValidationResult;
  readonly changeHash: string;
  /** True when a durable replay returned the already-committed mutation. */
  readonly replayed?: boolean;
}

/**
 * Exact, validated intent persisted by a durable post-commit child before any
 * filesystem mutation. Artifact paths and prior bytes are intentionally not
 * serialized: a durable plan is valid only for a previously unused target,
 * and every recovery resolves the jailed paths from the current runtime root.
 */
export interface PreparedSkillMutationPlan {
  readonly version: 1;
  readonly skillId: string;
  readonly evaluationRunId: string;
  readonly sourceTurnId?: string;
  readonly summary?: string;
  readonly skillMarkdown: string;
  readonly preparedAt: string;
  readonly changeHash: string;
}

interface MaterializedPreparedSkillMutation {
  readonly plan: PreparedSkillMutationPlan;
  readonly skillDir: string;
  readonly skillFilePath: string;
  readonly sourceJsonPath: string;
  readonly sourceJson: string;
  readonly lifecycle: SkillLifecycleRecord;
  readonly validation: SkillContentValidationResult;
  readonly snapshot: SkillMutationSnapshot;
}

interface SkillMutationWritePlan {
  readonly skillId: string;
  readonly skillDir: string;
  readonly skillFilePath: string;
  readonly sourceJsonPath: string;
  readonly sourceJson: string;
  readonly lifecycle: SkillLifecycleRecord;
  readonly result: SkillMutationResult;
}

export class SkillMutationService {
  private readonly rootDir: string;
  private readonly skillLifecycle: SkillMutationLifecycleStore;
  private readonly now: () => Date;

  public constructor(options: SkillMutationServiceOptions) {
    this.rootDir = options.rootDir;
    this.skillLifecycle = options.skillLifecycle;
    this.now = options.now ?? (() => new Date());
  }

  /** Absolute jail directory under which all self-authored skills are written. */
  public get selfSkillsRoot(): string {
    return path.resolve(this.rootDir, "skills", "self");
  }

  /**
   * Validate + security-scan a draft without writing anything. Throws on a draft
   * that the write path would reject (network/script/secret-laden or invalid).
   */
  public validateDraft(input: DraftSkillMutationInput): SkillContentValidationResult {
    const validation = validateSkillContent({ skillMarkdown: input.skillMarkdown });
    if (!validation.valid) {
      throw new Error(`Skill draft rejected: ${validation.errors.join("; ")}`);
    }
    return validation;
  }

  /**
   * Validate + write the draft as a non-callable `candidate`, returning the
   * lifecycle row and a reversible snapshot. Does not promote to callable.
   */
  public async draftSkillMutation(input: DraftSkillMutationInput): Promise<SkillMutationResult> {
    const replay = await this.readCommittedDraftReplay(input);
    if (replay) {
      return replay;
    }
    return this.applySkillMutation(input);
  }

  /** Compatibility alias retained for one release; persistence is Promise-native. */
  public async draftSkillMutationSync(input: DraftSkillMutationInput): Promise<SkillMutationResult> {
    return await this.draftSkillMutation(input);
  }

  /**
   * Validate and freeze one deterministic durable skill intent without touching
   * either the filesystem or lifecycle store. The target must be unused before
   * this plan is persisted; only the persisted plan may later create it.
   */
  public async prepareDurableSkillMutation(input: DraftSkillMutationInput): Promise<PreparedSkillMutationPlan> {
    const evaluationRunId = input.evaluationRunId?.trim();
    const requestedSkillId = input.skillId?.trim();
    if (!evaluationRunId || !requestedSkillId) {
      throw new Error("Durable skill mutation requires deterministic skillId and evaluationRunId values.");
    }
    const planned = await this.planMutation({ ...input, skillId: requestedSkillId, evaluationRunId });
    if (
      planned.result.snapshot.existed ||
      planned.result.snapshot.priorSourceJson !== undefined ||
      planned.result.snapshot.priorLifecycle !== undefined
    ) {
      throw new Error(`Durable skill mutation target ${planned.skillId} conflicts with pre-existing state.`);
    }
    const provenance = parseSkillMutationProvenance(planned.sourceJson);
    return {
      version: 1,
      skillId: planned.skillId,
      evaluationRunId,
      ...(input.sourceTurnId?.trim() ? { sourceTurnId: input.sourceTurnId.trim() } : {}),
      ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
      skillMarkdown: input.skillMarkdown,
      preparedAt: provenance.authoredAt,
      changeHash: planned.result.changeHash,
    };
  }

  /**
   * Materialize a persisted durable plan outside the database transaction.
   * Existing exact bytes are a replay; missing companion bytes are repaired;
   * any different bytes or foreign lifecycle ownership fail closed.
   */
  public async applyPreparedSkillMutationFilesSync(prepared: PreparedSkillMutationPlan): Promise<void> {
    const plan = this.materializePreparedSkillMutation(prepared);
    await this.assertPreparedLifecycleCompatible(plan);
    fsSync.mkdirSync(plan.skillDir, { recursive: true });
    const createdPaths: string[] = [];
    try {
      if (createOrVerifyExactFileSync(plan.skillFilePath, prepared.skillMarkdown)) {
        createdPaths.push(plan.skillFilePath);
      }
      if (createOrVerifyExactFileSync(plan.sourceJsonPath, plan.sourceJson)) {
        createdPaths.push(plan.sourceJsonPath);
      }
    } catch (error) {
      const rollbackErrors = rollbackCreatedExactFilesSync(createdPaths, plan);
      if (rollbackErrors.length > 0) {
        throw buildSkillMutationRollbackError(error, rollbackErrors);
      }
      throw error;
    }
  }

  /**
   * Commit only database lifecycle state for an already-materialized durable
   * plan. Callers wrap this with the child stage receipt transaction.
   */
  public async commitPreparedSkillMutation(prepared: PreparedSkillMutationPlan): Promise<SkillMutationResult> {
    const plan = this.materializePreparedSkillMutation(prepared);
    assertExactPreparedArtifact(plan.skillFilePath, prepared.skillMarkdown, prepared.evaluationRunId);
    assertExactPreparedArtifact(plan.sourceJsonPath, plan.sourceJson, prepared.evaluationRunId);
    const existing = await this.assertPreparedLifecycleCompatible(plan);
    const lifecycle = existing ?? (await this.skillLifecycle.upsert(plan.lifecycle));
    return {
      skillId: prepared.skillId,
      skillDir: plan.skillDir,
      skillFilePath: plan.skillFilePath,
      lifecycle,
      snapshot: plan.snapshot,
      validation: plan.validation,
      changeHash: prepared.changeHash,
      ...(existing ? { replayed: true } : {}),
    };
  }

  private async readCommittedDraftReplay(input: DraftSkillMutationInput): Promise<SkillMutationResult | undefined> {
    const replay = await this.resolveCommittedDraftReplay(input);
    if (!replay) {
      return undefined;
    }
    let committedMarkdown: string;
    try {
      committedMarkdown = await fs.readFile(replay.skillFilePath, "utf8");
    } catch (error) {
      throw new Error(`Committed replay identity ${input.evaluationRunId} is missing its skill artifact.`, {
        cause: error,
      });
    }
    return await this.buildCommittedDraftReplay(input, replay, committedMarkdown);
  }

  private async resolveCommittedDraftReplay(input: DraftSkillMutationInput): Promise<
    | {
        skillId: string;
        skillDir: string;
        skillFilePath: string;
        sourceJsonPath: string;
        existing: SkillLifecycleRecord;
      }
    | undefined
  > {
    if (!input.evaluationRunId?.trim() || !input.skillId?.trim()) {
      return undefined;
    }
    const skillId = normalizeSkillId(input.skillId);
    const existing = await this.skillLifecycle.find(skillId);
    if (existing?.provenance?.sourceRef !== input.evaluationRunId) {
      return undefined;
    }
    const skillDir = this.resolveSkillDir(skillId);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const sourceJsonPath = path.join(skillDir, "source.json");
    assertWritePathInJail(skillFilePath, [this.selfSkillsRoot]);
    return { skillId, skillDir, skillFilePath, sourceJsonPath, existing };
  }

  private async buildCommittedDraftReplay(
    input: DraftSkillMutationInput,
    replay: NonNullable<Awaited<ReturnType<SkillMutationService["resolveCommittedDraftReplay"]>>>,
    committedMarkdown: string,
  ): Promise<SkillMutationResult> {
    const validation = validateSkillContent({ skillMarkdown: committedMarkdown });
    if (!validation.valid) {
      throw new Error(
        `Committed replay identity ${input.evaluationRunId} has an invalid skill artifact: ${validation.errors.join("; ")}`,
      );
    }
    return {
      skillId: replay.skillId,
      skillDir: replay.skillDir,
      skillFilePath: replay.skillFilePath,
      lifecycle: replay.existing,
      snapshot: await this.captureSnapshot(replay.skillId, replay.skillFilePath, replay.sourceJsonPath),
      validation,
      changeHash: createHash("sha256").update(committedMarkdown, "utf8").digest("hex"),
      replayed: true,
    };
  }

  /**
   * Core governed write: validate → secret-block → jail-write SKILL.md +
   * source.json → lifecycle upsert (candidate, self_generated) → snapshot.
   */
  public async applySkillMutation(input: DraftSkillMutationInput): Promise<SkillMutationResult> {
    const plan = await this.planMutation(input);
    try {
      await fs.mkdir(plan.skillDir, { recursive: true });
      await fs.writeFile(plan.skillFilePath, input.skillMarkdown, "utf8");
      await fs.writeFile(plan.sourceJsonPath, plan.sourceJson, "utf8");
      const stored = await this.skillLifecycle.upsert(plan.lifecycle);
      return { ...plan.result, lifecycle: stored };
    } catch (error) {
      const rollbackErrors = await this.rollbackFailedMutation(plan);
      if (rollbackErrors.length > 0) {
        throw buildSkillMutationRollbackError(error, rollbackErrors);
      }
      throw error;
    }
  }

  /**
   * Synchronous variant of {@link applySkillMutation}. Used by the governed
   * activation path (improvement-service `applyActivationChange`), which is a
   * synchronous state machine.
   */
  public async applySkillMutationSync(input: DraftSkillMutationInput): Promise<SkillMutationResult> {
    const plan = await this.planMutation(input);
    try {
      fsSync.mkdirSync(plan.skillDir, { recursive: true });
      fsSync.writeFileSync(plan.skillFilePath, input.skillMarkdown, "utf8");
      fsSync.writeFileSync(plan.sourceJsonPath, plan.sourceJson, "utf8");
      const stored = await this.skillLifecycle.upsert(plan.lifecycle);
      return { ...plan.result, lifecycle: stored };
    } catch (error) {
      const rollbackErrors = await this.rollbackFailedMutation(plan);
      if (rollbackErrors.length > 0) {
        throw buildSkillMutationRollbackError(error, rollbackErrors);
      }
      throw error;
    }
  }

  /**
   * Capture a pre-mutation snapshot without writing. Used by the activation path
   * to record the rollback point before the candidate is applied.
   */
  public async captureSnapshotFor(input: { skillId?: string; skillMarkdown?: string }): Promise<SkillMutationSnapshot> {
    const skillId = this.resolveSkillIdForSnapshot(input);
    const skillDir = this.resolveSkillDir(skillId);
    return await this.captureSnapshot(skillId, path.join(skillDir, "SKILL.md"), path.join(skillDir, "source.json"));
  }

  private materializePreparedSkillMutation(prepared: PreparedSkillMutationPlan): MaterializedPreparedSkillMutation {
    assertPreparedSkillMutationShape(prepared);
    const validation = this.validateDraft({
      skillMarkdown: prepared.skillMarkdown,
      skillId: prepared.skillId,
      evaluationRunId: prepared.evaluationRunId,
      sourceTurnId: prepared.sourceTurnId,
      summary: prepared.summary,
    });
    const skillId = this.resolveSkillId(
      { skillMarkdown: prepared.skillMarkdown, skillId: prepared.skillId },
      validation,
    );
    if (skillId !== prepared.skillId) {
      throw new Error(`Durable skill plan identity ${prepared.skillId} does not match its validated skill id.`);
    }
    const changeHash = createHash("sha256").update(prepared.skillMarkdown, "utf8").digest("hex");
    if (changeHash !== prepared.changeHash) {
      throw new Error(`Durable skill plan ${prepared.evaluationRunId} failed its content hash check.`);
    }
    const skillDir = this.resolveSkillDir(skillId);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const sourceJsonPath = path.join(skillDir, "source.json");
    assertWritePathInJail(skillFilePath, [this.selfSkillsRoot]);
    assertWritePathInJail(sourceJsonPath, [this.selfSkillsRoot]);
    const provenance: SkillMutationProvenance = {
      source: "self_generated",
      evaluationRunId: prepared.evaluationRunId,
      sourceTurnId: prepared.sourceTurnId,
      summary: prepared.summary,
      authoredAt: prepared.preparedAt,
    };
    const lifecycle: SkillLifecycleRecord = {
      skillId,
      category: "self_generated",
      lifecycleState: "candidate",
      trustLabel: "Self-authored (candidate)",
      reviewWarning: "Self-authored skill is non-callable until governed activation.",
      provenance: {
        source: "self_generated",
        sourceRef: prepared.evaluationRunId,
        sourceProvider: "self_generated",
      },
      createdAt: prepared.preparedAt,
      updatedAt: prepared.preparedAt,
    };
    const sourceJson = `${JSON.stringify(provenance, null, 2)}\n`;
    assertSkillSourceManifestSize(sourceJson);
    return {
      plan: prepared,
      skillDir,
      skillFilePath,
      sourceJsonPath,
      sourceJson,
      lifecycle,
      validation,
      snapshot: {
        skillId,
        skillFilePath,
        existed: false,
        capturedAt: prepared.preparedAt,
      },
    };
  }

  private async assertPreparedLifecycleCompatible(
    plan: MaterializedPreparedSkillMutation,
  ): Promise<SkillLifecycleRecord | undefined> {
    const existing = await this.skillLifecycle.find(plan.plan.skillId);
    if (!existing) {
      return undefined;
    }
    if (
      existing.category !== "self_generated" ||
      existing.provenance?.sourceRef !== plan.plan.evaluationRunId ||
      existing.provenance?.sourceProvider !== "self_generated" ||
      existing.lifecycleState === "revoked"
    ) {
      throw new Error(`Durable skill mutation target ${plan.plan.skillId} has conflicting lifecycle ownership.`);
    }
    return existing;
  }

  private async rollbackFailedMutation(plan: SkillMutationWritePlan): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      await restoreMutationFiles(plan, plan.result.snapshot);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.restoreFailedMutationLifecycle(plan);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async restoreFailedMutationLifecycle(plan: SkillMutationWritePlan): Promise<void> {
    const prior = plan.result.snapshot.priorLifecycle;
    if (prior) {
      await this.skillLifecycle.upsert(prior);
      return;
    }
    const current = await this.skillLifecycle.find(plan.skillId);
    if (!current || current.provenance?.sourceRef !== plan.lifecycle.provenance?.sourceRef) {
      return;
    }
    await this.skillLifecycle.upsert({
      ...current,
      lifecycleState: "revoked",
      trustLabel: "Self-authored (incomplete mutation)",
      reviewWarning: "Skill mutation rolled back after an incomplete persistence boundary.",
      updatedAt: this.now().toISOString(),
    });
  }

  /** Validate, jail-resolve, and assemble all write artifacts without touching disk. */
  private async planMutation(input: DraftSkillMutationInput): Promise<SkillMutationWritePlan> {
    const validation = this.validateDraft(input);
    const skillId = this.resolveSkillId(input, validation);
    const skillDir = this.resolveSkillDir(skillId);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const sourceJsonPath = path.join(skillDir, "source.json");

    // Path-jail every write so a crafted skill id (e.g. traversal) cannot escape.
    assertWritePathInJail(skillFilePath, [this.selfSkillsRoot]);
    assertWritePathInJail(sourceJsonPath, [this.selfSkillsRoot]);

    const snapshot = await this.captureSnapshot(skillId, skillFilePath, sourceJsonPath);
    const authoredAt = this.now().toISOString();
    const provenance: SkillMutationProvenance = {
      source: "self_generated",
      evaluationRunId: input.evaluationRunId,
      sourceTurnId: input.sourceTurnId,
      summary: input.summary,
      authoredAt,
    };
    const lifecycle: SkillLifecycleRecord = {
      skillId,
      category: "self_generated",
      lifecycleState: "candidate",
      trustLabel: "Self-authored (candidate)",
      reviewWarning: "Self-authored skill is non-callable until governed activation.",
      provenance: {
        source: "self_generated",
        sourceRef: input.evaluationRunId ?? input.sourceTurnId,
        sourceProvider: "self_generated",
      },
      createdAt: snapshot.priorLifecycle?.createdAt ?? authoredAt,
      updatedAt: authoredAt,
    };
    const sourceJson = `${JSON.stringify(provenance, null, 2)}\n`;
    assertSkillSourceManifestSize(sourceJson);
    return {
      skillId,
      skillDir,
      skillFilePath,
      sourceJsonPath,
      sourceJson,
      lifecycle,
      result: {
        skillId,
        skillDir,
        skillFilePath,
        lifecycle,
        snapshot,
        validation,
        changeHash: createHash("sha256").update(input.skillMarkdown, "utf8").digest("hex"),
      },
    };
  }

  /**
   * Promote a self-authored `candidate` to `approved` so it becomes callable.
   * Intended to be invoked ONLY by the governed activation path under master
   * autonomy. Returns the updated lifecycle row.
   */
  public async promoteSelfAuthoredSkill(skillId: string): Promise<SkillLifecycleRecord> {
    const existing = await this.skillLifecycle.find(skillId);
    if (!existing) {
      throw new Error(`Cannot promote unknown self-authored skill: ${skillId}`);
    }
    if (existing.category !== "self_generated") {
      throw new Error(`Refusing to promote non-self-authored skill via skill mutation path: ${skillId}`);
    }
    if (existing.lifecycleState === "approved" || existing.lifecycleState === "trusted") {
      return existing;
    }
    return await this.skillLifecycle.upsert({
      ...existing,
      lifecycleState: "approved",
      trustLabel: "Self-authored (approved)",
      reviewWarning: undefined,
      updatedAt: this.now().toISOString(),
    });
  }

  /** Restore a snapshot: revert the SKILL.md bytes and lifecycle row (or remove). */
  public async restoreSnapshot(snapshot: SkillMutationSnapshot): Promise<void> {
    assertValidSnapshotSkillId(snapshot);
    const skillDir = this.resolveSkillDir(snapshot.skillId);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const sourceJsonPath = path.join(skillDir, "source.json");

    if (snapshot.existed) {
      await fs.mkdir(skillDir, { recursive: true });
      assertWritePathInJail(skillFilePath, [this.selfSkillsRoot]);
      if (snapshot.priorSkillMarkdown !== undefined) {
        await fs.writeFile(skillFilePath, snapshot.priorSkillMarkdown, "utf8");
      }
      if (snapshot.priorSourceJson !== undefined) {
        assertWritePathInJail(sourceJsonPath, [this.selfSkillsRoot]);
        await fs.writeFile(sourceJsonPath, snapshot.priorSourceJson, "utf8");
      }
      if (snapshot.priorLifecycle) {
        await this.skillLifecycle.upsert(snapshot.priorLifecycle);
      }
      return;
    }

    // Skill did not exist before the mutation: remove the authored files and
    // tombstone the lifecycle row to non-callable so it can never execute.
    assertWritePathInJail(skillDir, [this.selfSkillsRoot]);
    await fs.rm(skillDir, { recursive: true, force: true });
    const current = await this.skillLifecycle.find(snapshot.skillId);
    if (current) {
      await this.skillLifecycle.upsert({
        ...current,
        lifecycleState: "revoked",
        trustLabel: "Self-authored (reverted)",
        reviewWarning: "Self-authored skill reverted by rollback; file removed.",
        updatedAt: this.now().toISOString(),
      });
    }
  }

  /** Compatibility alias retained for one release; persistence is Promise-native. */
  public async restoreSnapshotSync(snapshot: SkillMutationSnapshot): Promise<void> {
    await this.restoreSnapshot(snapshot);
  }

  private resolveSkillIdForSnapshot(input: { skillId?: string; skillMarkdown?: string }): string {
    if (input.skillId?.trim()) {
      return normalizeSkillId(input.skillId);
    }
    if (input.skillMarkdown) {
      const validation = validateSkillContent({ skillMarkdown: input.skillMarkdown });
      if (validation.inferredSkillId) {
        return validation.inferredSkillId;
      }
    }
    throw new Error("Cannot resolve skill id for snapshot (provide skillId or a parseable skillMarkdown).");
  }

  private async captureSnapshot(
    skillId: string,
    skillFilePath: string,
    sourceJsonPath: string,
  ): Promise<SkillMutationSnapshot> {
    const existed = fsSync.existsSync(skillFilePath);
    return {
      skillId,
      skillFilePath,
      existed,
      priorSkillMarkdown: existed ? fsSync.readFileSync(skillFilePath, "utf8") : undefined,
      priorSourceJson: fsSync.existsSync(sourceJsonPath)
        ? readBoundedSkillSourceManifestTextSync(sourceJsonPath)
        : undefined,
      priorLifecycle: await this.skillLifecycle.find(skillId),
      capturedAt: this.now().toISOString(),
    };
  }

  private resolveSkillId(input: DraftSkillMutationInput, validation: SkillContentValidationResult): string {
    const candidate = input.skillId?.trim() || validation.inferredSkillId;
    if (!candidate) {
      throw new Error("Skill draft has no resolvable skill id (missing frontmatter name).");
    }
    // Re-normalize even an explicit id so traversal/separators are rejected.
    return normalizeSkillId(candidate);
  }

  private resolveSkillDir(skillId: string): string {
    const skillDir = path.resolve(this.selfSkillsRoot, skillId);
    assertWritePathInJail(skillDir, [this.selfSkillsRoot]);
    return skillDir;
  }
}

function assertPreparedSkillMutationShape(prepared: PreparedSkillMutationPlan): void {
  if (
    prepared.version !== 1 ||
    typeof prepared.skillId !== "string" ||
    !prepared.skillId.trim() ||
    typeof prepared.evaluationRunId !== "string" ||
    !prepared.evaluationRunId.trim() ||
    typeof prepared.skillMarkdown !== "string" ||
    typeof prepared.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(prepared.preparedAt)) ||
    typeof prepared.changeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(prepared.changeHash) ||
    (prepared.sourceTurnId !== undefined && typeof prepared.sourceTurnId !== "string") ||
    (prepared.summary !== undefined && typeof prepared.summary !== "string")
  ) {
    throw new Error("Persisted durable skill mutation plan is malformed.");
  }
}

function parseSkillMutationProvenance(sourceJson: string): SkillMutationProvenance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceJson);
  } catch (error) {
    throw new Error("Prepared skill provenance is malformed.", { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { source?: unknown }).source !== "self_generated" ||
    typeof (parsed as { authoredAt?: unknown }).authoredAt !== "string"
  ) {
    throw new Error("Prepared skill provenance is malformed.");
  }
  return parsed as SkillMutationProvenance;
}

function createOrVerifyExactFileSync(filePath: string, expected: string): boolean {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let createdTarget: boolean | undefined;
  let operationError: unknown;
  try {
    fsSync.writeFileSync(tempPath, expected, { encoding: "utf8", flag: "wx" });
    try {
      fsSync.linkSync(tempPath, filePath);
      createdTarget = true;
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) {
        throw error;
      }
      assertExactPreparedArtifact(filePath, expected, "persisted plan");
      createdTarget = false;
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    fsSync.rmSync(tempPath, { force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError) {
    throw cleanupError ? buildSkillMutationRollbackError(operationError, [cleanupError]) : operationError;
  }
  if (createdTarget === undefined) {
    throw cleanupError ?? new Error(`Durable skill artifact ${path.basename(filePath)} was not published.`);
  }
  // The exact target has already been atomically published or verified. A
  // hidden, non-callable temp file is cleanup debt, not a reason to make the
  // caller lose ownership of the successfully published target.
  return createdTarget;
}

function assertExactPreparedArtifact(filePath: string, expected: string, planId: string): void {
  let actual: string;
  try {
    actual =
      path.basename(filePath) === "source.json"
        ? readBoundedSkillSourceManifestTextSync(filePath)
        : fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Durable skill plan ${planId} is missing required artifact ${path.basename(filePath)}.`, {
      cause: error,
    });
  }
  if (actual !== expected) {
    throw new Error(`Durable skill plan ${planId} conflicts with existing ${path.basename(filePath)} bytes.`);
  }
}

function rollbackCreatedExactFilesSync(
  createdPaths: readonly string[],
  plan: MaterializedPreparedSkillMutation,
): unknown[] {
  const errors: unknown[] = [];
  for (const filePath of [...createdPaths].reverse()) {
    const expected = filePath === plan.skillFilePath ? plan.plan.skillMarkdown : plan.sourceJson;
    try {
      assertExactPreparedArtifact(filePath, expected, plan.plan.evaluationRunId);
      fsSync.rmSync(filePath, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  tryRemoveEmptyDirectorySync(plan.skillDir, errors);
  return errors;
}

async function restoreMutationFiles(plan: SkillMutationWritePlan, snapshot: SkillMutationSnapshot): Promise<void> {
  await fs.mkdir(plan.skillDir, { recursive: true });
  if (snapshot.priorSkillMarkdown !== undefined) {
    await fs.writeFile(plan.skillFilePath, snapshot.priorSkillMarkdown, "utf8");
  } else {
    await fs.rm(plan.skillFilePath, { force: true });
  }
  if (snapshot.priorSourceJson !== undefined) {
    await fs.writeFile(plan.sourceJsonPath, snapshot.priorSourceJson, "utf8");
  } else {
    await fs.rm(plan.sourceJsonPath, { force: true });
  }
  if (!snapshot.existed && snapshot.priorSourceJson === undefined) {
    try {
      await fs.rmdir(plan.skillDir);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT") && !isNodeErrorCode(error, "ENOTEMPTY")) {
        throw error;
      }
    }
  }
}

function tryRemoveEmptyDirectorySync(skillDir: string, errors: unknown[]): void {
  try {
    fsSync.rmdirSync(skillDir);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT") && !isNodeErrorCode(error, "ENOTEMPTY")) {
      errors.push(error);
    }
  }
}

function buildSkillMutationRollbackError(original: unknown, rollbackErrors: readonly unknown[]): AggregateError {
  const message = original instanceof Error ? original.message : "Skill mutation failed.";
  return new AggregateError(
    [original, ...rollbackErrors],
    `${message} Rollback also failed; manual reconciliation is required.`,
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

/**
 * Guard against a malformed snapshot reaching the restore path. Snapshots are
 * deserialized from the autonomy-audit / activation rails via a type cast (no
 * runtime validation), so a missing/empty `skillId` could otherwise resolve to
 * the self-skills jail ROOT itself — and the "did-not-exist" restore branch
 * `fs.rm(skillDir, { recursive: true })` would then wipe every self-authored
 * skill. The jail assertion does not catch the empty-id case (the root resolves
 * inside itself), so reject it explicitly here. Path traversal is still caught by
 * `assertWritePathInJail` downstream.
 */
function assertValidSnapshotSkillId(snapshot: SkillMutationSnapshot): void {
  if (typeof snapshot.skillId !== "string" || snapshot.skillId.trim().length === 0) {
    throw new Error("Skill mutation snapshot has an invalid (empty) skillId; refusing to restore.");
  }
}
