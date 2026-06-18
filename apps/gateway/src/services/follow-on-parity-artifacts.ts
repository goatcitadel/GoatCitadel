import fsSync from "node:fs";
import path from "node:path";
import type {
  DeploymentProfile,
  FollowOnProofLaneArtifactIndex,
  FollowOnProofLaneArtifactLaneId,
  FollowOnProofLaneArtifactRecord,
} from "@goatcitadel/contracts";

type ArtifactProofState = "draft" | "complete" | "evidence";

interface ArtifactCandidate {
  entryPath: string;
  generatedAtMs: number;
  proofState: ArtifactProofState;
}

const LANE_ARTIFACT_PREFIXES: Partial<Record<FollowOnProofLaneArtifactLaneId, string[]>> = {
  browser: ["browser-control-proof-bundle-"],
  packaging: ["packaging-deployment-proof-bundle-"],
  a2ui: ["a2ui-proof-bundle-"],
  voice: ["voice-proof-bundle-"],
  companion: ["companion-bootstrap-brief-"],
};

const VOICE_EVIDENCE_ARTIFACT_PREFIXES = ["voice-proof-evidence-"];

function summarizeFollowOnParityArtifactContent(content: string, fallbackPath: string): string {
  const summaryMatch = content.match(/^## Summary\s*\r?\n([^\r\n]+)/m);
  if (summaryMatch?.[1]?.trim()) {
    return summaryMatch[1].trim();
  }
  return `Proof artifact recorded at ${fallbackPath.replaceAll("\\", "/")}.`;
}

function inferArtifactDeploymentProfile(entryPath: string): DeploymentProfile | undefined {
  const normalized = entryPath.replaceAll("\\", "/");
  const match = normalized.match(/-(local_dev|trusted_local|remote_hardened)-\d{4}-\d{2}-\d{2}T/);
  const parsed = match?.[1];
  if (parsed === "local_dev" || parsed === "trusted_local" || parsed === "remote_hardened") {
    return parsed;
  }
  return undefined;
}

function parseArtifactGeneratedAtMs(entryPath: string): number | undefined {
  const baseName = path.basename(entryPath);
  const match = baseName.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) {
    return undefined;
  }
  const isoTimestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const parsed = Date.parse(isoTimestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deriveArtifactProofState(entryPath: string, content: string): ArtifactProofState {
  const baseName = path.basename(entryPath).toLowerCase();
  if (baseName.startsWith("voice-proof-evidence-")) {
    return "evidence";
  }
  if (/^# .+draft\s*$/im.test(content)) {
    return "draft";
  }
  return "complete";
}

function artifactProofPriority(proofState: ArtifactProofState): number {
  switch (proofState) {
    case "complete":
      return 3;
    case "draft":
      return 2;
    case "evidence":
      return 1;
    default:
      return 0;
  }
}

function isBetterArtifactCandidate(candidate: ArtifactCandidate, current: ArtifactCandidate | undefined): boolean {
  if (!current) {
    return true;
  }
  const candidatePriority = artifactProofPriority(candidate.proofState);
  const currentPriority = artifactProofPriority(current.proofState);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority;
  }
  return candidate.generatedAtMs > current.generatedAtMs;
}

function resolveRepresentativeArtifactPath(
  laneDir: string,
  laneId: FollowOnProofLaneArtifactLaneId,
  entryPath: string,
): string {
  if (laneId !== "extensions") {
    return entryPath;
  }
  const relativePath = path.relative(laneDir, entryPath).replaceAll("\\", "/");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts[0] !== "starter-pack" || parts.length < 3) {
    return entryPath;
  }
  const rootReadmePath = path.join(laneDir, parts[0], parts[1]!, parts[2]!, "README.md");
  if (fsSync.existsSync(rootReadmePath)) {
    return rootReadmePath;
  }
  return entryPath;
}

function matchesArtifactPrefixes(
  laneId: FollowOnProofLaneArtifactLaneId,
  entryPath: string,
  artifactPrefixes?: string[],
): boolean {
  const baseName = path.basename(entryPath).toLowerCase();
  const prefixes = artifactPrefixes ?? LANE_ARTIFACT_PREFIXES[laneId];
  if (!prefixes || prefixes.length === 0) {
    return true;
  }
  return prefixes.some((prefix) => baseName.startsWith(prefix.toLowerCase()));
}

function buildArtifactRecord(
  rootDir: string,
  workspaceDir: string,
  laneId: FollowOnProofLaneArtifactLaneId,
  entryPath: string,
  generatedAtMs: number,
): FollowOnProofLaneArtifactRecord {
  const relativePath = path.relative(path.resolve(rootDir, workspaceDir), entryPath).replaceAll("\\", "/");
  const stat = fsSync.statSync(entryPath);
  const content = fsSync.readFileSync(entryPath, "utf8");

  return {
    laneId,
    generatedAt: new Date(Number.isFinite(generatedAtMs) ? generatedAtMs : stat.mtimeMs).toISOString(),
    summary: summarizeFollowOnParityArtifactContent(content, relativePath),
    relativePath,
    fullPath: `./${path.posix.join(workspaceDir.replaceAll("\\", "/"), relativePath)}`,
    bytes: Buffer.byteLength(content, "utf8"),
    proofState: deriveArtifactProofState(entryPath, content),
  };
}

