import type {
  WorkflowSkillCaptureRequest,
  WorkflowSkillCaptureDraft,
  WorkflowSkillCaptureStageRequest,
  WorkflowSkillCaptureResult,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export function prepareWorkflowSkillCapture(
  sessionId: string,
  input: WorkflowSkillCaptureRequest,
): Promise<WorkflowSkillCaptureDraft> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/skill-captures/prepare`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function stageWorkflowSkillCapture(
  sessionId: string,
  input: WorkflowSkillCaptureStageRequest,
): Promise<WorkflowSkillCaptureResult> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/skill-captures/stage`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
