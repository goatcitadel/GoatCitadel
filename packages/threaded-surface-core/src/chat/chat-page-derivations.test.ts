import { describe, expect, it } from "vitest";
import { dedupeStrings, deriveCoworkItems, formatCommandResult, isAbortError } from "./chat-page-derivations";

describe("chat-page-derivations", () => {
  it("dedupes trimmed strings and formats command results", () => {
    expect(dedupeStrings([" alpha ", undefined, "beta", "alpha", " "])).toEqual(["alpha", "beta"]);
    expect(formatCommandResult({ ok: true, message: "Done" })).toBe("Command completed: Done");
    expect(
      formatCommandResult({ ok: false, message: "Nope", research: { sources: [{ url: "https://a.test" }] } }),
    ).toBe("Command failed: Nope\nSources: 1");
  });

  it("derives cowork items from orchestration steps first", () => {
    expect(
      deriveCoworkItems([], [], {
        steps: [
          { stepId: "step-1", role: "planner", status: "completed", summary: "Plan done" },
          { stepId: "step-2", role: "worker", status: "failed", error: "Tool failed" },
          { stepId: "step-3", role: "reviewer", status: "running", providerId: "openai", model: "gpt-5.5" },
          { stepId: "step-4", role: "synth", status: "queued" },
          { stepId: "step-5", role: "qa", status: "queued" },
          { stepId: "step-6", role: "extra", status: "queued" },
        ],
      } as never),
    ).toEqual([
      { id: "step-1", title: "planner · completed", note: "Plan done" },
      { id: "step-2", title: "worker · failed", note: "Tool failed" },
      { id: "step-3", title: "reviewer · running", note: "openai · gpt-5.5" },
      { id: "step-4", title: "synth · queued", note: "" },
      { id: "step-5", title: "qa · queued", note: "" },
    ]);
  });

  it("derives cowork items from assistant lines, user goal, and notices", () => {
    const items = deriveCoworkItems(
      [
        {
          messageId: "user-1",
          role: "user",
          content: "Please coordinate a very long request ".repeat(10),
        },
        {
          messageId: "assistant-1",
          role: "assistant",
          content: `${"Long assistant line ".repeat(10)}\nSecond line\nThird line\nFourth line`,
        },
      ] as never,
      [
        { id: "notice-1", content: "Notice one ".repeat(20) },
        { id: "notice-2", content: "Notice two" },
        { id: "notice-3", content: "Hidden" },
      ] as never,
    );

    expect(items).toHaveLength(5);
    expect(items[0]?.id).toBe("assistant-0");
    expect(items[0]?.title.endsWith("...")).toBe(true);
    expect(items[4]).toMatchObject({ id: "notice-notice-1", title: "Latest system notice" });

    const fallbackItems = deriveCoworkItems(
      [{ messageId: "user-1", role: "user", content: "Only user goal" }] as never,
      [{ id: "notice-1", content: "Notice" }] as never,
    );
    expect(fallbackItems[0]).toEqual({
      id: "user-goal",
      title: "Current operator request",
      note: "Only user goal",
    });
  });

  it("recognizes DOM and plain-object abort errors", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError({ name: "OtherError" })).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
