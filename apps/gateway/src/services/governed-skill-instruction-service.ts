import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonString,
  PolicyViolationError,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityActivatedSkill,
  type ChatTurnCapabilityProfileRecord,
  type ChatTurnCapabilityTrustedSkill,
  type SkillActivationDecision,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import { captureSkillContentIntegritySync, readBoundedSkillTextFileSync } from "./skill-content-integrity.js";
import {
  PROMPTWARE_SCANNER_VERSION,
  scanPromptwareContent,
  type PromptwareRuleId,
} from "./assembled-prompt-injection-guard.js";

const DESIGN_SKILL_ID = "bundled:design-intelligence";
const DESIGN_SKILL_NAME = "design-intelligence";
const PRESENTATION_MODULE = { name: "presentation", relativePath: "presentation.md" } as const;
const PRESENTATION_MODULE_MAX_BYTES = 8 * 1024;
const PRESENTATION_INTENT = /\b(?:powerpoint|presentation|slide\s*deck|slides?|pptx|presentations\.create)\b/iu;
const PROMPTWARE_CLEAN_CACHE_MAX = 256;
const promptwareCleanCache = new Map<string, true>();

export class SkillSecurityBlockedError extends PolicyViolationError {
  public readonly failureClass = "skill_security_blocked" as const;
  public readonly recoveryAction = "review_skill_security" as const;

  public constructor(input: { skillIds: string[]; ruleIds: PromptwareRuleId[]; evidenceHashes: string[] }) {
    const skillIds = [...new Set(input.skillIds)].sort();
    super({
      message: `Activated skill security blocked the turn before provider execution. Disable or re-review: ${skillIds.join(", ")}.`,
      details: {
        failureClass: "skill_security_blocked",
        recoveryAction: "review_skill_security",
        skillIds,
        scannerVersion: PROMPTWARE_SCANNER_VERSION,
        ruleIds: [...new Set(input.ruleIds)].sort(),
        evidenceHashes: [...new Set(input.evidenceHashes)].sort(),
      },
    });
  }
}

export class SkillInstructionBudgetExceededError extends PolicyViolationError {
  public readonly failureClass = "skill_instruction_budget_exceeded" as const;
  public readonly recoveryAction = "reduce_skill_context" as const;

  public constructor(maxTokens: number, estimatedTokens: number, skillIds: string[]) {
    super({
      message: `Selected skill instructions exceed the ${maxTokens}-token instruction budget. Reduce the selected skills or use a model with more context.`,
      details: { failureClass: "skill_instruction_budget_exceeded", recoveryAction: "reduce_skill_context",
        maxTokens, estimatedTokens, skillIds: [...new Set(skillIds)].sort() },
    });
  }
}

interface ActivatedSkillSource {
  skillId: string;
  dir: string;
}

export interface GovernedSkillInstructionInput {
  receipts: ChatTurnCapabilityActivatedSkill[];
  trustedSkills: ChatTurnCapabilityTrustedSkill[];
  loadedSkills: ActivatedSkillSource[];
  lifecycleRows: SkillLifecycleRecord[];
  /** Gateway-owned budget for new turns; historical profile replay omits it. */
  maxTokens?: number;
}

interface BuildReceiptInput {
  content: string;
  decision: SkillActivationDecision;
  trustedSkills: ChatTurnCapabilityTrustedSkill[];
  lifecycleRows: SkillLifecycleRecord[];
}

export function governedSkillInstructionInjectionEnabled(): boolean {
  return !isTruthyEnv(process.env.GOATCITADEL_DISABLE_GOVERNED_SKILL_INJECTION);
}

