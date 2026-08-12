export const CHAT_WORKSPACE_SNAPSHOT_VERSION = "chat.workspace-snapshot.v1" as const;

/**
 * One-shot operator intent. The request id binds repeated route-preflight and
 * send resolution to one server-owned capture; it carries no path authority.
 */
export interface ChatWorkspaceSnapshotRequest {
  capture: true;
  requestId: string;
}

export type ChatWorkspaceSnapshotUnavailableReason =
  | "workspace_unavailable"
  | "project_unbound"
  | "path_verification_failed"
  | "path_identity_changed"
  | "git_unavailable"
  | "git_not_repository"
  | "git_summary_failed";

export interface ChatWorkspaceSnapshotProjectIdentity {
  projectId: string;
  projectRevision: number;
}

export interface ChatWorkspaceSnapshotPathBinding {
  verificationId: string;
  fingerprintSha256: string;
  gitIdentitySha256: string;
}

/** Bounded, content-free Git posture. File names and diff bytes are never retained. */
export interface ChatWorkspaceSnapshotGitSummary {
  headSha: string;
  branch?: string;
  trackedChangeCount: number;
  untrackedChangeCount: number;
  dirty: boolean;
  ahead?: number;
  behind?: number;
}

/**
 * Immutable, point-in-time context evidence frozen into exactly one Chat turn
 * capability profile. It describes identity and Git posture, never file or
 * transcript content, and never grants filesystem authority.
 */
export interface ChatWorkspaceSnapshotRecord {
  schemaVersion: typeof CHAT_WORKSPACE_SNAPSHOT_VERSION;
  snapshotId: string;
  requestId: string;
  workspaceId: string;
  project?: ChatWorkspaceSnapshotProjectIdentity;
  status: "captured" | "unavailable";
  reasonCode?: ChatWorkspaceSnapshotUnavailableReason;
  pathBinding?: ChatWorkspaceSnapshotPathBinding;
  git?: ChatWorkspaceSnapshotGitSummary;
  capturedAt: string;
  snapshotHash: string;
}
