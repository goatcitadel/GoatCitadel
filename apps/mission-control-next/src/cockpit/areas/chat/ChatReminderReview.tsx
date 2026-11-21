import type { ChatReminderPreview, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";

export function ChatReminderReview({
  turn,
  onReview,
}: {
  turn: ChatThreadTurnRecord;
  onReview: (preview: ChatReminderPreview) => void;
}) {
  const run = [...turn.toolRuns]
    .reverse()
    .find(
      (candidate) =>
        candidate.toolName === "chat.reminder.preview" &&
        candidate.turnId === turn.turnId &&
        candidate.sessionId === turn.trace.sessionId &&
        candidate.status === "executed",
    );
  const preview = run?.result?.reminderPreview;
  if (
    !preview ||
    typeof preview !== "object" ||
    !("localDueAt" in preview) ||
    typeof preview.localDueAt !== "string" ||
    !("timezone" in preview) ||
    typeof preview.timezone !== "string" ||
    !("message" in preview) ||
    typeof preview.message !== "string"
  )
    return null;
  const { localDueAt, timezone, message } = preview;
  return (
    <Button variant="secondary" onClick={() => onReview({ localDueAt, timezone, message })}>
      Review reminder
    </Button>
  );
}
