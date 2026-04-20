import { describe, expect, it } from "vitest";
import { deriveCoworkItems } from "./chat-page-derivations";

describe("deriveCoworkItems", () => {
  it("normalizes and truncates long operator text for cowork queue cards", () => {
    const items = deriveCoworkItems(
      [
        {
          messageId: "user-1",
          sessionId: "sess-1",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content:
            "We need a release-readiness pass for Mission Control Cowork.\n\nGoal:\nidentify the 3 biggest UX issues on the current Cowork surface and propose the smallest safe fixes before implementation.",
          timestamp: "2026-04-19T22:00:00.000Z",
        } as any,
      ],
      [
        {
          id: "notice-1",
          tone: "warning",
          content:
            "Stream interrupted. Reconnecting to turn 1234567890 because the previous attempt failed before completion.",
        },
      ] as any,
    );

    const operatorItem = items.find((item) => item.id === "user-goal");
    expect(operatorItem?.title).toBe("Current operator request");
    expect(operatorItem?.note).toBeDefined();
    expect(operatorItem?.note).not.toContain("\n");
    expect(operatorItem?.note?.length).toBeLessThanOrEqual(132);
    expect(operatorItem?.note?.endsWith("...")).toBe(true);
  });
});
