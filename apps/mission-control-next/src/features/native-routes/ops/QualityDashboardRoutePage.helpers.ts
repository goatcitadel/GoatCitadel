import type {
  LlmEvalProofRunRecord,
  PromptPackRecord,
  OpsQualitySnapshotResponse,
  PromptPackExportRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "@goatcitadel/contracts";
import { formatBytes, formatDateTime, type NativeLoadIssue } from "../shared/native-helpers";

export function formatScore(value: number): string {
  return value <= 1 ? `${Math.round(value * 100)}%` : value.toFixed(2);
}

export function formatPromptPackExport(exportInfo: PromptPackExportRecord | null | undefined): string {
  if (!exportInfo) {
    return "Export metadata is unavailable.";
  }
  const path = exportInfo.latestSnapshotPath ?? exportInfo.latestPath ?? exportInfo.path;
  const size = exportInfo.latestSnapshotSizeBytes ?? exportInfo.sizeBytes;
  const updated = exportInfo.latestSnapshotUpdatedAt ?? exportInfo.updatedAt;
  return [
    path,
    exportInfo.snapshotCount !== undefined ? `${exportInfo.snapshotCount} snapshots` : undefined,
    size !== undefined ? formatBytes(size) : undefined,
    updated ? `updated ${formatDateTime(updated)}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" · ");
}

export function formatSecurityEvalStatus(status: PromptPackSecurityEvalPackRecord["status"]): string {
  if (status === "imported") return "Imported";
  if (status === "available") return "Available";
  return "Unavailable";
}

export function formatSecurityGateStatus(status: PromptPackSecurityQualityGateRecord["status"]): string {
  if (status === "missing_definition") return "Missing definition";
  if (status === "not_imported") return "Not imported";
  if (status === "not_run") return "Not run";
  if (status === "needs_score") return "Needs score";
  if (status === "review") return "Review";
  if (status === "failed") return "Failed";
  return "Passed";
}

export function formatSecurityExecutionState(
  state: OpsQualitySnapshotResponse["securityExecution"]["items"][number]["state"],
) {
  if (state === "definition_missing") return "Definition missing";
  if (state === "definition_only") return "Definition only";
  if (state === "run_required") return "Run required";
  if (state === "scoring_required") return "Scoring required";
  if (state === "review_required") return "Review required";
  if (state === "failing") return "Failing";
  if (state === "passing") return "Passing";
  return "Unknown";
}

export function formatAvailabilityState(
  state: OpsQualitySnapshotResponse["designQuality"]["state"] | undefined,
): string {
  if (state === "available") return "Available";
  if (state === "not_available") return "Not available";
  return "Unknown";
}

export function formatDesignQualityStatus(
  status: OpsQualitySnapshotResponse["designQuality"]["checks"][number]["status"],
): string {
  if (status === "passing") return "Passing";
  if (status === "advisory") return "Advisory";
  if (status === "blocking") return "Blocking";
  return "Unknown";
}

export function formatSecurityModeCounts(
  counts: OpsQualitySnapshotResponse["securityExecution"]["items"][number]["modeCounts"],
): string {
  return `Chat ${counts.chat ?? 0} · Legacy plan ${counts.cowork ?? 0} · Legacy code ${counts.code ?? 0}`;
}

export function formatSecurityToolTierCounts(
  counts: OpsQualitySnapshotResponse["securityExecution"]["items"][number]["toolTierCounts"],
): string {
  return `No-tools ${counts["no-tools"] ?? 0} · Implicit ${counts["implicit-tools"] ?? 0} · Explicit ${
    counts["explicit-tools"] ?? 0
  }`;
}

export function qualitySnapshotIssues(snapshot: OpsQualitySnapshotResponse): NativeLoadIssue[] {
  return [
    snapshot.promptPacks.error ? { label: "Prompt packs", message: snapshot.promptPacks.error } : null,
    snapshot.evalProof.error ? { label: "Eval proof", message: snapshot.evalProof.error } : null,
    snapshot.securityEvalPacks.error
      ? { label: "Security eval packs", message: snapshot.securityEvalPacks.error }
      : null,
    snapshot.securityQualityGates.error
      ? { label: "Security quality gates", message: snapshot.securityQualityGates.error }
      : null,
    snapshot.securityExecution.error
      ? { label: "Security execution depth", message: snapshot.securityExecution.error }
      : null,
    snapshot.designQuality.error ? { label: "Design quality", message: snapshot.designQuality.error } : null,
  ].filter((issue): issue is NativeLoadIssue => Boolean(issue));
}

export function createUnavailableQualitySnapshot() {
  return {
    version: "ops.quality_snapshot.v1",
    generatedAt: new Date(0).toISOString(),
    sourceEndpoint: "/api/v1/ops/quality",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      note: "Ops quality snapshot is unavailable; showing empty fallback state.",
    },
    metricScope: {
      scope: "bounded_read",
      promptPackLimit: 200,
      evalRunLimit: 25,
      note: "Fallback snapshot contains no stored evidence.",
    },
    metrics: {
      promptPackCount: 0,
      promptPackTestCount: 0,
      redTeamPackCount: 0,
      redTeamTestCount: 0,
      evalRunCount: 0,
      paretoModelCount: 0,
      securityGateCount: 0,
      passingSecurityGateCount: 0,
      securityExecutionReadyCount: 0,
      securityExecutionBlockedCount: 0,
      designQualityCheckCount: 0,
      designQualityBlockingCount: 0,
    },
    promptPacks: { state: "not_available", items: [] as PromptPackRecord[] },
    evalProof: { state: "not_available", items: [] as LlmEvalProofRunRecord[] },
    securityEvalPacks: {
      state: "not_available",
      items: [] as PromptPackSecurityEvalPackRecord[],
      warnings: [],
    },
    securityQualityGates: {
      state: "not_available",
      items: [] as PromptPackSecurityQualityGateRecord[],
      warnings: [],
    },
    securityExecution: {
      state: "not_available",
      items: [],
      warnings: [],
    },
    designQuality: {
      state: "not_available",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        source: "repo_files",
        callsProviders: false,
        mutationPerformed: false,
        note: "Fallback design-quality snapshot contains no repo evidence.",
      },
      summary: {
        totalChecks: 0,
        passingCount: 0,
        advisoryCount: 0,
        blockingCount: 0,
        unknownCount: 0,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
        p3Count: 0,
      },
      checks: [],
      warnings: [],
    },
    warnings: [],
    nextChecks: [],
  } satisfies OpsQualitySnapshotResponse;
}
