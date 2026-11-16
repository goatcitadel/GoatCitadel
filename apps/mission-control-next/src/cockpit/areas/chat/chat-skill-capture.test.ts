import { WORKFLOW_SKILL_CAPTURE_MARKER, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { skillCaptureVisibility } from "./chat-skill-capture";

const turn = (over: { status?: string; completion?: string; answer?: string; user?: string }) =>
  ({
    turnId: "turn-1",
    trace: { status: over.status ?? "completed", completion: { status: over.completion ?? "complete" } },
    userMessage: { content: over.user ?? "Summarize the launch." },
    assistantMessage: over.answer === "" ? undefined : { content: over.answer ?? "The launch is ready." },
  }) as unknown as ChatThreadTurnRecord;

describe("Save as skill visibility", () => {
  it("offers capture from the menu and shows the block only on request or for a draft (U-CH-011)", () => {
    const completedAnswer = turn({});
    const captureDraftTurn = turn({ user: WORKFLOW_SKILL_CAPTURE_MARKER + "{}" });
    const failedTurn = turn({ status: "failed" });
    expect(skillCaptureVisibility(completedAnswer, false)).toBe("offered");
    expect(skillCaptureVisibility(completedAnswer, true)).toBe("shown");
    expect(skillCaptureVisibility(captureDraftTurn, false)).toBe("shown");
    expect(skillCaptureVisibility(failedTurn, true)).toBe("hidden");
  });

  it("hides capture for an incomplete answer or one with no text, even when requested", () => {
    expect(skillCaptureVisibility(turn({ completion: "partial" }), true)).toBe("hidden");
    expect(skillCaptureVisibility(turn({ answer: "" }), true)).toBe("hidden");
    expect(skillCaptureVisibility(turn({ status: "failed", user: WORKFLOW_SKILL_CAPTURE_MARKER + "{}" }), false)).toBe(
      "hidden",
    );
  });
});
