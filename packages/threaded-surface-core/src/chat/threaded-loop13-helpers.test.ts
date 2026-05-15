import { describe, expect, it } from "vitest";

import { buildQueuedOutboundItemView } from "./chat-page-helpers";
import { formatWorkloadSummaryDescriptor } from "./work-trust";

describe("threaded loop13 helper tails", () => {
  it("uses queued labels when queued outbound items have no content or target turn", () => {
    expect(
      buildQueuedOutboundItemView({
        id: "queue-loop13",
        action: "send",
        content: "   ",
        createdAt: "2026-05-14T00:00:00.000Z",
      }),
    ).toMatchObject({
      label: "Turn queued",
      paused: undefined,
    });
  });

  it("formats singular open-task and high-cost workload tails", () => {
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 0,
        openTasksCount: 1,
        dailyCostUsd: 12.34,
      }),
    ).toEqual({ tone: "muted", label: "1 open task · $12.3" });
  });
});
