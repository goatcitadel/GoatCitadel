import type { AuthMode, DeploymentProfile, IntegrationMaturity } from "./integrations.js";
import type { A2UIContract } from "./a2ui.js";
import type { CompanionAuthRequirement, CompanionContract, CompanionServerPrerequisite } from "./companion.js";
import type { VoiceRuntimeReadiness, VoiceRuntimeState } from "./voice.js";

export type FollowOnParityEpicId =
  | "GC-P0-06"
  | "GC-P0-07"
  | "GC-P1-08"
  | "GC-P1-09"
  | "GC-P1-10"
  | "GC-P2-11"
  | "GC-P2-12"
  | "GC-P2-13";

export const FOLLOW_ON_PARITY_EPIC_IDS: FollowOnParityEpicId[] = [
  "GC-P0-06",
  "GC-P0-07",
  "GC-P1-08",
  "GC-P1-09",
  "GC-P1-10",
  "GC-P2-11",
  "GC-P2-12",
  "GC-P2-13",
];

export const FOLLOW_ON_PARITY_RECOMMENDED_ORDER: FollowOnParityEpicId[] = [
  "GC-P2-12",
  "GC-P0-06",
  "GC-P2-11",
  "GC-P1-09",
  "GC-P1-08",
  "GC-P0-07",
  "GC-P1-10",
  "GC-P2-13",
];

export type FollowOnParityEpicState = "have_foundation" | "partial" | "missing";

export interface FollowOnParityTargetRecord {
  catalogId: string;
  label: string;
  maturity: IntegrationMaturity;
  capabilities: string[];
}

export interface FollowOnParityEpicRecord {
  epicId: FollowOnParityEpicId;
  label: string;
  state: FollowOnParityEpicState;
  summary: string;
  nextSlice: string;
}

export interface FollowOnParityReadinessRecord<Key extends string = string> {
  key: Key;
  label: string;
  state: FollowOnParityEpicState;
  note: string;
}

export type FollowOnProofLaneStepStatus = "ready" | "blocked";

export interface FollowOnProofLaneStepRecord {
  stepId: string;
  title: string;
  status: FollowOnProofLaneStepStatus;
  instructions: string;
  evidenceHint: string;
}

export type FollowOnProofLaneDraftId = "browser" | "packaging" | "a2ui" | "voice";

export interface FollowOnProofLaneSpec {
  laneId: FollowOnProofLaneDraftId;
  checklistPath: string;
  templatePath: string;
}

export const FOLLOW_ON_PROOF_LANE_SPECS: Record<FollowOnProofLaneDraftId, FollowOnProofLaneSpec> = {
  browser: {
    laneId: "browser",
    checklistPath: "docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md",
    templatePath: "templates/verification/browser-control-proof-bundle.md",
  },
  packaging: {
    laneId: "packaging",
    checklistPath: "docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md",
    templatePath: "templates/verification/packaging-deployment-proof-bundle.md",
  },
  a2ui: {
    laneId: "a2ui",
    checklistPath: "docs/testing/A2UI_VALIDATION_CHECKLIST.md",
    templatePath: "templates/verification/a2ui-proof-bundle.md",
  },
  voice: {
    laneId: "voice",
    checklistPath: "docs/testing/VOICE_VALIDATION_CHECKLIST.md",
    templatePath: "templates/verification/voice-proof-bundle.md",
  },
};

export interface BrowserProofLaneDraft {
  generatedAt: string;
  deploymentProfile: DeploymentProfile;
  authMode: AuthMode;
  summary: string;
  checklistPath: string;
  templatePath: string;
  blockingIssues: string[];
  steps: FollowOnProofLaneStepRecord[];
  markdown: string;
}

export interface PackagingProofLaneDraft {
  generatedAt: string;
  deploymentProfile: DeploymentProfile;
  authMode: AuthMode;
  summary: string;
  checklistPath: string;
  templatePath: string;
  blockingIssues: string[];
  steps: FollowOnProofLaneStepRecord[];
  markdown: string;
}

export interface A2UIProofLaneDraft {
  generatedAt: string;
  deploymentProfile: DeploymentProfile;
  authMode: AuthMode;
  summary: string;
  checklistPath: string;
  templatePath: string;
  blockingIssues: string[];
  steps: FollowOnProofLaneStepRecord[];
  markdown: string;
}

export interface VoiceProofLaneDraft {
  generatedAt: string;
  deploymentProfile: DeploymentProfile;
  authMode: AuthMode;
  summary: string;
  checklistPath: string;
  templatePath: string;
  blockingIssues: string[];
  recoveryActions: string[];
  steps: FollowOnProofLaneStepRecord[];
  markdown: string;
}

export interface ExtensionSdkBriefDraft {
  generatedAt: string;
  summary: string;
  markdown: string;
}

