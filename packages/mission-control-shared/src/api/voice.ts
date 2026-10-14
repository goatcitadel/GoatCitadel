import type {
  OpenAIRealtimeClientSecretRequest,
  OpenAIRealtimeClientSecretResponse,
  OpenAIRealtimeVoiceStatus,
  VoiceRuntimeStatus,
  VoiceStatus,
  VoiceTalkSessionRecord,
  VoiceTranscribeResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function transcribeVoice(input: {
  bytesBase64: string;
  mimeType?: string;
  language?: string;
}): Promise<VoiceTranscribeResponse> {
  return request<VoiceTranscribeResponse>("/api/v1/voice/transcribe", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  return request<VoiceStatus>("/api/v1/voice/status");
}

export async function fetchVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>("/api/v1/voice/runtime");
}

export async function createRealtimeVoiceClientSecret(
  input: OpenAIRealtimeClientSecretRequest,
): Promise<OpenAIRealtimeClientSecretResponse> {
  return request<OpenAIRealtimeClientSecretResponse>("/api/v1/voice/realtime/client-secret", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function stopRealtimeVoiceSession(voiceSessionId: string): Promise<OpenAIRealtimeVoiceStatus> {
  return request<OpenAIRealtimeVoiceStatus>(
    `/api/v1/voice/realtime/sessions/${encodeURIComponent(voiceSessionId)}/stop`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function startVoiceTalkSession(input?: {
  mode?: "push_to_talk" | "wake";
  sessionId?: string;
}): Promise<VoiceTalkSessionRecord> {
  return request<VoiceTalkSessionRecord>("/api/v1/voice/talk/sessions", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function stopVoiceTalkSession(talkSessionId: string): Promise<VoiceTalkSessionRecord> {
  return request<VoiceTalkSessionRecord>(`/api/v1/voice/talk/sessions/${encodeURIComponent(talkSessionId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchVoiceTalkSessions,
  fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions,
  startGoogleMeetSession,
  appendGoogleMeetTranscriptChunk,
  createGoogleMeetConsultHandoff,
  stopGoogleMeetSession,
  installVoiceRuntime,
  selectVoiceRuntimeModel,
  removeVoiceRuntimeModel,
  startVoiceWake,
  stopVoiceWake,
} from "./voice-operations.js";