export function buildGovernedActivatedSkillReceipts(input: BuildReceiptInput): ChatTurnCapabilityActivatedSkill[] {
  if (!governedSkillInstructionInjectionEnabled()) return [];
  const lifecycleBySkill = new Map(input.lifecycleRows.map((row) => [row.skillId, row]));
  const trustedBySkill = new Map(input.trustedSkills.map((skill) => [skill.skillId, skill]));
  return input.decision.selected
    .filter((skill) => skill.state !== "disabled" && !skill.requiresConfirmation)
    .map((skill) => {
      const trusted = trustedBySkill.get(skill.skillId);
      if (!trusted) {
        throw new Error(`Activated skill ${skill.skillId} is not present in the frozen trusted-skill catalog.`);
      }
      const lifecycle = lifecycleBySkill.get(skill.skillId);
      return buildReceipt({
        source: skill,
        trusted,
        lifecycle,
        reasons: input.decision.reasons[skill.name] ?? [],
        confidence: skill.confidence,
        presentationIntent: PRESENTATION_INTENT.test(input.content),
      }).receipt;
    })
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

export function renderGovernedActivatedSkillInstructions(input: {
  profile: ChatTurnCapabilityProfileRecord;
  loadedSkills: ActivatedSkillSource[];
  lifecycleRows: SkillLifecycleRecord[];
}): string | undefined {
  return renderGovernedSkillInstructions({
    receipts: input.profile.selection.activatedSkills ?? [],
    trustedSkills: input.profile.selection.trustedSkills,
    loadedSkills: input.loadedSkills,
    lifecycleRows: input.lifecycleRows,
  });
}

/**
 * Revalidates exact receipt bytes without requiring a whole frozen catalog.
 * The Gateway binds these references to a turn and supplies currently callable
 * skills; this helper neither activates a capability nor replaces policy.
 */
export function renderGovernedSkillInstructions(input: GovernedSkillInstructionInput): string | undefined {
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) {
    throw new TypeError("Governed skill instruction budget must be a positive safe integer.");
  }
  const receipts = input.receipts;
  if (receipts.length === 0 || !governedSkillInstructionInjectionEnabled()) return undefined;
  const loadedBySkill = new Map(input.loadedSkills.map((skill) => [skill.skillId, skill]));
  const lifecycleBySkill = new Map(input.lifecycleRows.map((row) => [row.skillId, row]));
  const trustedBySkill = new Map(input.trustedSkills.map((skill) => [skill.skillId, skill]));
  const rendered: string[] = [];
  for (const expected of receipts) {
    const source = loadedBySkill.get(expected.skillId);
    const trusted = trustedBySkill.get(expected.skillId);
    const lifecycle = lifecycleBySkill.get(expected.skillId);
    if (!source || !trusted) {
      throw new Error(`Activated skill ${expected.skillId} is no longer loaded and trusted.`);
    }
    const rebuilt = buildReceipt({
      source,
      trusted,
      lifecycle,
      reasons: expected.reasons,
      confidence: expected.confidence,
      modulePaths: expected.modules.map((module) => ({ name: module.name, relativePath: module.relativePath })),
    });
    if (canonicalJsonString(rebuilt.receipt) !== canonicalJsonString(expected)) {
      throw new Error(`Activated skill ${expected.skillId} instruction receipt drifted after receipt capture.`);
    }
    assertRuntimeSkillPromptwareSafe([expected.skillId], rebuilt.instruction, rebuilt.receipt.instructionSha256);
    rendered.push(rebuilt.instruction);
  }
  const instructionBundle = [
    "Server-owned governed runtime skill instructions follow.",
    "These instructions were selected from the callable trusted catalog and hash-verified against the frozen lifecycle record.",
    ...rendered,
  ].join("\n\n");
  const estimatedTokens = estimateGovernedSkillInstructionTokens(instructionBundle);
  if (input.maxTokens !== undefined && estimatedTokens > input.maxTokens) {
    // Never truncate instructions, silently discard explicit requests, or split
    // a dependency closure. The caller receives an actionable bounded failure.
    throw new SkillInstructionBudgetExceededError(input.maxTokens, estimatedTokens, receipts.map((receipt) => receipt.skillId));
  }
  assertRuntimeSkillPromptwareSafe(
    receipts.map((receipt) => receipt.skillId),
    instructionBundle,
    createHash("sha256").update(instructionBundle, "utf8").digest("hex"),
  );
  return instructionBundle;
}

