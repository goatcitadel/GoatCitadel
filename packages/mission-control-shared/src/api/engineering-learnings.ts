import type {
  ApprovalRequest,
  EngineeringLearningAction,
  EngineeringLearningRecord,
  EngineeringLearningProposalRequest,
  EngineeringLearningStatus,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchEngineeringLearnings(input: {
  workspaceId: string;
  projectId?: string;
  status?: EngineeringLearningStatus;
  limit?: number;
}): Promise<{ items: EngineeringLearningRecord[] }> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.projectId) query.set("projectId", input.projectId);
  if (input.status) query.set("status", input.status);
  if (input.limit) query.set("limit", String(input.limit));
  return request(`/api/v1/engineering-learnings?${query}`);
}

export async function fetchEngineeringLearning(learningId: string): Promise<EngineeringLearningRecord> {
  return request(`/api/v1/engineering-learnings/${encodeURIComponent(learningId)}`);
}

export async function fetchEngineeringLearningContext(input: {
  workspaceId: string;
  projectId?: string;
  paths?: string[];
  limit?: number;
}): Promise<{
  items: EngineeringLearningRecord[];
  citations: Array<{ learningId: string; sourceRunId: string; evidence: string[] }>;
}> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.projectId) query.set("projectId", input.projectId);
  if (input.paths?.length) query.set("paths", input.paths.join(","));
  if (input.limit) query.set("limit", String(input.limit));
  return request(`/api/v1/engineering-learnings/context?${query}`);
}

export async function requestEngineeringLearningAction(
  learningId: string,
  input: {
    action: EngineeringLearningAction;
    targetLearningIds?: string[];
    updates?: Partial<
      Pick<
        EngineeringLearningRecord,
        "title" | "problem" | "rootCause" | "resolution" | "prevention" | "failedAttempts" | "applicablePaths"
      >
    >;
  },
): Promise<ApprovalRequest> {
  return request(`/api/v1/engineering-learnings/${encodeURIComponent(learningId)}/actions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function submitEngineeringLearningProposal(
  input: EngineeringLearningProposalRequest,
): Promise<EngineeringLearningRecord> {
  return request("/api/v1/engineering-learnings/proposals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchEngineeringLearningOverlaps(
  learningId: string,
): Promise<{ items: EngineeringLearningRecord[] }> {
  return request(`/api/v1/engineering-learnings/${encodeURIComponent(learningId)}/overlaps`);
}

export async function refreshEngineeringLearningFreshness(): Promise<{ staleCount: number }> {
  return request("/api/v1/engineering-learnings/maintenance/refresh", { method: "POST" });
}
