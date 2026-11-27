import type { SkillHubBlockerCode, SkillScanFinding } from "@goatcitadel/contracts";
import {
  collectSkillFindings,
  isSkillAssetPath,
  SKILL_SCAN_MAX_FILE_BYTES,
  SKILL_SCAN_MAX_FILES,
  type SkillScanFile,
} from "./skill-content-scan.js";
import { findingBlockers } from "./skill-hub-scan-blockers.js";
import { PROMPTWARE_MAX_FINDINGS, scanPromptwareContent } from "./assembled-prompt-injection-guard.js";

export interface VerifiedArtifactEntry {
  /** Path inside the artifact, with `/` separators. */
  path: string;
  bytes: number;
  sha256: string;
}

export type ArtifactContentScanOutcome =
  | { kind: "clean" }
  | { kind: "incomplete"; sourcePaths: string[] }
  | { kind: "blocked"; blockerCodes: SkillHubBlockerCode[]; findings: SkillScanFinding[] };

const encoder = new TextEncoder();

export async function scanVerifiedArtifactPromptware(
  entries: readonly VerifiedArtifactEntry[],
  readText: (entry: VerifiedArtifactEntry) => Promise<string>,
): Promise<{
  findings: Array<{ ruleId: string; sourcePath: string; evidenceHash: string }>;
  unscannedPaths: string[];
}> {
  const findings: Array<{ ruleId: string; sourcePath: string; evidenceHash: string }> = [];
  const unscannedPaths: string[] = [];
  for (const entry of entries) {
    if (!/\.(?:md|txt)$/iu.test(entry.path)) continue;
    try {
      const content = await readText(entry);
      const fileFindings = scanPromptwareContent({ source: "imported_skill", sourcePath: entry.path, content }).map(
        (finding) => ({
          ruleId: finding.ruleId,
          sourcePath: finding.sourcePath ?? entry.path,
          evidenceHash: finding.evidenceHash,
        }),
      );
      findings.push(...fileFindings.slice(0, Math.max(0, PROMPTWARE_MAX_FINDINGS - findings.length)));
    } catch {
      unscannedPaths.push(entry.path);
    }
  }
  return { findings, unscannedPaths };
}

/**
 * The shared content scan over a reviewed artifact's verified files, run again right before install. A review taken
 * before the shared scan existed checked less, and its audit still reads as current, so install never relies on it.
 * `readText` reads one manifest entry, checking its size and hash; a read that fails counts as an unreadable file.
 */
export async function scanVerifiedArtifactContent(
  entries: readonly VerifiedArtifactEntry[],
  readText: (entry: VerifiedArtifactEntry) => Promise<string>,
): Promise<ArtifactContentScanOutcome> {
  const files: SkillScanFile[] = [];
  for (const entry of entries.slice(0, SKILL_SCAN_MAX_FILES)) {
    files.push(await readScanFile(entry, readText));
  }
  const findings = collectSkillFindings(files, { truncated: entries.length > SKILL_SCAN_MAX_FILES });
  const contentFindings = findings.filter((finding) => finding.code !== "scan_incomplete");
  const blockerCodes = [...new Set(findingBlockers(contentFindings))];
  if (blockerCodes.length > 0) {
    return { kind: "blocked", blockerCodes, findings: contentFindings.filter((finding) => finding.dangerous) };
  }
  const incomplete = findings.filter((finding) => finding.code === "scan_incomplete");
  if (incomplete.length > 0) return { kind: "incomplete", sourcePaths: incomplete.map((finding) => finding.path) };
  return { kind: "clean" };
}

/** The blocked settlement's result for an outcome that isn't clean. */
export function contentScanSettlement(
  outcome: Exclude<ArtifactContentScanOutcome, { kind: "clean" }>,
): Record<string, unknown> {
  const detail =
    outcome.kind === "blocked"
      ? { code: "content_scan_blocked", blockerCodes: outcome.blockerCodes, findings: outcome.findings }
      : {
          code: "promptware_scan_incomplete",
          blockerCodes: ["PROMPTWARE_SCAN_INCOMPLETE"],
          sourcePaths: outcome.sourcePaths,
        };
  return { ...detail, boundaryCrossed: false };
}

async function readScanFile(
  entry: VerifiedArtifactEntry,
  readText: (entry: VerifiedArtifactEntry) => Promise<string>,
): Promise<SkillScanFile> {
  if (isSkillAssetPath(entry.path)) return { path: entry.path, bytes: new Uint8Array() };
  if (entry.bytes > SKILL_SCAN_MAX_FILE_BYTES) return { path: entry.path, bytes: new Uint8Array(), size: entry.bytes };
  try {
    return { path: entry.path, bytes: encoder.encode(await readText(entry)) };
  } catch {
    return { path: entry.path, bytes: new Uint8Array(), unreadable: true };
  }
}
