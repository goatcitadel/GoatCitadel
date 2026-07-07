import { describe, expect, it } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { canRetryTurn, getTurnPendingLabel, humanizeEnum, toTitleCase } from "./chat-display-helpers";

function failedTrace(failure?: ChatTurnTraceRecord["failure"]): ChatTurnTraceRecord {
  return {
    turnId: "turn-a",
    sessionId: "session-a",
    userMessageId: "msg-a",
    branchKind: "append",
    status: "failed",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: "2026-07-07T19:46:20.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
    failure,
  };
}

describe("getTurnPendingLabel", () => {
  it("describes a restart-interrupted turn instead of showing a raw error", () => {
    expect(
      getTurnPendingLabel(
        failedTrace({
          failureClass: "interrupted_by_restart",
          message: "backend detail",
          retryable: true,
          recommendedAction: "retry",
        }),
      ),
    ).toBe("Interrupted by a gateway restart — retry to run it again.");
  });

  it("keeps the persisted failure message for other failure classes", () => {
    expect(getTurnPendingLabel(failedTrace({ failureClass: "tool_failed", message: "Tool exploded." }))).toBe(
      "Tool exploded.",
    );
  });
});

describe("canRetryTurn", () => {
  it("allows retry when an assistant message exists", () => {
    expect(canRetryTurn({ assistantMessage: { messageId: "m" } as never, trace: failedTrace() })).toBe(true);
  });

  it("allows retry for a retryable failure even without assistant output", () => {
    expect(
      canRetryTurn({
        assistantMessage: undefined,
        trace: failedTrace({ failureClass: "interrupted_by_restart", message: "x", retryable: true }),
      }),
    ).toBe(true);
  });

  it("denies retry when there is no assistant output and no retryable failure", () => {
    expect(canRetryTurn({ assistantMessage: undefined, trace: failedTrace() })).toBe(false);
    expect(
      canRetryTurn({
        assistantMessage: undefined,
        trace: failedTrace({ failureClass: "tool_failed", message: "x", retryable: false }),
      }),
    ).toBe(false);
  });
});

describe("humanizeEnum", () => {
  it("maps known system enums to friendly phrasing", () => {
    expect(humanizeEnum("error_fallback")).toBe("auto-failover");
    expect(humanizeEnum("template_fallback")).toBe("template default");
    expect(humanizeEnum("waiting_for_approval")).toBe("waiting for approval");
    expect(humanizeEnum("live")).toBe("live");
  });

  it("title-cases unmapped bare snake_case identifiers so raw enum text does not leak", () => {
    expect(humanizeEnum("some_new_state")).toBe("Some New State");
    expect(humanizeEnum("fallback")).toBe("Fallback");
  });

  it("leaves already human-readable phrases untouched", () => {
    expect(humanizeEnum("primary rate-limited")).toBe("primary rate-limited");
  });

  it("returns an empty string for nullish or blank input", () => {
    expect(humanizeEnum(undefined)).toBe("");
    expect(humanizeEnum(null)).toBe("");
    expect(humanizeEnum("   ")).toBe("");
  });

  it("keeps toTitleCase available for callers that always want title case", () => {
    expect(toTitleCase("error_fallback")).toBe("Error Fallback");
  });
});
