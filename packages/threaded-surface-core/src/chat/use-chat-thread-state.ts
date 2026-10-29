import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { carryOverStreamedThinking } from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/**
 * The open conversation's thread state. Every write goes through `carryOverStreamedThinking`, so a reloaded copy of
 * the thread keeps the reasoning this browser already streamed (the Gateway never saves it).
 */
export function useChatThreadState() {
  const [thread, setThreadState] = useState<ChatThreadResponse | null>(null);
  const setThread = useCallback<Dispatch<SetStateAction<ChatThreadResponse | null>>>(
    (update) =>
      setThreadState((current) =>
        carryOverStreamedThinking(current, typeof update === "function" ? update(current) : update),
      ),
    [],
  );
  return [thread, setThread] as const;
}
