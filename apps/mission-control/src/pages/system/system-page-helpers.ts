/**
 * Pure helpers extracted from SystemPage.tsx (Step 10 page slimming).
 */

import type { FollowOnParityReport, OpenclawParityProgramReport } from "../../api/client";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

export function formatArtifactStatus(status: FollowOnParityReport["companion"]["artifactStatus"]): string {
  if (!status.hasArtifact) {
    return "missing";
  }
  return `${status.freshness}${typeof status.ageDays === "number" ? ` · ${status.ageDays} day(s) old` : ""}`;
}

export function formatProofArtifactStatus(status: FollowOnParityReport["browser"]["artifactStatus"]): string {
  if (!status.hasArtifact) {
    return "missing · no artifact recorded yet";
  }
  const ageNote = typeof status.ageDays === "number" ? ` · ${status.ageDays} day(s) old` : "";
  const profileNote = status.latestArtifactDeploymentProfile
    ? ` · latest profile ${status.latestArtifactDeploymentProfile} · ${status.matchedCurrentProfile ? "matches current profile" : "does not match current profile"}`
    : "";
  return `${status.freshness}${profileNote}${ageNote}`;
}

export function mapParityTone(
  state: FollowOnParityReport["epics"][number]["state"],
): "success" | "warning" | "critical" {
  if (state === "have_foundation") {
    return "success";
  }
  if (state === "partial") {
    return "warning";
  }
  return "critical";
}

export function mapProgramParityTone(
  status: OpenclawParityProgramReport["epics"][number]["status"],
): "success" | "warning" | "critical" {
  if (status === "complete") {
    return "success";
  }
  if (status === "in_progress") {
    return "warning";
  }
  return "critical";
}

export function formatProgramBlockerKind(
  kind: OpenclawParityProgramReport["epics"][number]["blockers"][number]["kind"],
): string {
  switch (kind) {
    case "repo_runtime":
      return "repo runtime";
    case "manual_operator":
      return "manual/operator";
    case "external_repo":
      return "external repo";
    case "publication":
      return "publication";
    default:
      return kind;
  }
}