export interface ExtensionStarterPackDraft {
  generatedAt: string;
  summary: string;
  starterRoot: string;
  files: string[];
  markdown: string;
}

export interface ExtensionStarterPackFileRecord {
  relativePath: string;
  fullPath: string;
  bytes: number;
}

export interface ExtensionStarterPackArtifactRecord {
  generatedAt: string;
  summary: string;
  starterRoot: string;
  fileCount: number;
  totalBytes: number;
  files: ExtensionStarterPackFileRecord[];
}

export type FollowOnProofLaneArtifactLaneId = "browser" | "packaging" | "a2ui" | "voice" | "companion" | "extensions";

export interface FollowOnProofLaneArtifactRecord {
  laneId: FollowOnProofLaneArtifactLaneId;
  generatedAt: string;
  summary: string;
  relativePath: string;
  fullPath: string;
  bytes: number;
  proofState?: "draft" | "complete" | "evidence";
}

export interface FollowOnArtifactStatus {
  hasArtifact: boolean;
  freshness: "missing" | "stale" | "current";
  ageDays?: number;
}

export interface FollowOnProfileArtifactStatus extends FollowOnArtifactStatus {
  latestArtifactDeploymentProfile?: DeploymentProfile;
  matchedCurrentProfile: boolean;
}

export interface FollowOnProfileCoverageRecord {
  currentProfiles: DeploymentProfile[];
  staleProfiles: DeploymentProfile[];
  missingProfiles: DeploymentProfile[];
}

export type FollowOnProofLaneArtifactIndex = Partial<
  Record<FollowOnProofLaneArtifactLaneId, FollowOnProofLaneArtifactRecord>
>;

export interface FollowOnParityReport {
  generatedAt: string;
  deploymentProfile: DeploymentProfile;
  authMode: AuthMode;
  packaging: {
    allowLoopbackBypass: boolean;
    networkAllowlistCount: number;
    postureSummary: string;
    proofStatus: FollowOnProfileArtifactStatus;
    proofCoverage: FollowOnProfileCoverageRecord;
    blockingIssues: string[];
    recommendedActions: string[];
    latestArtifact?: FollowOnProofLaneArtifactRecord;
  };
  browser: {
    totalToolCount: number;
    readToolCount: number;
    controlToolCount: number;
    guardrailSummary: string;
    stateToolRuntime: {
      restrictedToProfile: DeploymentProfile;
      registeredTools: string[];
      allowedTools: string[];
      blockedTools: string[];
    };
    artifactStatus: FollowOnProfileArtifactStatus;
    blockingIssues: string[];
    recommendedActions: string[];
    automationCatalog?: FollowOnParityTargetRecord;
    latestArtifact?: FollowOnProofLaneArtifactRecord;
  };
  voice: {
    runtimeReadiness: VoiceRuntimeReadiness;
    selectedModelId?: string;
    talkState: VoiceRuntimeState;
    wakeState: VoiceRuntimeState;
    wakeEnabled: boolean;
    lastError?: string;
    artifactStatus: FollowOnProfileArtifactStatus;
    proofCoverage: FollowOnProfileCoverageRecord;
    blockingIssues: string[];
    recoveryActions: string[];
    recommendedActions: string[];
    automationCatalog?: FollowOnParityTargetRecord;
    latestArtifact?: FollowOnProofLaneArtifactRecord;
  };
  addons: {
    catalogCount: number;
    installedCount: number;
    runningCount: number;
  };
  plugins: {
    totalCount: number;
    enabledCount: number;
    sdkSummary: string;
    referenceLifecycle: {
      referencePluginId: string;
      present: boolean;
      enabled: boolean;
      source?: string;
      matchesReferenceSource: boolean;
      capabilities: string[];
    };
    artifactStatus: FollowOnArtifactStatus;
    blockingIssues: string[];
    recommendedActions: string[];
    latestArtifact?: FollowOnProofLaneArtifactRecord;
  };
  canvas: {
    automationCatalog?: FollowOnParityTargetRecord;
    platformTargets: FollowOnParityTargetRecord[];
    contract?: A2UIContract;
    paritySummary: string;
    artifactStatus: FollowOnProfileArtifactStatus;
    blockingIssues: string[];
    recommendedActions: string[];
    latestArtifact?: FollowOnProofLaneArtifactRecord;
  };
  companion: {
    platformTargets: FollowOnParityTargetRecord[];
    contract?: CompanionContract;
    authReadiness: FollowOnParityReadinessRecord<CompanionAuthRequirement>[];
    prerequisiteReadiness: FollowOnParityReadinessRecord<CompanionServerPrerequisite>[];
    paritySummary: string;
    artifactStatus: FollowOnArtifactStatus;
    blockingIssues: string[];
    recommendedActions: string[];
    latestArtifact?: FollowOnProofLaneArtifactRecord;
  };
  epics: FollowOnParityEpicRecord[];
}
