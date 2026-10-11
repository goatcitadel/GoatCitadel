import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonString,
  PolicyViolationError,
  type ChatTurnCapabilityActivatedSkill,
  type ChatTurnCapabilityActivatedSkillContextDocument,
  type ChatTurnCapabilityProfileRecord,
  type ChatTurnCapabilityTrustedSkill,
  type SkillActivationDecision,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import {
  resolveSkillModules,
  type SkillArtifactIntent,
  type SkillContextDocType,
  type SkillModuleRef,
} from "@goatcitadel/skills";
import { captureSkillContentIntegritySync } from "./skill-content-integrity.js";
import { GUIDANCE_DOC_FILE_MAP } from "./guidance-doc-files.js";
import {
  PROMPTWARE_SCANNER_VERSION,
  scanPromptwareContent,
  type PromptwareRuleId,
} from "./assembled-prompt-injection-guard.js";

const PROMPTWARE_CLEAN_CACHE_MAX = 256;
const promptwareCleanCache = new Map<string, true>();
/** Per-document ceiling for injected workspace context; the receipt hashes the full stored document. */
export const SKILL_CONTEXT_DOC_MAX_BYTES = 6144;

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

/** Promptware in a workspace PRODUCT.md / DESIGN.md: the operator's own document, not a skill, is at fault. */
export class GuidanceSecurityBlockedError extends PolicyViolationError {
  public readonly failureClass = "guidance_security_blocked" as const;
  public readonly recoveryAction = "review_workspace_guidance" as const;

  public constructor(input: { docType: SkillContextDocType; ruleIds: PromptwareRuleId[]; evidenceHashes: string[] }) {
    const fileName = GUIDANCE_DOC_FILE_MAP[input.docType];
    super({
      message: `Workspace ${fileName} blocked the turn before provider execution; review it in Settings › Workspaces.`,
      details: {
        failureClass: "guidance_security_blocked",
        recoveryAction: "review_workspace_guidance",
        docType: input.docType,
        fileName,
        scope: "workspace",
        scannerVersion: PROMPTWARE_SCANNER_VERSION,
        ruleIds: [...new Set(input.ruleIds)].sort(),
        evidenceHashes: [...new Set(input.evidenceHashes)].sort(),
      },
    });
  }
}

/** Reads one workspace context doc; a missing file is `{ exists: false, content: "" }`. */
export type SkillContextDocReader = (docType: SkillContextDocType) => { exists: boolean; content: string };

interface ActivatedSkillSource {
  skillId: string;
  dir: string;
}

interface BuildReceiptInput {
  content: string;
  decision: SkillActivationDecision;
  trustedSkills: ChatTurnCapabilityTrustedSkill[];
  lifecycleRows: SkillLifecycleRecord[];
  /** Gateway-detected deck/document intent; selects the artifacts route for design skills. */
  artifactIntent?: SkillArtifactIntent;
  /** Workspace PRODUCT.md / DESIGN.md reader; routes that declare context docs read through it. */
  contextDocs?: SkillContextDocReader;
}

interface ContextDocsInput {
  docTypes: SkillContextDocType[];
  read: SkillContextDocReader;
  /** At render time: the frozen receipt's documents; any change fails closed. */
  frozen?: ChatTurnCapabilityActivatedSkillContextDocument[];
}

export function governedSkillInstructionInjectionEnabled(): boolean {
  return !isTruthyEnv(process.env.GOATCITADEL_DISABLE_GOVERNED_SKILL_INJECTION);
}

