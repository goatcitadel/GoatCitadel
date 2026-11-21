import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatReminderReview } from "./ChatReminderReview";

const preview = { message: "Call Jamie", timezone: "America/Los_Angeles", localDueAt: "2027-01-04T09:00" };
const executed = {
  sessionId: "chat",
  turnId: "turn",
  status: "executed",
  toolName: "chat.reminder.preview",
  result: { reminderPreview: preview },
};
function view(run: typeof executed, onReview = vi.fn()) {
  const turn = { turnId: "turn", trace: { sessionId: "chat" }, toolRuns: [run] } as unknown as ChatThreadTurnRecord;
  return create(<ChatReminderReview turn={turn} onReview={onReview} />);
}
describe("Reminder review action", () => {
  it("hands the canonical tool preview to the Chat editor only when clicked", () => {
    const open = vi.fn();
    const action = view(executed, open).root.findByType("button");
    expect(open).not.toHaveBeenCalled();
    action.props.onClick({});
    expect(open).toHaveBeenCalledWith(preview);
  });
  it.each([{ status: "blocked" }, { sessionId: "foreign" }, { turnId: "other" }, { toolName: "web.search" }])(
    "withholds actions from unrelated results",
    (override) => {
      expect(view({ ...executed, ...override }).toJSON()).toBeNull();
    },
  );
});
