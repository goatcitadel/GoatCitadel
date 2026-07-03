import { isChatTurnActiveStatus, type ChatTurnLifecycleStatus } from "@goatcitadel/contracts";

/**
 * Renders the collapsible "thinking" disclosure for a turn's accumulated
 * reasoning text (see `ChatThreadTurnRecord.thinking`). Data-driven-inert: this
 * is a pure function of `thinking` — while the gateway's `chatThinkingStreamV1Enabled`
 * flag stays at its default (off), no `thinking_delta` chunk is ever emitted, so
 * `thinking` stays `undefined` and this component renders nothing everywhere it
 * is mounted. No aria-live/role=status: the surface owns a single live region
 * elsewhere (see StreamingAssistantSkeleton's comment for the same rule).
 */
export function ChatThinkingSection({
  thinking,
  turnStatus,
}: {
  thinking: string | undefined;
  turnStatus: ChatTurnLifecycleStatus;
}) {
  if (!thinking) {
    return null;
  }
  const label = isChatTurnActiveStatus(turnStatus) ? "Thinking…" : "Thought process";
  return (
    <details className="mc-next-thread-thinking">
      <summary>{label}</summary>
      <div className="mc-next-thread-thinking-body">{thinking}</div>
    </details>
  );
}
