import { useState } from "react";
import type { ChatVisualStreamMode } from "../chat-streaming-preview";
import { readVisualStreamModeFromStorage } from "../mission-threaded-controller-helpers";

type Input = {
  STREAM_PREF_KEY: "goatcitadel.chat.agent.stream.enabled";
};

/** Reads initial stream display preferences without changing persistence timing. */
export function useChatStreamPreferences({ STREAM_PREF_KEY }: Input) {
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(STREAM_PREF_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const [visualStreamMode, setVisualStreamMode] = useState<ChatVisualStreamMode>(() =>
    readVisualStreamModeFromStorage(),
  );

  return { streamEnabled, visualStreamMode, setStreamEnabled, setVisualStreamMode };
}
