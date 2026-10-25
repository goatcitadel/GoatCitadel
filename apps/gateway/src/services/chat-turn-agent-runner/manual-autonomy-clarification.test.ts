import { describe, expect, it } from "vitest";
import { buildManualAutonomyClarification } from "./manual-autonomy-clarification.js";

const AMBIGUOUS_PROMPT = "Research the best option for me and decide.";

function history(...userTurns: string[]) {
  return userTurns.flatMap((content, index) =>
    index < userTurns.length - 1
      ? [
          { role: "user", content },
          { role: "assistant", content: "Noted." },
        ]
      : [{ role: "user", content }],
  );
}

describe("buildManualAutonomyClarification", () => {
  it("asks what the vague referent means and says tools are off", () => {
    const reply = buildManualAutonomyClarification(AMBIGUOUS_PROMPT, history(AMBIGUOUS_PROMPT));

    expect(reply).toBeDefined();
    expect(reply).toContain('"The best option" for what?');
    expect(reply).toMatch(/what you're choosing between/i);
    expect(reply).toContain("tool autonomy is set to Manual");
    expect(reply).toContain("Inspect > Conversation > Tool autonomy");
    // Must not look like a pending clarification, or the next turn would be held by the follow-up guard.
    expect(reply).not.toContain("answering that responsibly");
  });

  it.each([
    "Find the right one for me.",
    "Look online, pick the best choice and decide for me please",
    "Research a good option and choose it yourself.",
  ])("treats %j as missing a subject", (prompt) => {
    expect(buildManualAutonomyClarification(prompt, history(prompt))).toBeDefined();
  });

  it.each([
    "Research the best option for a 14-inch laptop under $1000 and decide.",
    "Research the best option between Postgres and SQLite for me and decide.",
    "Look online and tell me the 5 most interesting things that happened today.",
    "Research flight prices to Lisbon next week.",
  ])("leaves %j to the deterministic decline", (prompt) => {
    expect(buildManualAutonomyClarification(prompt, history(prompt))).toBeUndefined();
  });

  it("does not ask when an earlier user turn gives the referent", () => {
    const turns = history("I'm choosing between Postgres and SQLite for a small app.", AMBIGUOUS_PROMPT);

    expect(buildManualAutonomyClarification(AMBIGUOUS_PROMPT, turns)).toBeUndefined();
  });

  it("asks when the history holds only the current message or nothing", () => {
    expect(buildManualAutonomyClarification(AMBIGUOUS_PROMPT, [])).toBeDefined();
    expect(buildManualAutonomyClarification(AMBIGUOUS_PROMPT, [{ role: "system", content: "x" }])).toBeDefined();
  });
});
