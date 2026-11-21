export type FollowThroughOwner = { kind: "schedule" | "commitment" | "heartbeat" | "proactive"; ownerId: string };
export type FollowThroughAction =
  | "accept"
  | "dismiss"
  | "pause"
  | "resume"
  | "run_now"
  | "cancel_run"
  | "set_heartbeat_interval";
export interface FollowThroughItem {
  owner: FollowThroughOwner;
  revision: number;
  purpose: string;
  state:
    | "awaiting_review"
    | "upcoming"
    | "quiet"
    | "waiting_on_you"
    | "running"
    | "completed"
    | "failed"
    | "unknown"
    | "paused"
    | "cancelled";
  timezone: string;
  nextCheckAt?: string;
  lastOutcome?: string;
  delivery: string;
  permissionSummary: string;
  budgetSummary: string;
  activeRunId?: string;
  executionGeneration?: number;
  heartbeatIntervalSeconds?: number;
  actions: { action: FollowThroughAction; label: string }[];
  ownerHref: string;
  reason?: string;
}
export interface FollowThroughResponse {
  version: 1;
  sessionId: string;
  workspaceId: string;
  items: FollowThroughItem[];
  warnings: string[];
  truncated: boolean;
  actionReceipt?: {
    operationId: string;
    runId: string;
    state: import("./cron-runs.js").CronRunStatus;
    disposition: "recorded" | "existing_occurrence";
  };
}
export interface FollowThroughActionInput {
  sessionId: string;
  workspaceId: string;
  owner: FollowThroughOwner;
  action: FollowThroughAction;
  expectedRevision: number;
  operationId?: string;
  expectedRunId?: string;
  expectedExecutionGeneration?: number;
  heartbeatIntervalSeconds?: number;
}

export type FollowThroughSetupTrigger =
  | { kind: "recurring"; schedule: string }
  | { kind: "once"; at: string; timezone: string }
  | { kind: "event"; hookId: string; notBefore: string; timezone: string };
export interface FollowThroughSetupDraft {
  purpose: string;
  permissionProfileId: string;
  trigger: FollowThroughSetupTrigger;
  delivery: { kind: "conversation" };
}
export interface FollowThroughSetupInput extends FollowThroughSetupDraft {
  sessionId: string;
  workspaceId: string;
  expectedSetupHash: string;
  operationId: string;
}
export interface FollowThroughSetupResponse {
  version: 1;
  workspaceId: string;
  sessionId: string;
  sourceHash: string;
  configRevision: number;
  profiles: { profileId: string; revision: string; label: string; description: string; approvalMode: string }[];
  eventSources: { hookId: string; label: string; sourceHash?: string }[];
  limits: { scope: "installation"; dailyUsdHardCap: number; sessionTokenHardCap: number };
  blockedReasons: string[];
  quietHours?: { start: number; end: number; timezone: string };
}
