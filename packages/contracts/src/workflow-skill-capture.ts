export interface WorkflowSkillCaptureRequest {
  sourceTurnId: string;
  guidance?: string;
  targetCandidateId?: string;
  expectedRevision?: number;
}

export interface WorkflowSkillCaptureDraft {
  prompt: string;
  sourceTurnId: string;
  sourceSha256: string;
}

export interface WorkflowSkillCaptureStageRequest {
  draftTurnId: string;
  /** Hash of the exact assistant markdown preview the operator reviewed. */
  reviewedContentSha256: string;
}

export interface WorkflowSkillCaptureResult {
  candidateId: string;
  versionId: string;
  proposalId: string;
  revision: number;
  /** This operation never activates a skill; current callability belongs to the capability owner. */
  activationPerformed: false;
  evaluation: "structure_and_safety_passed";
  behavioralValidation: "not_run";
}

export const WORKFLOW_SKILL_CAPTURE_MARKER = "WORKFLOW_SKILL_CAPTURE_V1 ";
