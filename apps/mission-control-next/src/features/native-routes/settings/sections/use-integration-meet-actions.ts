import { useRef, useState } from "react";
import { canonicalJsonString, type GoogleMeetSessionRecord } from "@goatcitadel/contracts";
import {
  startGoogleMeetSession,
  stopGoogleMeetSession,
  createGoogleMeetConsultHandoff,
  createRealtimeVoiceClientSecret,
  fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions,
  fetchVoiceStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getErrorMessage } from "../SettingsShared";
import { beginIntegrationMutation, useIntegrationConnectionMutation } from "../integration-connection-mutation";
import {
  assertMeetAction,
  assertMeetCreated,
  assertMeetPrerequisites,
  assertMeetSame,
  assertMeetToken,
  MEET_OWNER_BOUNDARY,
  MEET_OWNER_LIMIT,
  meetSessionBound,
  meetStartInput,
  requireMeetRecord,
  type MeetReview,
} from "./integration-meet-binding";
import type { IntegrationSettingsState } from "./use-integration-settings-state";

type MeetState = Pick<
  IntegrationSettingsState,
  "panel" | "meetForm" | "meetDraft" | "setMeetForm" | "setMeetBusySessionId" | "setNotice" | "reload" | "isCurrent"
>;
export function useIntegrationMeetActions(s: MeetState) {
  const installation = getGatewayApiBaseUrl(),
    key = `integration-meet:${installation}`;
  const meetMutation = useIntegrationConnectionMutation(key);
  const signature = canonicalJsonString(s.meetForm),
    generation = useRef({ signature });
  if (generation.current.signature !== signature) generation.current = { signature };
  const [review, setReview] = useState<MeetReview | null>(null);
  const reviewRef = useRef<MeetReview | null>(null),
    visibleOperation = useRef<object | null>(null);
  const current = () => s.isCurrent() && s.panel === "meet" && getGatewayApiBaseUrl() === installation;
  const reviewAction = (
    request:
      | Omit<Extract<MeetReview, { kind: "prepare" }>, "current">
      | Omit<Extract<MeetReview, { kind: "consult" | "stop" }>, "current">,
  ) => {
    if (!current() || meetMutation.locked) return;
    const captured = generation.current;
    const next: MeetReview = {
      ...request,
      current: () => current() && generation.current === captured && reviewRef.current === next,
    };
    reviewRef.current = next;
    setReview(next);
  };
  const cancelMeetReview = () => {
    reviewRef.current = null;
    setReview(null);
  };
  const handleStartGoogleMeetRealtime = () => {
    try {
      meetStartInput(s.meetForm, false);
      reviewAction({
        kind: "prepare",
        form: { ...s.meetForm },
        title: "Prepare Google Meet voice?",
        description: `Prepare ${s.meetForm.meetingUrl.trim()} using account reference ${s.meetForm.accountRef.trim() || "(missing)"}. This requests microphone permission for a brief local probe, creates a Gateway record, and may contact OpenAI for an ephemeral credential. ${MEET_OWNER_BOUNDARY}`,
      });
    } catch (error) {
      if (current()) s.setNotice({ tone: "warning", message: getErrorMessage(error) });
    }
  };
  const reviewSession = (kind: "consult" | "stop", session: GoogleMeetSessionRecord) => {
    if (!meetSessionBound(session) || !["running", "consulting"].includes(session.state)) return;
    reviewAction({
      kind,
      session: structuredClone(session),
      title: kind === "consult" ? "Record a Chat handoff?" : "Stop the meeting record?",
      description: `${session.displayName ?? session.meetingUrl} · ${session.sessionId}. ${kind === "consult" ? "Record a Chat handoff for this transcript; no conversation is sent automatically." : "Mark this Gateway meeting record stopped; recorded cleanup flags do not prove an external transport stopped."} ${MEET_OWNER_BOUNDARY}`,
    });
  };
  const confirmMeetReview = async () => {
    const reviewed = reviewRef.current;
    if (!reviewed?.current()) return;
    const op = beginIntegrationMutation(key);
    if (!op) return;
    const operation = {};
    visibleOperation.current = operation;
    s.setMeetBusySessionId(reviewed.kind === "prepare" ? "new" : reviewed.session.sessionId);
    let audio: MediaStream | undefined;
    const sameInstallation = () => getGatewayApiBaseUrl() === installation;
    const read = async (id: string) => {
      if (!sameInstallation()) throw new Error("Gateway installation changed before meeting readback.");
      const records = await fetchGoogleMeetSessions(MEET_OWNER_LIMIT);
      if (!sameInstallation()) throw new Error("Gateway installation changed during meeting readback.");
      return requireMeetRecord(records, id);
    };
    try {
      let message: string;
      if (reviewed.kind === "prepare") {
        if (
          typeof window === "undefined" ||
          typeof window.RTCPeerConnection !== "function" ||
          typeof navigator.mediaDevices?.getUserMedia !== "function"
        )
          throw new Error("Browser WebRTC and microphone APIs are required for the local probe.");
        audio = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!reviewed.current()) return;
        const input = meetStartInput(reviewed.form, audio.getAudioTracks().length > 0);
        const prerequisites = await fetchGoogleMeetPrerequisiteStatus(input);
        if (!reviewed.current()) return;
        assertMeetPrerequisites(prerequisites);
        const prior = await fetchGoogleMeetSessions(MEET_OWNER_LIMIT);
        if (!reviewed.current()) return;
        if (!Array.isArray(prior)) throw new Error("Current meeting records are unavailable.");
        const session = await op.write(
          () => startGoogleMeetSession(input),
          async (saved) => {
            assertMeetCreated(saved, input, prior);
            assertMeetSame(await read(saved.sessionId), saved);
          },
        );
        s.meetDraft.acceptSaved(reviewed.form, undefined, reviewed.form);
        if (!reviewed.current()) return;
        if (session.state === "blocked")
          message = `Meeting record ${session.sessionId} is blocked: ${session.failureReason ?? "prerequisites changed"}. No OpenAI credential was requested.`;
        else {
          const fresh = await read(session.sessionId);
          if (!reviewed.current()) return;
          assertMeetSame(fresh, session);
          const token = await op.write(
            () =>
              createRealtimeVoiceClientSecret({
                surface: "google-meet",
                meetingSessionId: session.sessionId,
                instructionsProfile: "google-meet",
              }),
            async (result) => {
              const [saved, voice] = await Promise.all([read(session.sessionId), fetchVoiceStatus()]);
              if (!sameInstallation()) throw new Error("Gateway installation changed during voice readback.");
              assertMeetToken(result, session, saved, voice);
            },
          );
          message = `Meeting record ${session.sessionId} and ephemeral ${token.model} / ${token.voice} credential preparation confirmed. No meeting was joined and no live audio connection was established.`;
        }
      } else {
        const fresh = await read(reviewed.session.sessionId);
        if (!reviewed.current()) return;
        assertMeetSame(fresh, reviewed.session);
        const saved = await op.write(
          () =>
            reviewed.kind === "stop"
              ? stopGoogleMeetSession(fresh.sessionId)
              : createGoogleMeetConsultHandoff(fresh.sessionId, { target: "chat" }),
          async (result) => {
            assertMeetAction(result, fresh, reviewed.kind);
            assertMeetSame(await read(fresh.sessionId), result);
          },
        );
        message =
          reviewed.kind === "stop"
            ? `Meeting record ${saved.sessionId} is stopped. External transport cleanup is unverified.`
            : `Chat handoff ${saved.consultHandoff!.handoffId} recorded for meeting ${saved.sessionId}. No Chat message was sent.`;
      }
      if (!reviewed.current()) return;
      const settledGeneration = generation.current;
      cancelMeetReview();
      s.setNotice({ tone: "success", message });
      try {
        await s.reload();
      } catch {
        if (current() && generation.current === settledGeneration && reviewRef.current === null)
          s.setNotice({ tone: "warning", message: `${message} Directory refresh failed.` });
      }
    } catch (error) {
      if (reviewed.current()) s.setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      for (const track of audio?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          /* Continue releasing other probe tracks. */
        }
      }
      op.finish();
      if (visibleOperation.current === operation) {
        visibleOperation.current = null;
        s.setMeetBusySessionId(null);
      }
    }
  };
  return {
    handleStartGoogleMeetRealtime,
    handleStopGoogleMeetSession: (session: GoogleMeetSessionRecord) => reviewSession("stop", session),
    handleConsultGoogleMeetSession: (session: GoogleMeetSessionRecord) => reviewSession("consult", session),
    meetReview: review?.current() ? review : null,
    meetMutation,
    confirmMeetReview,
    cancelMeetReview,
    setMeetForm: (next: Parameters<MeetState["setMeetForm"]>[0]) => {
      generation.current = { signature: "edited" };
      s.setMeetForm(next);
    },
  };
}
