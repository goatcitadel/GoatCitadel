import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import type { ChannelConversationContext } from "./channel-conversation";
import { useEffect, useRef, useState } from "react";

export function useTranscriptAnnouncement(
  sessionId: string | null,
  hasActiveStream: boolean,
  reviewOutcome: string | undefined,
  status: string | undefined,
  decisionWaiting: boolean,
) {
  const lifecycle = useRef({ session: sessionId, running: false, reviewing: false });
  const [announcement, setAnnouncement] = useState("");
  // Review answer's call runs after the answer has streamed; announce it once, when it starts.
  const reviewing = hasActiveStream && reviewOutcome === "running";
  useEffect(() => {
    const previous = lifecycle.current;
    if (previous.session !== sessionId) setAnnouncement("");
    else if (hasActiveStream && !previous.running) setAnnouncement("Response started.");
    else if (reviewing && !previous.reviewing) setAnnouncement("Reviewing the answer.");
    else if (!hasActiveStream && previous.running)
      setAnnouncement(
        status === "cancelled"
          ? "Response stopped."
          : status === "failed"
            ? "Response failed. Review the conversation details."
            : decisionWaiting
              ? "Response ended. A decision is waiting for you."
              : "Response ended.",
      );
    lifecycle.current = { session: sessionId, running: hasActiveStream, reviewing };
  }, [sessionId, hasActiveStream, status, decisionWaiting, reviewing]);
  return announcement;
}

export type ChatTranscriptProps = {
  props: MissionThreadedActiveSessionSurfaceProps;
  /** Set when the open conversation is held through a channel; callers keep the object stable. */
  channel?: ChannelConversationContext;
  gatewayUnavailable?: boolean;
  receipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"];
  onInspectTurn?: (turnId: string) => void;
  onInspectRun?: (turnId: string) => void;
  onOpenArtifact?: (turnId: string, artifactId?: string) => void;
  onReviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
  /** Opens a fresh conversation; a failed turn offers it when the conversation is too long for the model. */
  onNewConversation?: () => void;
};
