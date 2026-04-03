import type {
  A2UIProofLaneDraft,
  BrowserProofLaneDraft,
  ExtensionSdkBriefDraft,
  ExtensionStarterPackDraft,
  FollowOnParityReport,
  FollowOnProofLaneArtifactRecord,
  OpenclawParityProgramReport,
  PackagingProofLaneDraft,
  SystemVitalsResponse,
  VoiceProofLaneDraft,
} from "../api/client";

export function buildUiArtifactStatus(
  generatedAt: string,
  artifact?: FollowOnProofLaneArtifactRecord,
): FollowOnParityReport["companion"]["artifactStatus"] {
  if (!artifact) {
    return {
      hasArtifact: false,
      freshness: "missing",
    };
  }
  const artifactGeneratedAtMs = Date.parse(artifact.generatedAt);
  const reportGeneratedAtMs = Date.parse(generatedAt);
  const ageDays = Number.isFinite(artifactGeneratedAtMs) && Number.isFinite(reportGeneratedAtMs)
    ? Math.max(0, Math.floor((reportGeneratedAtMs - artifactGeneratedAtMs) / (24 * 60 * 60 * 1000)))
    : undefined;
  return {
    hasArtifact: true,
    freshness: typeof ageDays === "number" && ageDays > 7 ? "stale" : "current",
    ageDays,
  };
}

export function normalizeOpenclawParityProgramReport(
  report: Partial<OpenclawParityProgramReport> | null | undefined,
): OpenclawParityProgramReport {
  return {
    generatedAt: report?.generatedAt ?? new Date().toISOString(),
    completedEpicIds: report?.completedEpicIds ?? [],
    openEpicIds: report?.openEpicIds ?? [],
    completionOrder: report?.completionOrder ?? [],
    nextEpicId: report?.nextEpicId,
    nextSlice: report?.nextSlice ?? "No next slice reported yet.",
    unsafeClaims: report?.unsafeClaims ?? [],
    blockerCounts: {
      repo_runtime: report?.blockerCounts?.repo_runtime ?? 0,
      manual_operator: report?.blockerCounts?.manual_operator ?? 0,
      external_repo: report?.blockerCounts?.external_repo ?? 0,
      publication: report?.blockerCounts?.publication ?? 0,
    },
    epics: (report?.epics ?? []).map((epic) => ({
      epicId: epic.epicId,
      label: epic.label ?? epic.epicId,
      status: epic.status ?? "pending",
      summary: epic.summary ?? "Parity progress for this epic has not been reported yet.",
      nextSlice: epic.nextSlice ?? "No next slice reported yet.",
      blockers: epic.blockers ?? [],
    })),
  };
}

