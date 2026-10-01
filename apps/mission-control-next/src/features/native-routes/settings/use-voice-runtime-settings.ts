import { useEffect, useRef, useState } from "react";
import type { VoiceRuntimeStatus } from "@goatcitadel/contracts";
import {
  fetchVoiceRuntimeStatus,
  installVoiceRuntime,
  selectVoiceRuntimeModel,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  beginVoiceAttempt,
  finishVoiceAttempt,
  requireVoiceReceipt,
  useVoiceAttempt,
  voiceActionAvailable,
  voiceReady,
  voiceSnapshot,
  type VoiceRuntimeAction,
  type VoiceRuntimeReviewValue,
} from "./voice-runtime-state";

export function useVoiceRuntimeSettings(options: {
  status?: VoiceRuntimeStatus | null;
  available: boolean;
  active?: boolean;
  reload: () => Promise<unknown>;
}) {
  const installation = getGatewayApiBaseUrl();
  const key = `voice-runtime:${installation}`;
  const attempt = useVoiceAttempt(key);
  const active = options.active !== false;
  const ready = options.available && voiceReady(options.status);
  const [review, setReview] = useState<VoiceRuntimeReviewValue | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef({ mounted: false, epoch: 0, identity: "" });
  const identity = voiceSnapshot([installation, active, ready, options.status]);
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch++;
  }
  useEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
    };
  }, []);
  useEffect(() => {
    if (!active) setReview(null);
  }, [active]);
  const canRequest = (action: VoiceRuntimeAction) =>
    Boolean(active && ready && !attempt && options.status && voiceActionAvailable(options.status, action));
  const reviewCurrent = Boolean(
    review && canRequest(review) && voiceSnapshot(review.current) === voiceSnapshot(options.status),
  );
  async function confirm() {
    if (!review || !reviewCurrent || !beginVoiceAttempt(key)) return;
    const intent = review,
      epoch = live.current.epoch;
    const current = () =>
      live.current.mounted && live.current.epoch === epoch && getGatewayApiBaseUrl() === installation;
    let dispatched = false,
      acknowledged = false;
    setMessage(null);
    setReview(null);
    try {
      const latest = await fetchVoiceRuntimeStatus();
      if (!current()) return;
      if (voiceSnapshot(latest) !== voiceSnapshot(intent.current) || !voiceActionAvailable(latest, intent)) {
        setMessage("Voice runtime evidence changed. Refresh and review the action again.");
        await options.reload();
        return;
      }
      dispatched = true;
      const receipt =
        intent.kind === "install"
          ? await installVoiceRuntime({ modelId: intent.modelId, activate: true })
          : await selectVoiceRuntimeModel(intent.modelId);
      requireVoiceReceipt(intent, receipt);
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
      const saved = await fetchVoiceRuntimeStatus();
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed.");
      requireVoiceReceipt(intent, saved);
      if (voiceSnapshot(saved) !== voiceSnapshot(receipt))
        throw new Error("Voice runtime readback did not match its response.");
      acknowledged = true;
      if (current()) {
        setMessage(
          `${intent.kind === "install" ? "Voice installation" : "Voice model selection"} confirmed. Runtime readiness: ${saved.readiness}. No microphone session was started.`,
        );
        try {
          await options.reload();
        } catch {
          /* Canonical response and readback already confirmed. */
        }
      }
    } catch {
      if (!dispatched && current())
        setMessage("Current voice runtime evidence is unavailable. No installation or selection request was sent.");
    } finally {
      finishVoiceAttempt(key, dispatched && !acknowledged);
    }
  }
  return {
    ready,
    attempt,
    review,
    reviewCurrent,
    message,
    canRequest,
    confirm,
    requestReview: (action: VoiceRuntimeAction) => {
      if (canRequest(action) && options.status) {
        setReview({ ...action, current: structuredClone(options.status) });
        setMessage(null);
      }
    },
    cancel: () => {
      live.current.epoch++;
      setReview(null);
    },
  };
}
