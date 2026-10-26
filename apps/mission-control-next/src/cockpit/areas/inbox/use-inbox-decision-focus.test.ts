import { describe, expect, it } from "vitest";
import { decisionOutcome } from "./use-inbox-decision-focus";

describe("decisionOutcome", () => {
  it("names the denied item", () => {
    const outcome = decisionOutcome(
      "Review file write",
      "Decision recorded: Denied. Follow-on execution needs separate verification.",
    );
    expect(outcome.verdict).toBe("Denied Review file write.");
    expect(outcome.announcement).toBe("Denied Review file write. Follow-on execution needs separate verification.");
  });

  it("names the approved item the same way", () => {
    expect(
      decisionOutcome("Run command", "Decision recorded: Approved. Follow-on settlement is pending.").verdict,
    ).toBe("Approved Run command.");
    expect(decisionOutcome("Run command", "Decision recorded: Approved with edits. x").verdict).toBe(
      "Approved with edits Run command.",
    );
  });

  it("passes any other message through unchanged", () => {
    const message = "The approval changed. Review the refreshed record before deciding.";
    expect(decisionOutcome("Run command", message)).toEqual({ verdict: null, announcement: message });
  });
});
