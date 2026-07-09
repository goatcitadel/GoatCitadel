import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const voiceRouteMethods = [
  "getVoiceRuntimeStatus",
  "getVoiceStatus",
  "installVoiceRuntime",
  "appendGoogleMeetTranscriptChunk",
  "createRealtimeVoiceClientSecret",
  "createGoogleMeetConsultHandoff",
  "getGoogleMeetPrerequisiteStatus",
  "listGoogleMeetSessions",
  "listVoiceTalkSessions",
  "removeVoiceRuntimeModel",
  "selectVoiceRuntimeModel",
  "startGoogleMeetSession",
  "startTalkSession",
  "startVoiceWake",
  "stopGoogleMeetSession",
  "stopRealtimeVoiceSession",
  "stopTalkSession",
  "stopVoiceWake",
  "transcribeVoice",
] as const;

export type VoiceRouteMethod = (typeof voiceRouteMethods)[number];
export type VoiceRoutePort = RoutePort<VoiceRouteMethod>;
export type VoiceRouteService = RouteService<VoiceRouteMethod>;

export function createVoiceRouteService(port: VoiceRoutePort): VoiceRouteService {
  return createRouteService(port, voiceRouteMethods);
}
