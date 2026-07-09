import fsSync from "node:fs";
import path from "node:path";
import type {
  PromptPackRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "@goatcitadel/contracts";
import { parsePromptPackTests } from "./parser.js";

const PROMPT_PACK_EVAL_ASSETS_DIR = "eval-assets";
export const SECURITY_RED_TEAM_PACK_FILE = "goatcitadel_prompt_pack_v6_security_red_team.md";

export function buildSecurityRedTeamEvalPack(
  rootDir: string,
  importedPacks: PromptPackRecord[],
  warnings: string[],
): PromptPackSecurityEvalPackRecord {
  const imported = importedPacks.find(isSecurityRedTeamPack);
  const filePath = resolveSecurityRedTeamPackPath(rootDir);
  if (!filePath) {
    warnings.push(`${SECURITY_RED_TEAM_PACK_FILE} was not found in this checkout.`);
    return {
      packKey: "security-red-team-v6",
      title: "Defensive Security Evaluation",
      sourceLabel: SECURITY_RED_TEAM_PACK_FILE,
      status: imported ? "imported" : "unavailable",
      importedPackId: imported?.packId,
      importedPackName: imported?.name,
      testCount: imported?.testCount ?? 0,
      modeCounts: {},
      toolTierCounts: {},
      capabilityTargets: [],
      likelyFailureClasses: [],
      safetyPosture: buildSecurityEvalSafetyPosture(),
      blockers: ["Bundled security red-team prompt-pack markdown is unavailable in this checkout."],
    };
  }

  const tests = parsePromptPackTests(fsSync.readFileSync(filePath, "utf8"));
  return {
    packKey: "security-red-team-v6",
    title: "Defensive Security Evaluation",
    sourceLabel: path.basename(filePath),
    status: imported ? "imported" : "available",
    importedPackId: imported?.packId,
    importedPackName: imported?.name,
    testCount: tests.length,
    modeCounts: countPromptPackModes(tests),
    toolTierCounts: countPromptPackToolTiers(tests),
    capabilityTargets: sortedUnique(
      tests.flatMap((test) => test.diagnosticMetadata?.capabilityTargets ?? []).filter(Boolean),
    ),
    likelyFailureClasses: sortedUnique(
      tests.flatMap((test) => test.diagnosticMetadata?.likelyFailureClasses ?? []).filter(Boolean),
    ),
    safetyPosture: buildSecurityEvalSafetyPosture(),
    blockers: imported ? [] : ["Import this prompt pack before it can produce run, score, or benchmark evidence."],
  };
}

export function buildSecurityQualityGateRecord(
  pack: PromptPackSecurityEvalPackRecord,
  generatedAt: string,
  status: PromptPackSecurityQualityGateRecord["status"],
  evidence: PromptPackSecurityQualityGateRecord["evidence"],
  blockers: string[],
): PromptPackSecurityQualityGateRecord {
  return {
    gateId: `prompt-pack:${pack.packKey}:security-quality`,
    packKey: pack.packKey,
    title: `${pack.title} gate`,
    status,
    releaseGate: true,
    readOnly: true,
    ...(pack.importedPackId ? { packId: pack.importedPackId } : {}),
    ...(pack.importedPackId
      ? { reportEndpoint: `/api/v1/prompt-packs/${encodeURIComponent(pack.importedPackId)}/report` }
      : {}),
    generatedAt,
    evidence,
    blockers,
    nextActions: buildSecurityQualityGateNextActions(status),
    posture: {
      callsProviders: false,
      mutationPerformed: false,
      source: "stored_prompt_pack_report",
      note: "This quality gate summarizes stored defensive-security prompt-pack evidence. It does not run providers, mutate packs, or certify security by itself.",
    },
  };
}

export function resolveEvalAssetsPackPath(rootDir: string, fileName: string): string | undefined {
  const candidates = [
    path.resolve(rootDir, PROMPT_PACK_EVAL_ASSETS_DIR, fileName),
    path.resolve(process.cwd(), PROMPT_PACK_EVAL_ASSETS_DIR, fileName),
    path.resolve(process.cwd(), "..", "..", PROMPT_PACK_EVAL_ASSETS_DIR, fileName),
    path.resolve(process.cwd(), "..", "..", "..", PROMPT_PACK_EVAL_ASSETS_DIR, fileName),
    path.resolve(rootDir, fileName),
    path.resolve(process.cwd(), fileName),
    path.resolve(process.cwd(), "..", "..", fileName),
    path.resolve(process.cwd(), "..", "..", "..", fileName),
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function buildSecurityQualityGateNextActions(status: PromptPackSecurityQualityGateRecord["status"]): string[] {
  switch (status) {
    case "missing_definition":
      return ["Restore the bundled prompt-pack markdown and rerun docs/runtime verification."];
    case "not_imported":
      return ["Import the defensive security prompt pack from Ops Quality or Library Prompt Packs."];
    case "not_run":
      return ["Run the imported defensive security tests through the prompt-pack workflow."];
    case "needs_score":
      return ["Auto-score or human-review every completed defensive security run."];
    case "review":
      return ["Resolve review verdicts and rerun focused failing tests if needed."];
    case "failed":
      return ["Fix the failing behavior, rerun the security pack, and regenerate stored report evidence."];
    case "passed":
      return ["Keep this stored gate evidence alongside the named release verification lanes."];
  }
}

function buildSecurityEvalSafetyPosture(): PromptPackSecurityEvalPackRecord["safetyPosture"] {
  return {
    definitionOnly: true,
    requiresOperatorRun: true,
    callsProviders: false,
    mutationPerformed: false,
    note: "This catalog endpoint only describes the red-team pack. Running or scoring tests remains an explicit operator action.",
  };
}

function resolveSecurityRedTeamPackPath(rootDir: string): string | undefined {
  return resolveEvalAssetsPackPath(rootDir, SECURITY_RED_TEAM_PACK_FILE);
}

function isSecurityRedTeamPack(pack: PromptPackRecord): boolean {
  const haystack = `${pack.name} ${pack.sourceLabel ?? ""}`.toLowerCase().replace(/[-_]+/g, " ");
  return haystack.includes("security") && haystack.includes("red team");
}

function countPromptPackModes(tests: Array<{ mode?: string }>): PromptPackSecurityEvalPackRecord["modeCounts"] {
  const counts: PromptPackSecurityEvalPackRecord["modeCounts"] = {};
  for (const test of tests) {
    if (test.mode === "chat" || test.mode === "cowork" || test.mode === "code") {
      counts[test.mode] = (counts[test.mode] ?? 0) + 1;
    }
  }
  return counts;
}

function countPromptPackToolTiers(
  tests: Array<{ toolTier?: string }>,
): PromptPackSecurityEvalPackRecord["toolTierCounts"] {
  const counts: PromptPackSecurityEvalPackRecord["toolTierCounts"] = {};
  for (const test of tests) {
    if (test.toolTier === "no-tools" || test.toolTier === "implicit-tools" || test.toolTier === "explicit-tools") {
      counts[test.toolTier] = (counts[test.toolTier] ?? 0) + 1;
    }
  }
  return counts;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}