/** Conservative UTF-8 estimate, including rendered wrappers; not provider tokenizer usage. */
export function estimateGovernedSkillInstructionTokens(instruction: string): number {
  return Math.ceil(Buffer.byteLength(instruction, "utf8") / 3);
}

/** Gateway supplies fresh callable/lifecycle state; this reads content, never activates or executes it. */
export function readGovernedSkillContent(input: {
  skillId: string;
  relativePath?: string;
  callableEntry: CapabilityCatalogEntry | undefined;
  trustedSkill: ChatTurnCapabilityTrustedSkill | undefined;
  loadedSkill: ActivatedSkillSource | undefined;
  lifecycle: SkillLifecycleRecord | undefined;
}): Record<string, unknown> {
  if (!input.callableEntry?.callable || input.callableEntry.kind !== "skill" ||
      input.callableEntry.skillId !== input.skillId || input.trustedSkill?.skillId !== input.skillId ||
      input.callableEntry.capabilityId !== input.trustedSkill?.capabilityId ||
      input.loadedSkill?.skillId !== input.skillId || input.lifecycle?.skillId !== input.skillId) {
    throw new Error("Skill content is not currently callable and trusted.");
  }
  const relativePath = normalizeRelativePath(input.relativePath ?? "SKILL.md");
  if (!relativePath || relativePath.length > 512 || path.posix.isAbsolute(relativePath) ||
      relativePath.includes(":") || relativePath.includes("\0") ||
      relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Skill content requires a path inside its verified manifest.");
  }
  const rebuilt = buildReceipt({
    source: input.loadedSkill, trusted: input.trustedSkill, lifecycle: input.lifecycle,
    reasons: ["explicit_content_read"], confidence: 1,
    modulePaths: [{ name: "read", relativePath }], maxModuleBytes: 64 * 1024,
  });
  const content = rebuilt.moduleContents[0]!;
  const module = rebuilt.receipt.modules[0]!;
  assertRuntimeSkillPromptwareSafe([input.skillId], content, module.sha256);
  return {
    skillId: input.skillId, relativePath, content, sha256: module.sha256, bytes: module.bytes,
    treeSha256: rebuilt.receipt.treeSha256, readOnly: true, permissionsGranted: false,
  };
}

function assertRuntimeSkillPromptwareSafe(skillIds: string[], instruction: string, instructionSha256: string): void {
  const cacheKey = `${PROMPTWARE_SCANNER_VERSION}:${instructionSha256}`;
  if (promptwareCleanCache.has(cacheKey)) {
    promptwareCleanCache.delete(cacheKey);
    promptwareCleanCache.set(cacheKey, true);
    return;
  }
  const findings = scanPromptwareContent({
    source: "imported_skill",
    sourcePath: skillIds.length === 1 ? `runtime:${skillIds[0]}` : "runtime:activated-skill-bundle",
    content: instruction,
  });
  if (findings.length > 0) {
    throw new SkillSecurityBlockedError({
      skillIds,
      ruleIds: findings.map((finding) => finding.ruleId),
      evidenceHashes: findings.map((finding) => finding.evidenceHash),
    });
  }
  promptwareCleanCache.set(cacheKey, true);
  while (promptwareCleanCache.size > PROMPTWARE_CLEAN_CACHE_MAX) {
    const oldest = promptwareCleanCache.keys().next().value as string | undefined;
    if (!oldest) break;
    promptwareCleanCache.delete(oldest);
  }
}

