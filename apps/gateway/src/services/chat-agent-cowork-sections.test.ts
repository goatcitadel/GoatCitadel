import { describe, expect, it } from "vitest";
import {
  compactCoworkOutputToWordLimit,
  detectCoworkRoleOrder,
  extractExactCoworkSections,
  extractRequestedCoworkSectionBulletCount,
  normalizeCoworkRoleLabel,
  normalizeCoworkSectionBody,
  promptKeepsRequestedRoleOrderOnly,
  repairRequestedRoleOrderOnlyCoworkOutput,
} from "./chat-agent-cowork-sections.js";

describe("chat agent cowork section helpers", () => {
  it("keeps exact requested sections when the prompt forbids synthesis or extra headings", () => {
    const prompt = [
      "Keep exactly these sections in order:",
      "- `Planner`",
      "- `Quality Assurance`",
      "Do not add any intro, recap, synthesis, or extra headings.",
    ].join("\n");

    expect(promptKeepsRequestedRoleOrderOnly(prompt)).toBe(true);
    expect(detectCoworkRoleOrder(prompt)).toEqual(["planner", "qa"]);
  });

  it("extracts bullet sections after leading blank lines and stops at non-bullet text", () => {
    const prompt = [
      "Output exactly these top-level sections in order:",
      "",
      "- `Members`",
      "- `Organizer`",
      "Use concise bullets.",
      "- `Risk Review`",
    ].join("\n");

    expect(extractExactCoworkSections(prompt)).toEqual(["Members", "Organizer"]);
  });

  it("skips leading prose before exact section bullets", () => {
    const prompt = [
      "Output exactly these top-level sections in order:",
      "Use only the labels below.",
      "- `Planner`",
      "- `QA`",
    ].join("\n");

    expect(extractExactCoworkSections(prompt)).toEqual(["Planner", "QA"]);
  });

  it("normalizes empty and quality-assurance labels without inventing unknown roles", () => {
    expect(normalizeCoworkRoleLabel("  `Quality Assurance`:  ")).toBe("qa");
    expect(normalizeCoworkRoleLabel("  `Goat`  ")).toBe("");
    expect(detectCoworkRoleOrder("Required role order: Unknown, Nobody")).toEqual([]);
  });

  it("extracts exact bullet counts and trims section bodies to requested bullets", () => {
    expect(extractRequestedCoworkSectionBulletCount("Each section must contain exactly 2 bullets.")).toBe(2);
    expect(extractRequestedCoworkSectionBulletCount("Each section can use bullets.")).toBeUndefined();

    expect(
      normalizeCoworkSectionBody(
        ["- Keep this first bullet.  ", "supporting prose", "* Keep this second bullet.", "- Drop this third bullet."],
        2,
      ),
    ).toBe("- Keep this first bullet.\n* Keep this second bullet.");
  });

  it("compacts verbose cowork bullets to the word limit before using aggressive clause trimming", () => {
    const response = [
      "Planner",
      "- **Scope:** This sentence keeps the useful decision. This sentence adds extra commentary.",
      "QA",
      "- **Check:** This sentence keeps validation clear. This sentence adds extra commentary.",
    ].join("\n");

    expect(compactCoworkOutputToWordLimit(response, 18)).toBe(
      [
        "Planner",
        "- Scope: This sentence keeps the useful decision.",
        "QA",
        "- Check: This sentence keeps validation clear.",
      ].join("\n"),
    );
  });

  it("returns undefined instead of fabricating role-only repairs when required inputs are missing", () => {
    expect(
      repairRequestedRoleOrderOnlyCoworkOutput({
        prompt: "Summarize the plan.",
        responseText: "Planner\n- Draft scope.",
        requiredRoles: [],
      }),
    ).toBeUndefined();

    expect(
      repairRequestedRoleOrderOnlyCoworkOutput({
        prompt: "Keep exactly these sections in order: `Planner`, `QA`",
        responseText: "Planner\n- Draft scope.",
        requiredRoles: ["planner", "qa"],
      }),
    ).toBeUndefined();

    expect(
      repairRequestedRoleOrderOnlyCoworkOutput({
        prompt: "Keep exactly these sections in order: `Planner`",
        responseText: "Planner\n\nQA\n- Validate.",
        requiredRoles: ["planner"],
      }),
    ).toBeUndefined();
  });
});
