import { describe, expect, it } from "vitest";
import { presentChamberSensitivity, presentMasonAnswerKey, presentMasonAnswerValue } from "./citadel-vocabulary";

describe("presentMasonAnswerKey (ST-N07)", () => {
  it("labels each known Mason answer key", () => {
    expect(presentMasonAnswerKey("successDefinition")).toBe("What success looks like");
    expect(presentMasonAnswerKey("sensitiveAreas")).toBe("Sensitive areas");
    expect(presentMasonAnswerKey("preferLocalForSensitive")).toBe("Prefer local AI for sensitive work");
    expect(presentMasonAnswerKey("riskPosture")).toBe("Risk setting");
  });

  it("sentence-cases an unknown key instead of showing it raw", () => {
    expect(presentMasonAnswerKey("reviewCadenceDays")).toBe("Review cadence days");
    expect(presentMasonAnswerKey("data_retention")).toBe("Data retention");
    expect(presentMasonAnswerKey("toString")).toBe("To string");
    expect(presentMasonAnswerKey("")).toBe("Answer");
  });
});

describe("presentMasonAnswerValue", () => {
  it("presents kinds, risk settings, lists and booleans in plain words", () => {
    expect(presentMasonAnswerValue("kind", "team")).toBe("Team");
    expect(presentMasonAnswerValue("riskPosture", "automation_forward")).toBe("Automation-forward");
    // A value the table does not know yet stays readable instead of collapsing to "Unknown".
    expect(presentMasonAnswerValue("riskPosture", "not_a_posture")).toBe("Not a posture");
    expect(presentMasonAnswerValue("kind", "nonprofitGroup")).toBe("Nonprofit group");
    expect(presentMasonAnswerValue("kind", "")).toBe("Unknown");
    expect(presentMasonAnswerValue("riskPosture", undefined)).toBe("Unknown");
    expect(presentMasonAnswerValue("goals", ["Ship", " ", "Learn"])).toBe("Ship; Learn");
    expect(presentMasonAnswerValue("goals", [])).toBe("None specified");
    expect(presentMasonAnswerValue("preferLocalForSensitive", true)).toBe("Yes");
    expect(presentMasonAnswerValue("purpose", "Run the team")).toBe("Run the team");
  });
});

describe("citadel enum presenters", () => {
  it("sentence-cases a value the table does not know and reads Unknown only when it is missing", () => {
    expect(presentChamberSensitivity("secret")).toBe("Secret");
    expect(presentChamberSensitivity("top_secret")).toBe("Top secret");
    expect(presentChamberSensitivity("  ")).toBe("Unknown");
    expect(presentChamberSensitivity(null)).toBe("Unknown");
  });
});