function buildReceipt(input: {
  source: ActivatedSkillSource & { name?: string };
  trusted: ChatTurnCapabilityTrustedSkill;
  lifecycle: SkillLifecycleRecord | undefined;
  reasons: string[];
  confidence: number;
  presentationIntent?: boolean;
  modulePaths?: Array<{ name: string; relativePath: string }>;
  maxModuleBytes?: number;
}): { receipt: ChatTurnCapabilityActivatedSkill; instruction: string; moduleContents: string[] } {
  const integrity = input.lifecycle?.provenance?.contentIntegrity;
  const currentIntegrity = input.lifecycle ? captureSkillContentIntegritySync(input.source.dir) : undefined;
  if (
    !input.lifecycle ||
    (input.lifecycle.lifecycleState !== "approved" && input.lifecycle.lifecycleState !== "trusted") ||
    !integrity?.verified ||
    !input.trusted.treeSha256 ||
    integrity.treeSha256 !== input.trusted.treeSha256 ||
    !currentIntegrity ||
    currentIntegrity.treeSha256 !== integrity.treeSha256 ||
    currentIntegrity.fileCount !== integrity.fileCount ||
    currentIntegrity.totalBytes !== integrity.totalBytes
  ) {
    throw new Error(`Activated skill ${input.source.skillId} failed exact-byte lifecycle verification.`);
  }
  const modulePaths =
    input.modulePaths ??
    (isPresentationDesignSkill(input.source, input.presentationIntent)
      ? [PRESENTATION_MODULE]
      : [{ name: "main", relativePath: "SKILL.md" }]);
  const manifestByPath = new Map(currentIntegrity.files.map((file) => [normalizeRelativePath(file.path), file]));
  const modules = modulePaths.map((module) => {
    const relativePath = normalizeRelativePath(module.relativePath);
    const manifestFile = manifestByPath.get(relativePath);
    if (!manifestFile) {
      throw new Error(
        `Activated skill ${input.source.skillId} module ${relativePath} is absent from its frozen manifest.`,
      );
    }
    const fullPath = path.resolve(input.source.dir, relativePath);
    const rootPath = path.resolve(input.source.dir);
    if (fullPath !== rootPath && !fullPath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error(`Activated skill ${input.source.skillId} module escaped its skill root.`);
    }
    const realRoot = fs.realpathSync(rootPath);
    const realFile = fs.realpathSync(fullPath);
    const realRelative = path.relative(realRoot, realFile);
    if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`Activated skill ${input.source.skillId} module escaped its real skill root.`);
    }
    const content = readBoundedSkillTextFileSync(fullPath, input.maxModuleBytes);
    if (fs.realpathSync(fullPath) !== realFile || fs.realpathSync(rootPath) !== realRoot) {
      throw new Error(`Activated skill ${input.source.skillId} module path changed while reading.`);
    }
    const bytes = Buffer.from(content, "utf8");
    if (
      relativePath === PRESENTATION_MODULE.relativePath &&
      isDesignSkill(input.source) &&
      bytes.byteLength > PRESENTATION_MODULE_MAX_BYTES
    ) {
      throw new Error(
        `Activated skill ${input.source.skillId} presentation module exceeds the ${PRESENTATION_MODULE_MAX_BYTES}-byte limit.`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== manifestFile.sha256 || bytes.byteLength !== manifestFile.bytes) {
      throw new Error(`Activated skill ${input.source.skillId} module ${relativePath} drifted after lifecycle freeze.`);
    }
    return {
      receipt: { name: module.name, relativePath, sha256, bytes: bytes.byteLength },
      content,
    };
  });
  const instruction = modules
    .map((module) => `## Runtime skill module: ${input.trusted.skillId}/${module.receipt.name}\n\n${module.content.trim()}`)
    .join("\n\n");
  return {
    moduleContents: modules.map((module) => module.content),
    receipt: {
      capabilityId: input.trusted.capabilityId,
      skillId: input.trusted.skillId,
      confidence: input.confidence,
      reasons: [...input.reasons].sort(),
      treeSha256: integrity.treeSha256,
      instructionSha256: createHash("sha256").update(instruction, "utf8").digest("hex"),
      instructionBytes: Buffer.byteLength(instruction, "utf8"),
      modules: modules.map((module) => module.receipt),
    },
    instruction,
  };
}

function isPresentationDesignSkill(
  source: ActivatedSkillSource & { name?: string },
  presentationIntent?: boolean,
): boolean {
  return Boolean(presentationIntent) && isDesignSkill(source);
}

function isDesignSkill(source: ActivatedSkillSource & { name?: string }): boolean {
  return (
    source.skillId === DESIGN_SKILL_ID ||
    source.skillId.endsWith(`:${DESIGN_SKILL_NAME}`) ||
    source.name === DESIGN_SKILL_NAME
  );
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}