export function buildGovernedActivatedSkillReceipts(input: BuildReceiptInput): ChatTurnCapabilityActivatedSkill[] {
  if (!governedSkillInstructionInjectionEnabled()) return [];
  const lifecycleBySkill = new Map(input.lifecycleRows.map((row) => [row.skillId, row]));
  const trustedBySkill = new Map(input.trustedSkills.map((skill) => [skill.skillId, skill]));
  return input.decision.selected
    .filter((skill) => !skill.requiresConfirmation)
    .map((skill) => {
      const trusted = trustedBySkill.get(skill.skillId);
      if (!trusted) {
        throw new Error(`Activated skill ${skill.skillId} is not present in the frozen trusted-skill catalog.`);
      }
      const lifecycle = lifecycleBySkill.get(skill.skillId);
      const resolution = resolveSkillModules({
        skillId: skill.skillId,
        skillName: skill.name,
        text: input.content,
        artifactIntent: input.artifactIntent,
      });
      const read = input.contextDocs;
      return buildReceipt({
        source: skill,
        trusted,
        lifecycle,
        reasons: input.decision.reasons[skill.name] ?? [],
        confidence: skill.confidence,
        modulePaths: resolution.modules,
        budgetBytes: resolution.budgetBytes,
        contextDocs: resolution.contextDocs && read ? { docTypes: resolution.contextDocs, read } : undefined,
      }).receipt;
    })
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

export function renderGovernedActivatedSkillInstructions(input: {
  profile: ChatTurnCapabilityProfileRecord;
  loadedSkills: ActivatedSkillSource[];
  lifecycleRows: SkillLifecycleRecord[];
  contextDocs?: SkillContextDocReader;
}): string | undefined {
  const receipts = input.profile.selection.activatedSkills ?? [];
  if (receipts.length === 0 || !governedSkillInstructionInjectionEnabled()) return undefined;
  const loadedBySkill = new Map(input.loadedSkills.map((skill) => [skill.skillId, skill]));
  const lifecycleBySkill = new Map(input.lifecycleRows.map((row) => [row.skillId, row]));
  const trustedBySkill = new Map(input.profile.selection.trustedSkills.map((skill) => [skill.skillId, skill]));
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
      contextDocs: resolveFrozenContextDocs(expected, input.contextDocs),
    });
    if (canonicalJsonString(rebuilt.receipt) !== canonicalJsonString(expected)) {
      throw new Error(`Activated skill ${expected.skillId} instruction receipt drifted after profile freeze.`);
    }
    assertRuntimeSkillPromptwareSafe([expected.skillId], rebuilt.instruction, rebuilt.receipt.instructionSha256);
    rendered.push(rebuilt.instruction);
  }
  const instructionBundle = [
    "Server-owned governed runtime skill instructions follow.",
    "These instructions were selected from the callable trusted catalog and hash-verified against the frozen lifecycle record.",
    ...rendered,
  ].join("\n\n");
  assertRuntimeSkillPromptwareSafe(
    receipts.map((receipt) => receipt.skillId),
    instructionBundle,
    createHash("sha256").update(instructionBundle, "utf8").digest("hex"),
  );
  return instructionBundle;
}