export function normalizeFollowOnParityReport(
  report: Partial<FollowOnParityReport> | null | undefined,
): FollowOnParityReport {
  return {
    generatedAt: report?.generatedAt ?? new Date().toISOString(),
    deploymentProfile: report?.deploymentProfile ?? "local_dev",
    authMode: report?.authMode ?? "none",
    packaging: {
      allowLoopbackBypass: report?.packaging?.allowLoopbackBypass ?? false,
      networkAllowlistCount: report?.packaging?.networkAllowlistCount ?? 0,
      postureSummary: report?.packaging?.postureSummary ?? "Packaging posture not reported yet.",
      proofStatus: normalizeProfileArtifactStatus(report?.packaging?.proofStatus),
      proofCoverage: normalizeProfileCoverage(report?.packaging?.proofCoverage),
      blockingIssues: report?.packaging?.blockingIssues ?? [],
      recommendedActions: report?.packaging?.recommendedActions ?? [],
      latestArtifact: report?.packaging?.latestArtifact,
    },
    browser: {
      totalToolCount: report?.browser?.totalToolCount ?? 0,
      readToolCount: report?.browser?.readToolCount ?? 0,
      controlToolCount: report?.browser?.controlToolCount ?? 0,
      guardrailSummary: report?.browser?.guardrailSummary ?? "Browser guardrail summary not reported yet.",
      stateToolRuntime: {
        restrictedToProfile: report?.browser?.stateToolRuntime?.restrictedToProfile ?? report?.deploymentProfile ?? "local_dev",
        registeredTools: report?.browser?.stateToolRuntime?.registeredTools ?? [],
        allowedTools: report?.browser?.stateToolRuntime?.allowedTools ?? [],
        blockedTools: report?.browser?.stateToolRuntime?.blockedTools ?? [],
      },
      artifactStatus: normalizeProfileArtifactStatus(report?.browser?.artifactStatus),
      blockingIssues: report?.browser?.blockingIssues ?? [],
      recommendedActions: report?.browser?.recommendedActions ?? [],
      automationCatalog: report?.browser?.automationCatalog,
      latestArtifact: report?.browser?.latestArtifact,
    },
    voice: {
      runtimeReadiness: report?.voice?.runtimeReadiness ?? "missing",
      selectedModelId: report?.voice?.selectedModelId,
      talkState: report?.voice?.talkState ?? "stopped",
      wakeState: report?.voice?.wakeState ?? "stopped",
      wakeEnabled: report?.voice?.wakeEnabled ?? false,
      lastError: report?.voice?.lastError,
      artifactStatus: normalizeProfileArtifactStatus(report?.voice?.artifactStatus),
      proofCoverage: normalizeProfileCoverage(report?.voice?.proofCoverage),
      blockingIssues: report?.voice?.blockingIssues ?? [],
      recoveryActions: report?.voice?.recoveryActions ?? [],
      recommendedActions: report?.voice?.recommendedActions ?? [],
      automationCatalog: report?.voice?.automationCatalog,
      latestArtifact: report?.voice?.latestArtifact,
    },
    addons: {
      catalogCount: report?.addons?.catalogCount ?? 0,
      installedCount: report?.addons?.installedCount ?? 0,
      runningCount: report?.addons?.runningCount ?? 0,
    },
    plugins: {
      totalCount: report?.plugins?.totalCount ?? 0,
      enabledCount: report?.plugins?.enabledCount ?? 0,
      sdkSummary: report?.plugins?.sdkSummary ?? "Extension breadth not reported yet.",
      referenceLifecycle: {
        referencePluginId: report?.plugins?.referenceLifecycle?.referencePluginId ?? "reference-integration-plugin",
        present: report?.plugins?.referenceLifecycle?.present ?? false,
        enabled: report?.plugins?.referenceLifecycle?.enabled ?? false,
        source: report?.plugins?.referenceLifecycle?.source,
        matchesReferenceSource: report?.plugins?.referenceLifecycle?.matchesReferenceSource ?? false,
        capabilities: report?.plugins?.referenceLifecycle?.capabilities ?? [],
      },
      artifactStatus: normalizeArtifactStatus(report?.plugins?.artifactStatus),
      blockingIssues: report?.plugins?.blockingIssues ?? [],
      recommendedActions: report?.plugins?.recommendedActions ?? [],
      latestArtifact: report?.plugins?.latestArtifact,
    },
    canvas: {
      automationCatalog: report?.canvas?.automationCatalog,
      platformTargets: report?.canvas?.platformTargets ?? [],
      contract: normalizeA2UIContract(report?.canvas?.contract),
      paritySummary: report?.canvas?.paritySummary ?? "Canvas parity summary not reported yet.",
      artifactStatus: normalizeProfileArtifactStatus(report?.canvas?.artifactStatus),
      blockingIssues: report?.canvas?.blockingIssues ?? [],
      recommendedActions: report?.canvas?.recommendedActions ?? [],
      latestArtifact: report?.canvas?.latestArtifact,
    },
    companion: {
      platformTargets: report?.companion?.platformTargets ?? [],
      contract: normalizeCompanionContract(report?.companion?.contract),
      authReadiness: report?.companion?.authReadiness ?? [],
      prerequisiteReadiness: report?.companion?.prerequisiteReadiness ?? [],
      paritySummary: report?.companion?.paritySummary ?? "Companion parity summary not reported yet.",
      artifactStatus: normalizeArtifactStatus(report?.companion?.artifactStatus),
      blockingIssues: report?.companion?.blockingIssues ?? [],
      recommendedActions: report?.companion?.recommendedActions ?? [],
      latestArtifact: report?.companion?.latestArtifact,
    },
    epics: report?.epics ?? [],
  };
}

