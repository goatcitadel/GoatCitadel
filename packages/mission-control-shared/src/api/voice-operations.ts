import type {
  GoogleMeetConsultHandoff,
  GoogleMeetPrerequisiteStatusRequest,
  GoogleMeetPrerequisiteStatusResponse,
  GoogleMeetSessionRecord,
  GoogleMeetSessionStartRequest,
  GoogleMeetTranscriptChunk,
  VoiceRuntimeInstallRequest,
  VoiceRuntimeStatus,
  VoiceStatus,
  VoiceTalkSessionRecord,
} from "@goatcitadel/contracts";

import { request } from "./client-core.js";

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
  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 10));
  const query = new URLSearchParams({ limit: String(normalizedLimit) });
  const response = await request<{ items: GoogleMeetSessionRecord[] }>(
    `/api/v1/voice/google-meet/sessions?${query.toString()}`,
  );
  return response.items.slice(0, normalizedLimit);
}

export async function startGoogleMeetSession(input: GoogleMeetSessionStartRequest): Promise<GoogleMeetSessionRecord> {
  return request<GoogleMeetSessionRecord>("/api/v1/voice/google-meet/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function appendGoogleMeetTranscriptChunk(
  sessionId: string,
  input: Pick<GoogleMeetTranscriptChunk, "text" | "speaker" | "final" | "provider">,
): Promise<GoogleMeetSessionRecord> {
  return request<GoogleMeetSessionRecord>(
    `/api/v1/voice/google-meet/sessions/${encodeURIComponent(sessionId)}/transcript`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function createGoogleMeetConsultHandoff(
  sessionId: string,
  input: { target?: GoogleMeetConsultHandoff["target"]; prompt?: string } = {},
): Promise<GoogleMeetSessionRecord> {
  return request<GoogleMeetSessionRecord>(
    `/api/v1/voice/google-meet/sessions/${encodeURIComponent(sessionId)}/consult`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function stopGoogleMeetSession(sessionId: string): Promise<GoogleMeetSessionRecord> {
  return request<GoogleMeetSessionRecord>(`/api/v1/voice/google-meet/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
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
