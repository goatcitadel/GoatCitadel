/** Informational observations only. No explanation is an execution grant. */
export type CapabilityExplanationState = "ready" | "approval_needed" | "setup_needed" | "blocked" | "unknown";

export interface CapabilityExplanationItem {
  capabilityId: string;
  kind: "tool" | "skill" | "connector";
  title: string;
  summary: string;
  toolName?: string;
  state: CapabilityExplanationState;
  reason: string;
  nextStep?: string;
  evidence: Array<"catalog" | "policy" | "connectors" | "session" | "code_mode">;
}

export interface CapabilityGuideSection {
  id: string;
  title: string;
  workflow: string;
  limitations: string;
}

export interface CapabilityExplanationResponse {
  version: "capability-explanation.v1";
  informationalOnly: true;
  permissionsGranted: false;
  workspaceId: string;
  sessionId: string;
  observedAt: string;
  coverage: "complete" | "partial" | "no_match" | "unavailable";
  capabilities: CapabilityExplanationItem[];
  guide: { version: "capability-guide.v1"; overview: string; sections: CapabilityGuideSection[] };
  issues: string[];
  caveat: string;
}