/** A frozen receipt without context docs never reads the workspace; one with them cannot render without a reader. */
function resolveFrozenContextDocs(
  expected: ChatTurnCapabilityActivatedSkill,
  read: SkillContextDocReader | undefined,
): ContextDocsInput | undefined {
  const frozen = expected.contextDocuments ?? [];
  if (frozen.length === 0) return undefined;
  if (!read) {
    const files = frozen.map((doc) => GUIDANCE_DOC_FILE_MAP[doc.docType]).join(", ");
    throw new Error(
      `Workspace ${files} context for activated skill ${expected.skillId} cannot be re-verified without a workspace reader.`,
    );
  }
  return { docTypes: frozen.map((doc) => doc.docType), read, frozen };
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

function assertWorkspaceGuidancePromptwareSafe(docType: SkillContextDocType, content: string): void {
  const findings = scanPromptwareContent({
    source: "memory_context",
    sourcePath: `workspace-guidance:${docType}`,
    content,
  });
  if (findings.length > 0) {
    throw new GuidanceSecurityBlockedError({
      docType,
      ruleIds: findings.map((finding) => finding.ruleId),
      evidenceHashes: findings.map((finding) => finding.evidenceHash),
    });
  }
}

function buildReceipt(input: {
  source: ActivatedSkillSource & { name?: string };
  trusted: ChatTurnCapabilityTrustedSkill;
  lifecycle: SkillLifecycleRecord | undefined;
  reasons: string[];
  confidence: number;
  /** Modules to load: the route table's resolution at freeze time, or the frozen receipt's modules at render time. */
  modulePaths: SkillModuleRef[];
  /** Total byte ceiling across modules; enforced at freeze time only (a frozen receipt is already bounded). */
  budgetBytes?: number;
  /** Workspace context docs to read and append; the frozen list at render time. */
  contextDocs?: ContextDocsInput;
}): { receipt: ChatTurnCapabilityActivatedSkill; instruction: string } {
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
  const manifestByPath = new Map(currentIntegrity.files.map((file) => [normalizeRelativePath(file.path), file]));
  const modules = input.modulePaths.map((module) => {
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
    const bytes = fs.readFileSync(fullPath);
    if (module.maxBytes !== undefined && bytes.byteLength > module.maxBytes) {
      throw new Error(
        `Activated skill ${input.source.skillId} ${module.name} module exceeds the ${module.maxBytes}-byte limit.`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== manifestFile.sha256 || bytes.byteLength !== manifestFile.bytes) {
      throw new Error(`Activated skill ${input.source.skillId} module ${relativePath} drifted after lifecycle freeze.`);
    }
    return {
      receipt: { name: module.name, relativePath, sha256, bytes: bytes.byteLength },
      content: bytes.toString("utf8").trim(),
    };
  });
  const totalBytes = modules.reduce((sum, module) => sum + module.receipt.bytes, 0);
  if (input.budgetBytes !== undefined && totalBytes > input.budgetBytes) {
    throw new Error(
      `Activated skill ${input.source.skillId} resolved modules total ${totalBytes} bytes and exceed the ${input.budgetBytes}-byte budget.`,
    );
  }
  const contextDocuments = input.contextDocs ? readContextDocuments(input.contextDocs) : [];
  const instruction = [
    ...modules.map(
      (module) => `## Runtime skill module: ${input.trusted.skillId}/${module.receipt.name}\n\n${module.content}`,
    ),
    ...contextDocuments.map((doc) => doc.section),
  ].join("\n\n");
  return {
    receipt: {
      capabilityId: input.trusted.capabilityId,
      skillId: input.trusted.skillId,
      confidence: input.confidence,
      reasons: [...input.reasons].sort(),
      treeSha256: integrity.treeSha256,
      instructionSha256: createHash("sha256").update(instruction, "utf8").digest("hex"),
      instructionBytes: Buffer.byteLength(instruction, "utf8"),
      modules: modules.map((module) => module.receipt),
      ...(contextDocuments.length > 0 ? { contextDocuments: contextDocuments.map((doc) => doc.receipt) } : {}),
    },
    instruction,
  };
}

/**
 * Reads the declared workspace docs. Hash and size describe the full stored document; the injected
 * text is cut at the ceiling on a UTF-8 character boundary. A frozen document that changed, shrank
 * to blank, or vanished fails closed with the file named, before the generic receipt comparison.
 */
function readContextDocuments(
  input: ContextDocsInput,
): Array<{ receipt: ChatTurnCapabilityActivatedSkillContextDocument; section: string }> {
  return input.docTypes.flatMap((docType) => {
    const fileName = GUIDANCE_DOC_FILE_MAP[docType];
    const frozen = input.frozen?.find((doc) => doc.docType === docType);
    const doc = input.read(docType);
    const changedError = () =>
      new Error(`Workspace ${fileName} changed after this turn's profile froze; send the message again.`);
    if (!doc.exists || doc.content.trim().length === 0) {
      if (frozen) throw changedError();
      return [];
    }
    const sha256 = createHash("sha256").update(doc.content, "utf8").digest("hex");
    const bytes = Buffer.byteLength(doc.content, "utf8");
    if (frozen && (frozen.sha256 !== sha256 || frozen.bytes !== bytes)) throw changedError();
    assertWorkspaceGuidancePromptwareSafe(docType, doc.content);
    const cut = truncateUtf8(doc.content, SKILL_CONTEXT_DOC_MAX_BYTES);
    const marker = cut.truncated ? `\n\n[truncated to ${SKILL_CONTEXT_DOC_MAX_BYTES} bytes]` : "";
    return [
      {
        receipt: { docType, scope: "workspace" as const, sha256, bytes, truncated: cut.truncated },
        section: `## Project design context: ${fileName} (workspace)\n\n${cut.text.trim()}${marker}`,
      },
    ];
  });
}

function truncateUtf8(content: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: content, truncated: false };
  let cut = maxBytes;
  // Back off to the start of the character that straddles the cut: continuation bytes are 10xxxxxx.
  while (cut > 0 && (buffer[cut]! & 0xc0) === 0x80) cut -= 1;
  return { text: buffer.subarray(0, cut).toString("utf8"), truncated: true };
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}
