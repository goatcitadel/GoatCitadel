import type {
  GoogleMeetPrerequisiteStatusRequest,
  GoogleMeetPrerequisiteStatusResponse,
  GoogleMeetSessionRecord,
  VoiceRuntimeInstallRequest,
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

export async function fetchVoiceTalkSessions(limit = 10): Promise<VoiceTalkSessionRecord[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  const response = await request<{ items: VoiceTalkSessionRecord[] }>(
    `/api/v1/voice/talk/sessions?${query.toString()}`,
  );
  return response.items;
}

export async function fetchGoogleMeetPrerequisiteStatus(
  input: GoogleMeetPrerequisiteStatusRequest = {},
): Promise<GoogleMeetPrerequisiteStatusResponse> {
  return request<GoogleMeetPrerequisiteStatusResponse>("/api/v1/voice/google-meet/prerequisites", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchGoogleMeetSessions(limit = 10): Promise<GoogleMeetSessionRecord[]> {
  const response = await request<{ items: GoogleMeetSessionRecord[] }>("/api/v1/voice/google-meet/sessions");
  return response.items.slice(0, Math.max(1, Math.min(100, Math.trunc(limit) || 10)));
}

export async function installVoiceRuntime(input: VoiceRuntimeInstallRequest = {}): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>("/api/v1/voice/runtime/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function selectVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>(`/api/v1/voice/runtime/models/${encodeURIComponent(modelId)}/select`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function removeVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>(`/api/v1/voice/runtime/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
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

export async function startVoiceWake(): Promise<VoiceStatus["wake"]> {
  return request<VoiceStatus["wake"]>("/api/v1/voice/wake/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopVoiceWake(): Promise<VoiceStatus["wake"]> {
  return request<VoiceStatus["wake"]>("/api/v1/voice/wake/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
