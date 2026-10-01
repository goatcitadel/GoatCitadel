import {
  canonicalJsonString,
  type GoogleMeetSessionRecord,
  type GoogleMeetSessionStartRequest,
  type GoogleMeetPrerequisiteStatusResponse,
  type OpenAIRealtimeClientSecretResponse,
  type VoiceStatus,
} from "@goatcitadel/contracts";

export const MEET_OWNER_LIMIT = 100;
export const MEET_OWNER_BOUNDARY =
  "These controls prepare Gateway session records and optional OpenAI credentials. They do not join Google Meet or establish live audio. The owner has no atomic revision precondition; current records are checked before each action.";
export type MeetForm = { meetingUrl: string; displayName: string; accountRef: string };
export type MeetReview = { current: () => boolean; title: string; description: string } & (
  | { kind: "prepare"; form: MeetForm }
  | { kind: "consult" | "stop"; session: GoogleMeetSessionRecord }
);

export function meetStartInput(form: MeetForm, audioReady: boolean): GoogleMeetSessionStartRequest {
  const url = new URL(form.meetingUrl.trim());
  if (url.protocol !== "https:" || url.hostname !== "meet.google.com" || url.username || url.password)
    throw new Error("Enter a Google Meet HTTPS URL without embedded credentials.");
  return {
    meetingUrl: form.meetingUrl.trim(),
    displayName: form.displayName.trim() || undefined,
    accountRef: form.accountRef.trim() || undefined,
    provider: "openai-realtime",
    userStartConfirmed: true,
    browserTransportReady: true,
    audioTransportReady: audioReady,
  };
}
export function meetSessionBound(record: GoogleMeetSessionRecord | undefined): record is GoogleMeetSessionRecord {
  return Boolean(
    record?.sessionId &&
    record.meetingUrl &&
    record.createdAt &&
    record.updatedAt &&
    ["blocked", "ready", "connecting", "running", "consulting", "stopping", "stopped", "failed"].includes(
      record.state,
    ) &&
    Array.isArray(record.prerequisites) &&
    Array.isArray(record.transcript),
  );
}
export function requireMeetRecord(records: GoogleMeetSessionRecord[], id: string): GoogleMeetSessionRecord {
  if (!Array.isArray(records)) throw new Error("The Gateway meeting records are unavailable.");
  const matches = records.filter((item) => item.sessionId === id);
  if (matches.length !== 1 || !meetSessionBound(matches[0]))
    throw new Error("The exact meeting record could not be read back.");
  return matches[0];
}
export function assertMeetSame(actual: GoogleMeetSessionRecord, expected: GoogleMeetSessionRecord) {
  if (canonicalJsonString(actual) !== canonicalJsonString(expected))
    throw new Error("The meeting record changed. Refresh and review the current record.");
}
export function assertMeetPrerequisites(status: GoogleMeetPrerequisiteStatusResponse) {
  if (
    status?.provider !== "openai-realtime" ||
    !status.checkedAt ||
    !Array.isArray(status.prerequisites) ||
    typeof status.authProfile?.available !== "boolean"
  )
    throw new Error("The Gateway prerequisite response is unavailable.");
  const expected = ["oauth_profile", "provider_key", "browser_transport", "audio_transport", "user_start"];
  if (
    !status.ready ||
    status.state !== "ready" ||
    expected.some((id) => status.prerequisites.filter((item) => item.id === id && item.ready).length !== 1)
  )
    throw new Error(
      status.failureReason || "Google Meet prerequisites are blocked. No session or credential was requested.",
    );
}
export function assertMeetCreated(
  saved: GoogleMeetSessionRecord,
  input: GoogleMeetSessionStartRequest,
  prior: GoogleMeetSessionRecord[],
) {
  if (
    !meetSessionBound(saved) ||
    prior.some((item) => item.sessionId === saved.sessionId) ||
    saved.meetingUrl !== input.meetingUrl ||
    saved.displayName !== input.displayName ||
    saved.accountRef !== input.accountRef ||
    saved.provider !== "openai-realtime" ||
    !["running", "blocked"].includes(saved.state) ||
    saved.transcript.length
  )
    throw new Error("The Gateway did not acknowledge the reviewed meeting preparation.");
}
export function assertMeetAction(
  saved: GoogleMeetSessionRecord,
  before: GoogleMeetSessionRecord,
  kind: "consult" | "stop",
) {
  if (
    !meetSessionBound(saved) ||
    saved.sessionId !== before.sessionId ||
    saved.createdAt !== before.createdAt ||
    saved.meetingUrl !== before.meetingUrl ||
    saved.displayName !== before.displayName ||
    saved.accountRef !== before.accountRef ||
    saved.provider !== before.provider ||
    canonicalJsonString(saved.transcript) !== canonicalJsonString(before.transcript) ||
    canonicalJsonString(saved.prerequisites) !== canonicalJsonString(before.prerequisites)
  )
    throw new Error("The meeting action returned a different owner record.");
  if (kind === "consult") {
    const handoff = saved.consultHandoff;
    if (
      saved.state !== "consulting" ||
      !handoff?.handoffId ||
      handoff.handoffId === before.consultHandoff?.handoffId ||
      handoff.sessionId !== before.sessionId ||
      handoff.target !== "chat" ||
      handoff.createdAt !== saved.updatedAt ||
      !handoff.prompt ||
      canonicalJsonString(handoff.transcriptChunkIds) !==
        canonicalJsonString(before.transcript.map((item) => item.chunkId))
    )
      throw new Error("The recorded Chat handoff could not be confirmed.");
  } else if (
    saved.state !== "stopped" ||
    saved.stoppedAt !== saved.updatedAt ||
    saved.cleanup?.sessionId !== before.sessionId ||
    saved.cleanup.cleanedAt !== saved.updatedAt ||
    typeof saved.cleanup.releasedAudio !== "boolean" ||
    typeof saved.cleanup.stoppedTransport !== "boolean"
  )
    throw new Error("The stopped meeting record could not be confirmed.");
}
export function assertMeetToken(
  token: OpenAIRealtimeClientSecretResponse,
  session: GoogleMeetSessionRecord,
  saved: GoogleMeetSessionRecord,
  voice: VoiceStatus,
) {
  const expires = token.clientSecret?.expiresAt ?? token.expiresAt;
  if (
    token.provider !== "openai-realtime" ||
    token.surface !== "google-meet" ||
    token.meetingSessionId !== session.sessionId ||
    token.sessionId !== undefined ||
    !token.voiceSessionId ||
    token.status !== "ready" ||
    !token.model ||
    !token.voice ||
    !token.clientSecret?.value ||
    (expires !== undefined && !(Date.parse(expires) > Date.now())) ||
    !voice.realtime ||
    voice.realtime.activeVoiceSessionId !== token.voiceSessionId ||
    voice.realtime.state !== "ready" ||
    voice.realtime.model !== token.model ||
    voice.realtime.voice !== token.voice ||
    voice.realtime.apiKeyReady !== true ||
    saved.sessionId !== session.sessionId ||
    saved.createdAt !== session.createdAt ||
    saved.meetingUrl !== session.meetingUrl ||
    saved.displayName !== session.displayName ||
    saved.accountRef !== session.accountRef ||
    saved.provider !== session.provider ||
    saved.state !== "running" ||
    saved.startedAt !== (session.startedAt ?? token.createdAt) ||
    saved.updatedAt !== token.createdAt ||
    canonicalJsonString(saved.transcript) !== canonicalJsonString(session.transcript)
  )
    throw new Error(
      "The meeting credential preparation outcome could not be confirmed. Inspect the Gateway before repeating it.",
    );
}
