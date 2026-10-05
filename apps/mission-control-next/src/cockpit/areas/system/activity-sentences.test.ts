import type { RealtimeEvent } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { activityRunLabel, collapseActivity, describeActivity } from "./activity-sentences";

let sequence = 0;
function event(kind: string, overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  sequence += 1;
  const system = kind.startsWith("llamacpp_") || kind.startsWith("npu_") || kind.startsWith("proactive_");
  return {
    eventId: `event-${sequence}`,
    sequence,
    eventType: system ? "system" : kind,
    source: "gateway",
    timestamp: "2026-10-05T10:00:00.000Z",
    payload: system ? { type: kind } : {},
    ...overrides,
  };
}

describe("describeActivity (SY-01)", () => {
  it.each([
    ["llamacpp_refreshed", "Local model status changed"],
    ["llamacpp_started", "Local model started"],
    ["llamacpp_stopped", "Local model stopped"],
    ["llamacpp_exited", "Local model stopped unexpectedly"],
    ["chat_message", "New message in a conversation"],
    ["chat_thread_updated", "A conversation was updated"],
    ["chat_session_title_updated", "A conversation was renamed"],
    ["approval_created", "An approval is waiting for you"],
    ["approval_resolved", "An approval was decided"],
    ["task_created", "A task was added"],
    ["task_updated", "A task was updated"],
    ["task_deleted", "A task was deleted"],
    ["cron_job_run", "A scheduled job ran"],
    ["backup_created", "A backup was created"],
    ["workspace_created", "A workspace was created"],
    ["workspace_updated", "A workspace was changed"],
    ["workspace_archived", "A workspace was archived"],
    ["workspace_restored", "A workspace was restored"],
    ["inbox.changed", "Your Inbox changed"],
    ["code_mode_run_completed", "A code run finished"],
    ["code_mode_run_failed", "A code run failed"],
    ["memory_qmd_generated", "Memory summary updated"],
    ["remote_worker_changed", "Remote worker changed"],
  ])("%s reads “%s”", (kind, sentence) => {
    expect(describeActivity(event(kind)).sentence).toBe(sentence);
  });

  it("names the conversation when the payload carries its title", () => {
    expect(describeActivity(event("chat_message", { payload: { title: "Backup plan" } })).sentence).toBe(
      "New message in “Backup plan”",
    );
  });

  it("marks operational signals and the status-refresh family as background", () => {
    expect(describeActivity(event("llamacpp_refreshed")).operational).toBe(true);
    expect(describeActivity(event("inbox.changed")).operational).toBe(true);
    expect(describeActivity(event("proactive_tick")).operational).toBe(true);
    expect(describeActivity(event("npu_refreshed")).operational).toBe(true);
    expect(describeActivity(event("task_created", { eventClass: "operational_signal" })).operational).toBe(true);
    expect(describeActivity(event("approval_created")).operational).toBe(false);
  });

  it("never shows an enum slug", () => {
    const kinds = ["llamacpp_refreshed", "chat_message", "some_future_event", "system"];
    for (const kind of kinds) expect(describeActivity(event(kind)).sentence).not.toContain("_");
  });
});

describe("collapseActivity", () => {
  it("collapses 96 identical consecutive events into one row with a count and span", () => {
    const start = Date.parse("2026-10-05T10:00:00.000Z");
    const events = Array.from({ length: 96 }, (_, index) =>
      event("llamacpp_refreshed", { timestamp: new Date(start + (95 - index) * 1250).toISOString() }),
    );
    const rows = collapseActivity([event("approval_created"), ...events, event("approval_created")]);
    expect(rows.map((row) => row.count)).toEqual([1, 96, 1]);
    expect(rows[1]?.event).toBe(events[0]);
    expect(activityRunLabel(rows[1]!)).toBe("×96 in 2 min");
    expect(activityRunLabel(rows[0]!)).toBe("");
  });
});