export function normalizeSystemVitals(
  vitals: Partial<SystemVitalsResponse> | null | undefined,
): SystemVitalsResponse {
  return {
    hostname: vitals?.hostname ?? "unknown-host",
    platform: vitals?.platform ?? "unknown-platform",
    release: vitals?.release ?? "unknown-release",
    uptimeSeconds: vitals?.uptimeSeconds ?? 0,
    loadAverage: vitals?.loadAverage ?? [0, 0, 0],
    cpuCount: vitals?.cpuCount ?? 0,
    memoryTotalBytes: vitals?.memoryTotalBytes ?? 0,
    memoryFreeBytes: vitals?.memoryFreeBytes ?? 0,
    memoryUsedBytes: vitals?.memoryUsedBytes ?? 0,
    processRssBytes: vitals?.processRssBytes ?? 0,
    processHeapUsedBytes: vitals?.processHeapUsedBytes ?? 0,
  };
}

export function normalizeBrowserProofLaneDraft(
  draft: Partial<BrowserProofLaneDraft> | null | undefined,
): BrowserProofLaneDraft {
  return {
    generatedAt: draft?.generatedAt ?? new Date().toISOString(),
    deploymentProfile: draft?.deploymentProfile ?? "local_dev",
    authMode: draft?.authMode ?? "none",
    summary: draft?.summary ?? "Browser proof lane has not been generated yet.",
    checklistPath: draft?.checklistPath ?? "docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md",
    templatePath: draft?.templatePath ?? "templates/verification/browser-control-proof-bundle.md",
    blockingIssues: draft?.blockingIssues ?? [],
    steps: draft?.steps ?? [],
    markdown: draft?.markdown ?? "",
  };
}

export function normalizePackagingProofLaneDraft(
  draft: Partial<PackagingProofLaneDraft> | null | undefined,
): PackagingProofLaneDraft {
  return {
    generatedAt: draft?.generatedAt ?? new Date().toISOString(),
    deploymentProfile: draft?.deploymentProfile ?? "local_dev",
    authMode: draft?.authMode ?? "none",
    summary: draft?.summary ?? "Packaging proof lane has not been generated yet.",
    checklistPath: draft?.checklistPath ?? "docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md",
    templatePath: draft?.templatePath ?? "templates/verification/packaging-deployment-proof-bundle.md",
    blockingIssues: draft?.blockingIssues ?? [],
    steps: draft?.steps ?? [],
    markdown: draft?.markdown ?? "",
  };
}

export function normalizeA2UIProofLaneDraft(
  draft: Partial<A2UIProofLaneDraft> | null | undefined,
): A2UIProofLaneDraft {
  return {
    generatedAt: draft?.generatedAt ?? new Date().toISOString(),
    deploymentProfile: draft?.deploymentProfile ?? "local_dev",
    authMode: draft?.authMode ?? "none",
    summary: draft?.summary ?? "A2UI proof lane has not been generated yet.",
    checklistPath: draft?.checklistPath ?? "docs/testing/A2UI_VALIDATION_CHECKLIST.md",
    templatePath: draft?.templatePath ?? "templates/verification/a2ui-proof-bundle.md",
    blockingIssues: draft?.blockingIssues ?? [],
    steps: draft?.steps ?? [],
    markdown: draft?.markdown ?? "",
  };
}

export function normalizeVoiceProofLaneDraft(
  draft: Partial<VoiceProofLaneDraft> | null | undefined,
): VoiceProofLaneDraft {
  return {
    generatedAt: draft?.generatedAt ?? new Date().toISOString(),
    deploymentProfile: draft?.deploymentProfile ?? "local_dev",
    authMode: draft?.authMode ?? "none",
    summary: draft?.summary ?? "Voice proof lane has not been generated yet.",
    checklistPath: draft?.checklistPath ?? "docs/testing/VOICE_VALIDATION_CHECKLIST.md",
    templatePath: draft?.templatePath ?? "templates/verification/voice-proof-bundle.md",
    blockingIssues: draft?.blockingIssues ?? [],
    recoveryActions: draft?.recoveryActions ?? [],
    steps: draft?.steps ?? [],
    markdown: draft?.markdown ?? "",
  };
}

export function normalizeExtensionSdkBriefDraft(
  draft: Partial<ExtensionSdkBriefDraft> | null | undefined,
): ExtensionSdkBriefDraft {
  return {
    generatedAt: draft?.generatedAt ?? new Date().toISOString(),
    summary: draft?.summary ?? "Extension SDK brief has not been generated yet.",
    markdown: draft?.markdown ?? "",
  };
}

export function normalizeExtensionStarterPackDraft(
  draft: Partial<ExtensionStarterPackDraft> | null | undefined,
): ExtensionStarterPackDraft {
  return {
    generatedAt: draft?.generatedAt ?? new Date().toISOString(),
    summary: draft?.summary ?? "Extension starter pack has not been generated yet.",
    starterRoot: draft?.starterRoot ?? "",
    files: draft?.files ?? [],
    markdown: draft?.markdown ?? "",
  };
}

