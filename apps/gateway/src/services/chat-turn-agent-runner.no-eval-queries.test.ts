import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNER_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chat-turn-agent-runner.ts"), "utf8");

describe("chat turn agent runner has no eval-prompt-specific rewrites", () => {
  it.each([
    "Seattle this weekend",
    "city of your choice",
    "named public place of your choice",
    "IRS current standard mileage rate",
    "robot vacuum pet hair",
    "shouldProactivelyOpenCoworkResearchResult",
    "derivePromptSpecificWebQuery",
    "travelportland.com",
    "hoytarboretum.org",
    "ready.gov/kit",
    "nyc.gov/site/dsny",
    "weather.gov/sew",
    "AirNow parks outdoor activity",
    "choose Seattle",
    "buildTopicalCoworkWebEvidenceFallback",
    "buildOutdoorActivityCoworkFallback",
    "buildEverydayCoworkContractFallback",
  ])("does not contain %s", (needle) => {
    expect(RUNNER_SOURCE.includes(needle), `runner source still contains "${needle}"`).toBe(false);
  });

  it("keeps hard-coded third-party URLs out of the Chat runner", () => {
    expect(RUNNER_SOURCE).not.toMatch(/https?:\/\//);
  });
});