function scanFollowOnParityArtifacts(
  rootDir: string,
  workspaceDir: string,
  laneId: FollowOnProofLaneArtifactLaneId,
  artifactPrefixes?: string[],
): {
  overall?: ArtifactCandidate;
  byProfile: Partial<Record<DeploymentProfile, ArtifactCandidate>>;
} {
  const laneDir = path.resolve(rootDir, workspaceDir, "artifacts", "follow-on-parity", laneId);
  if (!fsSync.existsSync(laneDir)) {
    return { byProfile: {} };
  }

  const stack = [laneDir];
  let overall: ArtifactCandidate | undefined;
  const byProfile: Partial<Record<DeploymentProfile, ArtifactCandidate>> = {};

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const representativePath = resolveRepresentativeArtifactPath(laneDir, laneId, entryPath);
      if (!matchesArtifactPrefixes(laneId, representativePath, artifactPrefixes)) {
        continue;
      }
      const stat = fsSync.statSync(representativePath);
      const content = fsSync.readFileSync(representativePath, "utf8");
      const candidate: ArtifactCandidate = {
        entryPath: representativePath,
        generatedAtMs: parseArtifactGeneratedAtMs(representativePath) ?? stat.mtimeMs,
        proofState: deriveArtifactProofState(representativePath, content),
      };
      if (isBetterArtifactCandidate(candidate, overall)) {
        overall = candidate;
      }
      const deploymentProfile = inferArtifactDeploymentProfile(representativePath);
      if (deploymentProfile && isBetterArtifactCandidate(candidate, byProfile[deploymentProfile])) {
        byProfile[deploymentProfile] = candidate;
      }
    }
  }

  return { overall, byProfile };
}

export function readLatestFollowOnParityArtifactFromWorkspace(
  rootDir: string,
  workspaceDir: string,
  laneId: FollowOnProofLaneArtifactLaneId,
  deploymentProfile?: DeploymentProfile,
): FollowOnProofLaneArtifactRecord | undefined {
  const scanned = scanFollowOnParityArtifacts(rootDir, workspaceDir, laneId);
  const selected = deploymentProfile ? (scanned.byProfile[deploymentProfile] ?? scanned.overall) : scanned.overall;
  const selectedPath = selected?.entryPath;
  const selectedGeneratedAt = selected?.generatedAtMs ?? -1;
  if (!selectedPath) {
    return undefined;
  }

  return buildArtifactRecord(rootDir, workspaceDir, laneId, selectedPath, selectedGeneratedAt);
}

export function readLatestFollowOnParityArtifactsByProfile(
  rootDir: string,
  workspaceDir: string,
  laneId: FollowOnProofLaneArtifactLaneId,
): Partial<Record<DeploymentProfile, FollowOnProofLaneArtifactRecord>> {
  const scanned = scanFollowOnParityArtifacts(rootDir, workspaceDir, laneId);
  return Object.fromEntries(
    Object.entries(scanned.byProfile).map(([profile, candidate]) => [
      profile,
      buildArtifactRecord(rootDir, workspaceDir, laneId, candidate.entryPath, candidate.generatedAtMs),
    ]),
  ) as Partial<Record<DeploymentProfile, FollowOnProofLaneArtifactRecord>>;
}

export function readLatestVoiceEvidenceArtifactsByProfile(
  rootDir: string,
  workspaceDir: string,
): Partial<Record<DeploymentProfile, FollowOnProofLaneArtifactRecord>> {
  const scanned = scanFollowOnParityArtifacts(rootDir, workspaceDir, "voice", VOICE_EVIDENCE_ARTIFACT_PREFIXES);
  return Object.fromEntries(
    Object.entries(scanned.byProfile).map(([profile, candidate]) => [
      profile,
      buildArtifactRecord(rootDir, workspaceDir, "voice", candidate.entryPath, candidate.generatedAtMs),
    ]),
  ) as Partial<Record<DeploymentProfile, FollowOnProofLaneArtifactRecord>>;
}

export function mergeLatestFollowOnParityArtifacts(
  stored: FollowOnProofLaneArtifactIndex,
  rootDir: string,
  workspaceDir: string,
  deploymentProfile?: DeploymentProfile,
): FollowOnProofLaneArtifactIndex {
  const merged: FollowOnProofLaneArtifactIndex = { ...stored };
  for (const laneId of ["browser", "packaging", "a2ui", "voice", "companion", "extensions"] as const) {
    const scanned = readLatestFollowOnParityArtifactFromWorkspace(rootDir, workspaceDir, laneId, deploymentProfile);
    if (!scanned) {
      continue;
    }
    const storedGeneratedAt = stored[laneId] ? Date.parse(stored[laneId]!.generatedAt) : -1;
    const scannedGeneratedAt = Date.parse(scanned.generatedAt);
    if (
      !stored[laneId] ||
      scannedGeneratedAt > storedGeneratedAt ||
      stored[laneId]?.relativePath !== scanned.relativePath
    ) {
      merged[laneId] = scanned;
    }
  }
  return merged;
}
