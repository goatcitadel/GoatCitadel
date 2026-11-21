import type { BackgroundLearningDestination, BackgroundLearningReadiness } from "./background-learning.js";
import type { ChangePlanRequest } from "./change-plan.js";
export interface AssistantReadinessAction {
  kind: "review_change_plan" | "open_owner" | "sign_in";
  href: string;
  label: string;
  /** Gateway-authored bounded intent; the existing Change Plan owner still admits it. */
  request?: ChangePlanRequest;
  sessionPreference?: { memoryMode: "auto" };
}
export interface AssistantReadinessItem {
  id: "memory" | "skills" | "follow_up" | "scheduled_work";
  label: string;
  state: BackgroundLearningDestination["state"];
  scope: "session" | "workspace" | "installation";
  reasons: string[];
  nextAction?: AssistantReadinessAction;
}
export interface AssistantReadinessResponse {
  version: 1;
  workspaceId: string;
  sessionId: string;
  configRevision: number;
  sourceHash: string;
  sessionIncarnationId?: string;
  items: AssistantReadinessItem[];
  learning: BackgroundLearningReadiness;
  indexedRecall: BackgroundLearningDestination;
  indexedRecallSetup?: AssistantReadinessAction;
  /** Drafting and approved instruction use have independent operator controls. */
  reviewedSkillUse?: BackgroundLearningDestination;
  reviewedSkillUseSetup?: AssistantReadinessAction;
}
export interface AssistantSetupReviewInput {
  sessionId: string;
  workspaceId: string;
  itemId: AssistantReadinessItem["id"] | "indexed_recall" | "skill_use";
  expectedSourceHash: string;
  operationId: string;
}
