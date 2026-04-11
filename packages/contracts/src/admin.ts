export interface BackupManifestFileRecord {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface BackupManifestContractMinimumSetRecord {
  databasePaths: string[];
  transcriptPaths: string[];
  auditPaths: string[];
  configPaths: string[];
}

export interface BackupManifestContractCoverageRecord {
  contractVersion: "1.0";
  minimumSet: BackupManifestContractMinimumSetRecord;
}

export interface BackupManifestRecord {
  backupId: string;
  createdAt: string;
  appVersion: string;
  gitRef?: string;
  rootDir: string;
  files: BackupManifestFileRecord[];
  contractCoverage?: BackupManifestContractCoverageRecord;
}

export interface BackupCreateResponse {
  backupId: string;
  outputPath: string;
  bytes: number;
  manifest: BackupManifestRecord;
}

export interface BackupVerifyIssue {
  code: string;
  message: string;
  path?: string;
}

export interface BackupVerifyContractSection {
  expectedPaths: string[];
  verifiedPaths: string[];
  missingPaths: string[];
  verified: boolean;
}

export interface BackupVerifyContractCoverageRecord {
  contractVersion: "1.0";
  legacyManifest: boolean;
  reasons: string[];
  minimumSet: {
    database: BackupVerifyContractSection;
    transcripts: BackupVerifyContractSection;
    audit: BackupVerifyContractSection;
    config: BackupVerifyContractSection;
  };
}

export interface BackupVerifyResponse {
  backupPath: string;
  backupId?: string;
  verified: boolean;
  contractVerified: boolean;
  filesVerified: number;
  issues: BackupVerifyIssue[];
  manifest?: BackupManifestRecord;
  contractCoverage: BackupVerifyContractCoverageRecord;
}

export interface RetentionPolicy {
  realtimeEventsDays: number;
  backupsKeep: number;
  transcriptsDays?: number;
  auditDays?: number;
}

export interface RetentionPruneResult {
  applied: boolean;
  startedAt: string;
  finishedAt: string;
  removedRealtimeEvents: number;
  removedBackupFiles: number;
  removedTranscriptFiles: number;
  removedAuditFiles: number;
  reclaimedBytes: number;
}

export type DatabaseCutoverProfile = "local" | "hosted";
export type DatabaseCutoverMode = "dry_run" | "execute";
export type DatabaseCutoverStatus = "ready" | "completed" | "blocked" | "failed";
export type DatabaseCutoverStepStatus = "pending" | "completed" | "skipped" | "blocked" | "failed";

export interface DatabaseCutoverStepRecord {
  id: string;
  label: string;
  status: DatabaseCutoverStepStatus;
  detail?: string;
}

export interface DatabaseCutoverSummary {
  sourceSessionCount: number;
  sourceTranscriptEventCount: number;
  sourceAuditEventCount: number;
  targetTranscriptEventCount?: number;
  targetAuditEventCount?: number;
}

export interface DatabaseCutoverResponse {
  cutoverId: string;
  profile: DatabaseCutoverProfile;
  mode: DatabaseCutoverMode;
  status: DatabaseCutoverStatus;
  startedAt: string;
  finishedAt: string;
  backup?: BackupCreateResponse;
  runtimeFlipReady: boolean;
  runtimeFlipBlockedReason?: string;
  summary: DatabaseCutoverSummary;
  steps: DatabaseCutoverStepRecord[];
}

export interface DatabaseVerifyIssue {
  code: string;
  message: string;
  path?: string;
}

export interface DatabaseVerifyResponse {
  source: string;
  target?: string;
  verified: boolean;
  sourceSessionCount: number;
  sourceTranscriptEventCount: number;
  sourceAuditEventCount: number;
  targetTranscriptEventCount?: number;
  targetAuditEventCount?: number;
  issues: DatabaseVerifyIssue[];
}

export interface DatabaseHealthSnapshot {
  driver: "sqlite" | "postgres";
  configured: boolean;
  reachable: boolean;
  migrationVersion?: number;
  latencyMs?: number;
  issues: string[];
}
