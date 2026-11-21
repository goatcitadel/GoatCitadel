import { useLayoutEffect, useRef } from "react";
import { useChatTimerPanel } from "./useChatTimerPanel";

export function ChatTimerRuntime({
  input,
  request,
  publish,
}: {
  input: Parameters<typeof useChatTimerPanel>[0];
  request?: object;
  publish: (panel: ReturnType<typeof useChatTimerPanel>["chatTimerPanel"]) => void;
}) {
  const { chatTimerPanel, openChatTimerPanel } = useChatTimerPanel(input);
  const previous = useRef<typeof request>(undefined);
  useLayoutEffect(() => {
    if (request && previous.current !== request) openChatTimerPanel();
    previous.current = request;
  }, [openChatTimerPanel, request]);
  useLayoutEffect(() => publish(chatTimerPanel), [chatTimerPanel, publish]);
  return null;
}
