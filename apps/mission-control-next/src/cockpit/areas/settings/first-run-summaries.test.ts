import { describe, expect, it } from "vitest";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { firstRunModelSummary, firstRunSafetySummary } from "./first-run-summaries";

describe("firstRunModelSummary (ST-N06)", () => {
  it("names the model and then the provider by its saved name", () => {
    expect(firstRunModelSummary(onboardingFixture())).toBe("model-a · Provider A");
  });

  it("never shows the provider ID when the provider has no saved name", () => {
    const state = onboardingFixture();
    state.settings.llm.activeProviderId = "provider-unlisted-id";
    expect(firstRunModelSummary(state)).toBe("model-a");
  });

  it("says no model is confirmed without a provider or model", () => {
    const noModel = onboardingFixture();
    noModel.settings.llm.activeModel = "  ";
    expect(firstRunModelSummary(noModel)).toBe("No model confirmed");
    const noProvider = onboardingFixture();
    noProvider.settings.llm.activeProviderId = "";
    expect(firstRunModelSummary(noProvider)).toBe("No model confirmed");
  });
});

describe("firstRunSafetySummary", () => {
  it("describes the approval rule in words, not its token", () => {
    const summary = firstRunSafetySummary(onboardingFixture());
    expect(summary).toMatch(/^Tool approval: /u);
    expect(summary).not.toMatch(/approve_(all|risky)|bypass/u);
  });
});