export function buildUiProfileArtifactStatus(
  generatedAt: string,
  deploymentProfile: FollowOnParityReport["deploymentProfile"],
  artifact?: FollowOnProofLaneArtifactRecord,
): FollowOnParityReport["browser"]["artifactStatus"] {
  if (!artifact) {
    return {
      hasArtifact: false,
      freshness: "missing",
      matchedCurrentProfile: false,
    };
  }
  const baseStatus = buildUiArtifactStatus(generatedAt, artifact);
  const latestArtifactDeploymentProfile = parseArtifactDeploymentProfile(artifact.relativePath);
  return {
    ...baseStatus,
    latestArtifactDeploymentProfile,
    matchedCurrentProfile: latestArtifactDeploymentProfile === deploymentProfile,
  };
}

function normalizeArtifactStatus(
  status: Partial<FollowOnParityReport["companion"]["artifactStatus"]> | undefined,
): FollowOnParityReport["companion"]["artifactStatus"] {
  return {
    hasArtifact: status?.hasArtifact ?? false,
    freshness: status?.freshness ?? "missing",
    ageDays: status?.ageDays,
  };
}

function normalizeProfileArtifactStatus(
  status: Partial<FollowOnParityReport["browser"]["artifactStatus"]> | undefined,
): FollowOnParityReport["browser"]["artifactStatus"] {
  return {
    ...normalizeArtifactStatus(status),
    latestArtifactDeploymentProfile: status?.latestArtifactDeploymentProfile,
    matchedCurrentProfile: status?.matchedCurrentProfile ?? false,
  };
}

function normalizeProfileCoverage(
  coverage: Partial<FollowOnParityReport["packaging"]["proofCoverage"]> | undefined,
): FollowOnParityReport["packaging"]["proofCoverage"] {
  return {
    currentProfiles: coverage?.currentProfiles ?? [],
    staleProfiles: coverage?.staleProfiles ?? [],
    missingProfiles: coverage?.missingProfiles ?? [],
  };
}

function normalizeA2UIContract(
  contract: Partial<FollowOnParityReport["canvas"]["contract"]> | undefined,
): FollowOnParityReport["canvas"]["contract"] | undefined {
  if (!contract) {
    return undefined;
  }
  return {
    contractId: contract.contractId ?? "a2ui.v1",
    label: contract.label ?? "A2UI contract",
    scopes: contract.scopes ?? [],
    transports: contract.transports ?? [],
    operatorSurface: contract.operatorSurface ?? "mission_control",
    uiCapabilities: contract.uiCapabilities ?? [],
    platformCapabilities: contract.platformCapabilities ?? [],
    notes: contract.notes ?? [],
  };
}

function normalizeCompanionContract(
  contract: Partial<FollowOnParityReport["companion"]["contract"]> | undefined,
): FollowOnParityReport["companion"]["contract"] | undefined {
  if (!contract) {
    return undefined;
  }
  return {
    contractId: contract.contractId ?? "companion.android.v1",
    label: contract.label ?? "Companion contract",
    pairedSurfaceContractId: contract.pairedSurfaceContractId ?? "a2ui.v1",
    primaryTarget: contract.primaryTarget ?? "android",
    bootstrapStatus: contract.bootstrapStatus ?? "docs_first",
    repoStrategy: contract.repoStrategy ?? "separate_repo",
    bootstrapRepo: contract.bootstrapRepo ?? "",
    targetCatalogIds: contract.targetCatalogIds ?? [],
    deviceCapabilities: contract.deviceCapabilities ?? [],
    transportLanes: contract.transportLanes ?? [],
    authRequirements: contract.authRequirements ?? [],
    serverPrerequisites: contract.serverPrerequisites ?? [],
    bootstrapFeatures: contract.bootstrapFeatures ?? [],
    notes: contract.notes ?? [],
  };
}

function parseArtifactDeploymentProfile(
  relativePath: string,
): FollowOnParityReport["deploymentProfile"] | undefined {
  const match = relativePath.match(/-(local_dev|trusted_local|remote_hardened)-\d{4}-\d{2}-\d{2}T/);
  const value = match?.[1];
  if (value === "local_dev" || value === "trusted_local" || value === "remote_hardened") {
    return value;
  }
  return undefined;
}
