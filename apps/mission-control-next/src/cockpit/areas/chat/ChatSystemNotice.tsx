import type { ChatThreadSystemNoticeRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ActorTimestamp } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadReadingPrimitives";

export function ChatSystemNotice({ notice }: { notice: ChatThreadSystemNoticeRecord }) {
  const label = notice.kind === "timer_due" ? "Timer due" : "Heartbeat";
  return (
    <section aria-label={label} className="mx-auto w-full max-w-4xl px-4 py-2">
      <div className="border-b border-line-subtle bg-sunken px-3 py-2">
        <p className="text-xs text-fg-muted">
          <strong className="text-fg">{label}</strong> · <ActorTimestamp timestamp={notice.message.timestamp} />
        </p>
        <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-sm text-fg">{notice.message.content}</p>
      </div>
    </section>
  );
}

export function partitionSystemNotices(
  systemNotices: ChatThreadSystemNoticeRecord[] | undefined,
  visibleTurns: ChatThreadTurnRecord[],
) {
  const noticesBeforeTurn = new Map<string, ChatThreadSystemNoticeRecord[]>();
  const notices = systemNotices ?? [];
  let nextNotice = 0;
  for (const turn of visibleTurns) {
    const start = nextNotice;
    const turnTime = Date.parse(turn.userMessage.timestamp);
    while (nextNotice < notices.length && Date.parse(notices[nextNotice]!.message.timestamp) < turnTime) {
      nextNotice += 1;
    }
    if (nextNotice > start) noticesBeforeTurn.set(turn.turnId, notices.slice(start, nextNotice));
  }
  return { noticesBeforeTurn, trailingNotices: notices.slice(nextNotice) };
}
