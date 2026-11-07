import {
  ChatNoticeTechnicalDetails,
  ChatThreadNotices,
} from "@goatcitadel/mission-control-shared/components/chat/ChatThreadReadingPrimitives";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { ChatNoticeText } from "./ChatNoticeText";

export function ChatTranscriptNotices({
  notices,
  selectedSessionId,
}: Pick<MissionThreadedActiveSessionSurfaceProps, "notices" | "selectedSessionId">) {
  const importantNotices =
    notices?.filter((notice) => notice.tone === "warning" || notice.tone === "critical") ?? [];
  const routineNotices =
    notices?.filter((notice) => notice.tone !== "warning" && notice.tone !== "critical") ?? [];
  // Notices remain owned by the conversation controller; only routine history folds away.
  const latestRoutine = routineNotices.reduce<(typeof routineNotices)[number] | undefined>(
    (latest, notice) => (!latest || notice.timestamp > latest.timestamp ? notice : latest),
    undefined,
  );
  return (
    <>
      {importantNotices.map((notice) => {
        // Critical differs from a warning by its label and icon, not only by colour.
        const critical = notice.tone === "critical";
        const Icon = critical ? OctagonAlert : TriangleAlert;
        return (
          <div
            role="note"
            key={notice.id}
            className={`flex gap-2 rounded-md border p-2 text-sm text-fg-secondary ${critical ? "border-status-failed" : "border-status-waiting"}`}
            aria-label={critical ? "Critical conversation notice" : "Conversation warning"}
          >
            <Icon
              aria-hidden="true"
              className={`mt-0.5 size-4 shrink-0 ${critical ? "text-status-failed" : "text-status-waiting"}`}
            />
            <div className="min-w-0">
              <strong className="font-medium text-fg">{critical ? "Critical: " : "Warning: "}</strong>
              <ChatNoticeText content={notice.content} />
              <ChatNoticeTechnicalDetails key={`${selectedSessionId}:${notice.id}`} notice={notice} />
            </div>
          </div>
        );
      })}
      {latestRoutine ? (
        <div
          role="note"
          className="rounded-md border border-line-subtle bg-raised p-2 text-sm text-fg-secondary"
          aria-label="Latest conversation update"
        >
          <ChatNoticeText content={latestRoutine.content} />
          <ChatNoticeTechnicalDetails key={`${selectedSessionId}:${latestRoutine.id}`} notice={latestRoutine} />
        </div>
      ) : null}
      <ChatThreadNotices
        notices={routineNotices.filter((notice) => notice !== latestRoutine)}
        scopeKey={selectedSessionId}
      />
    </>
  );
}
