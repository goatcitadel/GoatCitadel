import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { SkillLifecycleRecord } from "@goatcitadel/contracts";
import { normalizeSkillId } from "./skill-import-service.js";
import { validateSkillContent, type SkillContentValidationResult } from "./skill-content-validation.js";

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
  find(skillId: string): SkillLifecycleRecord | undefined;
  upsert(input: SkillLifecycleRecord): SkillLifecycleRecord;
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
    return this.applySkillMutation(input);
  }

  /**
   * Core governed write: validate → secret-block → jail-write SKILL.md +
   * source.json → lifecycle upsert (candidate, self_generated) → snapshot.
   */
  public async applySkillMutation(input: DraftSkillMutationInput): Promise<SkillMutationResult> {
    const plan = this.planMutation(input);
    await fs.mkdir(plan.skillDir, { recursive: true });
    await fs.writeFile(plan.skillFilePath, input.skillMarkdown, "utf8");
    await fs.writeFile(plan.sourceJsonPath, plan.sourceJson, "utf8");
    const stored = this.skillLifecycle.upsert(plan.lifecycle);
    return { ...plan.result, lifecycle: stored };
  }

  /**
   * Synchronous variant of {@link applySkillMutation}. Used by the governed
   * activation path (improvement-service `applyActivationChange`), which is a
   * synchronous state machine.
   */
  public applySkillMutationSync(input: DraftSkillMutationInput): SkillMutationResult {
    const plan = this.planMutation(input);
    fsSync.mkdirSync(plan.skillDir, { recursive: true });
    fsSync.writeFileSync(plan.skillFilePath, input.skillMarkdown, "utf8");
    fsSync.writeFileSync(plan.sourceJsonPath, plan.sourceJson, "utf8");
    const stored = this.skillLifecycle.upsert(plan.lifecycle);
    return { ...plan.result, lifecycle: stored };
  }

  /**
   * Capture a pre-mutation snapshot without writing. Used by the activation path
   * to record the rollback point before the candidate is applied.
   */
  public captureSnapshotFor(input: { skillId?: string; skillMarkdown?: string }): SkillMutationSnapshot {
    const skillId = this.resolveSkillIdForSnapshot(input);
    const skillDir = this.resolveSkillDir(skillId);
    return this.captureSnapshot(skillId, path.join(skillDir, "SKILL.md"), path.join(skillDir, "source.json"));
  }

  /** Validate, jail-resolve, and assemble all write artifacts without touching disk. */
  private planMutation(input: DraftSkillMutationInput): {
    skillId: string;
    skillDir: string;
    skillFilePath: string;
    sourceJsonPath: string;
    sourceJson: string;
    lifecycle: SkillLifecycleRecord;
    result: SkillMutationResult;
  } {
    const validation = this.validateDraft(input);
    const skillId = this.resolveSkillId(input, validation);
    const skillDir = this.resolveSkillDir(skillId);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const sourceJsonPath = path.join(skillDir, "source.json");

    // Path-jail every write so a crafted skill id (e.g. traversal) cannot escape.
    assertWritePathInJail(skillFilePath, [this.selfSkillsRoot]);
    assertWritePathInJail(sourceJsonPath, [this.selfSkillsRoot]);

    const snapshot = this.captureSnapshot(skillId, skillFilePath, sourceJsonPath);
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
    return {
      skillId,
      skillDir,
      skillFilePath,
      sourceJsonPath,
      sourceJson: `${JSON.stringify(provenance, null, 2)}\n`,
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
  public promoteSelfAuthoredSkill(skillId: string): SkillLifecycleRecord {
    const existing = this.skillLifecycle.find(skillId);
    if (!existing) {
      throw new Error(`Cannot promote unknown self-authored skill: ${skillId}`);
    }
    if (existing.category !== "self_generated") {
      throw new Error(`Refusing to promote non-self-authored skill via skill mutation path: ${skillId}`);
    }
    if (existing.lifecycleState === "approved" || existing.lifecycleState === "trusted") {
      return existing;
    }
    return this.skillLifecycle.upsert({
      ...existing,
      lifecycleState: "approved",
      trustLabel: "Self-authored (approved)",
      reviewWarning: undefined,
      updatedAt: this.now().toISOString(),
    });
  }

  /** Restore a snapshot: revert the SKILL.md bytes and lifecycle row (or remove). */
  public async restoreSnapshot(snapshot: SkillMutationSnapshot): Promise<void> {
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
        this.skillLifecycle.upsert(snapshot.priorLifecycle);
      }
      return;
    }

    // Skill did not exist before the mutation: remove the authored files and
    // tombstone the lifecycle row to non-callable so it can never execute.
    assertWritePathInJail(skillDir, [this.selfSkillsRoot]);
    await fs.rm(skillDir, { recursive: true, force: true });
    const current = this.skillLifecycle.find(snapshot.skillId);
    if (current) {
      this.skillLifecycle.upsert({
        ...current,
        lifecycleState: "revoked",
        trustLabel: "Self-authored (reverted)",
        reviewWarning: "Self-authored skill reverted by rollback; file removed.",
        updatedAt: this.now().toISOString(),
      });
    }
  }

  /** Synchronous variant of {@link restoreSnapshot} for the activation path. */
  public restoreSnapshotSync(snapshot: SkillMutationSnapshot): void {
    const skillDir = this.resolveSkillDir(snapshot.skillId);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const sourceJsonPath = path.join(skillDir, "source.json");

    if (snapshot.existed) {
      fsSync.mkdirSync(skillDir, { recursive: true });
      assertWritePathInJail(skillFilePath, [this.selfSkillsRoot]);
      if (snapshot.priorSkillMarkdown !== undefined) {
        fsSync.writeFileSync(skillFilePath, snapshot.priorSkillMarkdown, "utf8");
      }
      if (snapshot.priorSourceJson !== undefined) {
        assertWritePathInJail(sourceJsonPath, [this.selfSkillsRoot]);
        fsSync.writeFileSync(sourceJsonPath, snapshot.priorSourceJson, "utf8");
      }
      if (snapshot.priorLifecycle) {
        this.skillLifecycle.upsert(snapshot.priorLifecycle);
      }
      return;
    }

    assertWritePathInJail(skillDir, [this.selfSkillsRoot]);
    fsSync.rmSync(skillDir, { recursive: true, force: true });
    const current = this.skillLifecycle.find(snapshot.skillId);
    if (current) {
      this.skillLifecycle.upsert({
        ...current,
        lifecycleState: "revoked",
        trustLabel: "Self-authored (reverted)",
        reviewWarning: "Self-authored skill reverted by rollback; file removed.",
        updatedAt: this.now().toISOString(),
      });
    }
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

  private captureSnapshot(skillId: string, skillFilePath: string, sourceJsonPath: string): SkillMutationSnapshot {
    const existed = fsSync.existsSync(skillFilePath);
    return {
      skillId,
      skillFilePath,
      existed,
      priorSkillMarkdown: existed ? fsSync.readFileSync(skillFilePath, "utf8") : undefined,
      priorSourceJson: fsSync.existsSync(sourceJsonPath) ? fsSync.readFileSync(sourceJsonPath, "utf8") : undefined,
      priorLifecycle: this.skillLifecycle.find(skillId),
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
