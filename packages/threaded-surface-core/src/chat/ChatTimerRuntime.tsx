import { useLayoutEffect, useRef } from "react";
import type { ChatTimerDraft } from "./chat-timer-form";
import { useChatTimerPanel } from "./useChatTimerPanel";

export function ChatTimerRuntime({
  input,
  request,
  publish,
}: {
  input: Parameters<typeof useChatTimerPanel>[0];
  request?: { draft?: ChatTimerDraft };
  publish: (panel: ReturnType<typeof useChatTimerPanel>["chatTimerPanel"]) => void;
}) {
  const { chatTimerPanel, openChatTimerPanel } = useChatTimerPanel(input);
  const previous = useRef<typeof request>(undefined);
  useLayoutEffect(() => {
    if (request && previous.current !== request) openChatTimerPanel(request.draft);
    previous.current = request;
  }, [openChatTimerPanel, request]);
  useLayoutEffect(() => publish(chatTimerPanel), [chatTimerPanel, publish]);
  return null;
}
