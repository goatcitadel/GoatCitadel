import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonString,
  type ChatTurnCapabilityActivatedSkill,
  type ChatTurnCapabilityProfileRecord,
  type ChatTurnCapabilityTrustedSkill,
  type SkillActivationDecision,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import { captureSkillContentIntegritySync } from "./skill-content-integrity.js";

const DESIGN_SKILL_ID = "bundled:design-intelligence";
const DESIGN_SKILL_NAME = "design-intelligence";
const PRESENTATION_MODULES = ["enforcement", "layout", "taste", "assets", "audit"] as const;
const PRESENTATION_INTENT = /\b(?:powerpoint|presentation|slide\s*deck|slides?|pptx|presentations\.create)\b/iu;

interface ActivatedSkillSource {
  skillId: string;
  dir: string;
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
    .filter((skill) => !skill.requiresConfirmation)
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
    });
    if (canonicalJsonString(rebuilt.receipt) !== canonicalJsonString(expected)) {
      throw new Error(`Activated skill ${expected.skillId} instruction receipt drifted after profile freeze.`);
    }
    rendered.push(rebuilt.instruction);
  }
  return [
    "Server-owned governed runtime skill instructions follow.",
    "These instructions were selected from the callable trusted catalog and hash-verified against the frozen lifecycle record.",
    ...rendered,
  ].join("\n\n");
}

function buildReceipt(input: {
  source: ActivatedSkillSource & { name?: string };
  trusted: ChatTurnCapabilityTrustedSkill;
  lifecycle: SkillLifecycleRecord | undefined;
  reasons: string[];
  confidence: number;
  presentationIntent?: boolean;
  modulePaths?: Array<{ name: string; relativePath: string }>;
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
  const modulePaths = input.modulePaths ?? [
    { name: "main", relativePath: "SKILL.md" },
    ...(isPresentationDesignSkill(input.source, input.presentationIntent)
      ? PRESENTATION_MODULES.map((name) => ({ name, relativePath: `${name}.md` }))
      : []),
  ];
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
    const bytes = fs.readFileSync(fullPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== manifestFile.sha256 || bytes.byteLength !== manifestFile.bytes) {
      throw new Error(`Activated skill ${input.source.skillId} module ${relativePath} drifted after lifecycle freeze.`);
    }
    return {
      receipt: { name: module.name, relativePath, sha256, bytes: bytes.byteLength },
      content: bytes.toString("utf8").trim(),
    };
  });
  const instruction = modules
    .map((module) => `## Runtime skill module: ${input.trusted.skillId}/${module.receipt.name}\n\n${module.content}`)
    .join("\n\n");
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
    },
    instruction,
  };
}

function isPresentationDesignSkill(
  source: ActivatedSkillSource & { name?: string },
  presentationIntent?: boolean,
): boolean {
  return (
    Boolean(presentationIntent) &&
    (source.skillId === DESIGN_SKILL_ID ||
      source.skillId.endsWith(`:${DESIGN_SKILL_NAME}`) ||
      source.name === DESIGN_SKILL_NAME)
  );
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}
