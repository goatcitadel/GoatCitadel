import { ChatLearnedMemoryPanel } from "./ChatLearnedMemoryPanel";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";

export function ChatDockMemorySection(
  props: Pick<
    ChatContextDockPanelsProps,
    | "learnedMemory"
    | "secondaryLoading"
    | "sending"
    | "selectedSessionId"
    | "onRebuildLearnedMemory"
    | "onUpdateMemoryStatus"
  >,
) {
  const { learnedMemory, secondaryLoading, sending, selectedSessionId, onRebuildLearnedMemory, onUpdateMemoryStatus } =
    props;

  return (
    <ChatLearnedMemoryPanel
      learnedMemory={learnedMemory}
      secondaryLoading={secondaryLoading}
      sending={sending}
      selectedSessionId={selectedSessionId}
      onRebuild={() => void onRebuildLearnedMemory()}
      onUpdateStatus={(itemId, status) => void onUpdateMemoryStatus(itemId, status)}
    />
  );
}
