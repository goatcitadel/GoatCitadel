import type {
  ChatSecureConfigurationSubmitRequest,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatThreadResponse,
  ChatUserInputPromptAnswerRequest,
  ChatUserInputPromptAnswerResponse,
  OutsideRootWriteGrantChoice,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function answerChatUserInputPrompt(
  sessionId: string,
  turnId: string,
  promptId: string,
  input: ChatUserInputPromptAnswerRequest,
): Promise<ChatUserInputPromptAnswerResponse> {
  return request<ChatUserInputPromptAnswerResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/user-input/${encodeURIComponent(promptId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function submitChatSecureConfiguration(
  sessionId: string,
  turnId: string,
  promptId: string,
  input: ChatSecureConfigurationSubmitRequest,
): Promise<ChatUserInputPromptAnswerResponse> {
  return request<ChatUserInputPromptAnswerResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/user-input/${encodeURIComponent(promptId)}/secure-configuration`,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(input),
    },
  );
}

export async function approveChatTool(
  sessionId: string,
  approvalId: string,
  options?: { allowScope?: "once" | "session" | "workspace"; writeGrant?: ChatApprovalWriteGrantChoice },
): Promise<ApproveChatToolResult> {
  return request<ApproveChatToolResult>("/api/v1/chat/tools/approve", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      approvalId,
      ...(options?.allowScope ? { allowScope: options.allowScope } : {}),
      ...(options?.writeGrant ? { writeGrant: options.writeGrant } : {}),
    }),
  });
}

export async function denyChatTool(
  sessionId: string,
  approvalId: string,
): Promise<{ ok: boolean; approvalId: string }> {
  return request<{ ok: boolean; approvalId: string }>("/api/v1/chat/tools/deny", {
    method: "POST",
    body: JSON.stringify({ sessionId, approvalId }),
  });
}

export async function selectChatBranchTurn(sessionId: string, turnId: string): Promise<ChatThreadResponse> {
  return request<ChatThreadResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/select`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function createChatSpecialistCandidate(
  sessionId: string,
  input: {
    turnId?: string;
    suggestion: ChatSpecialistCandidateSuggestionRecord;
  },
): Promise<ChatSpecialistCandidateRecord> {
  return request<ChatSpecialistCandidateRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function updateChatSpecialistCandidate(
  sessionId: string,
  candidateId: string,
  input: ChatSpecialistCandidatePatchInput,
): Promise<ChatSpecialistCandidateRecord> {
  return request<ChatSpecialistCandidateRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates/${encodeURIComponent(candidateId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

/** The folder an outside-root write approval opens; owned by contracts so client and Gateway agree. */
export type ChatApprovalWriteGrantChoice = OutsideRootWriteGrantChoice;

export interface ApproveChatToolResult {
  ok: boolean;
  approvalId: string;
  allowScope?: "once" | "session" | "workspace";
  resumed?: boolean;
  resumedTurnId?: string;
  resumedRunId?: string;
  /** The grant minted by a scoped approval (an opened folder for outside-root writes). */
  grant?: ToolGrantRecord;
  /** Why a scoped grant could not be minted; the exact approved action still ran once. */
  grantError?: string;
}
