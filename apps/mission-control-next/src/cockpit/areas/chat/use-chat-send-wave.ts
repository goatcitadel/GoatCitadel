import { useLayoutEffect, useRef } from "react";
import { useControlWave } from "../../ui/use-control-wave";
import type { ComposerProps } from "./ChatTextComposer.types";

const SEND_WAVE_START_WINDOW_MS = 500;

export function useChatSendWave(
  phone: boolean,
  {
    selectedSessionId,
    sending,
    hasActiveStream,
  }: Pick<ComposerProps, "selectedSessionId" | "sending" | "hasActiveStream">,
) {
  const sendButton = useRef<HTMLButtonElement>(null);
  const sendWaveIntent = useRef<{ checking: boolean; expiresAt: number }>(undefined);
  const { play, stop } = useControlWave();

  // The submit control stays mounted as a response starts. A different owner or layout ends its wave.
  useLayoutEffect(() => {
    sendWaveIntent.current = undefined;
    stop();
  }, [phone, selectedSessionId, stop]);
  useLayoutEffect(() => {
    const request = sendWaveIntent.current;
    if (!request) return;
    if (hasActiveStream) {
      sendWaveIntent.current = undefined;
      const control = sendButton.current;
      if (control && (request.checking || Date.now() <= request.expiresAt)) {
        // Adding Stop can move the submit button, so originate from the committed control.
        play(control, control, undefined, { preserveText: true, stopOnContentChange: true });
      }
    } else if (sending) {
      request.checking = true;
    } else if (request.checking) {
      sendWaveIntent.current = undefined;
    }
  }, [play, hasActiveStream, sending]);

  function requestSendWave() {
    sendWaveIntent.current = { checking: false, expiresAt: Date.now() + SEND_WAVE_START_WINDOW_MS };
  }

  return { sendButton, requestSendWave };
}
