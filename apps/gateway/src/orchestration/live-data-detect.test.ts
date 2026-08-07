import { describe, expect, it } from "vitest";
import {
  extractExternalResearchSubject,
  hasExternalResearchIntent,
  hasLiveDataIntent,
  hasLiveDataKeywords,
  hasResearchListIntent,
} from "./live-data-detect.js";

describe("live data detection", () => {
  const marketResearchDeckRequest =
    "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";

  it("treats explicit browser tool instructions as web lookup intent", () => {
    expect(hasLiveDataKeywords("Use browser.search to verify the latest package versions.")).toBe(true);
    expect(hasLiveDataKeywords("Open the release page with browser.navigate and compare it.")).toBe(true);
  });

  it("does not treat code-like price identifiers as live-data intent", () => {
    expect(hasLiveDataKeywords("Design test cases for calculateDiscount(price, customerTier, couponCode).")).toBe(
      false,
    );
    expect(hasLiveDataKeywords("Implement validatePrice(price: number) and handle negative values.")).toBe(false);
  });

  it("still detects real price lookups that need current data", () => {
    expect(hasLiveDataKeywords("What's the current price of bitcoin?")).toBe(true);
    expect(hasLiveDataKeywords("Compare the latest price of ETH and BTC.")).toBe(true);
  });

  it("does not treat recently changed repo context as live-data intent", () => {
    expect(hasLiveDataKeywords("One config file was recently changed and tests failed.")).toBe(false);
    expect(hasLiveDataKeywords("Plan tests for recently added repo functionality.")).toBe(false);
  });

  it("still requires stronger currentness context for recency phrasing", () => {
    expect(hasLiveDataKeywords("What are the latest news headlines today?")).toBe(true);
    expect(hasLiveDataKeywords("What are the Latest weather alerts?")).toBe(true);
    expect(hasLiveDataKeywords("Show me recently released games this month.")).toBe(true);
  });

  it("does not treat non-web uncertainty phrasing with right now as live-data intent", () => {
    expect(
      hasLiveDataKeywords(
        "Without assuming tool access, explain what to do when two docs appear to conflict and you cannot verify which one is authoritative right now.",
      ),
    ).toBe(false);
  });

  it("detects local multi-entity lookup requests as live research", () => {
    const request =
      "Find boardgame and tabletop game stores within 10 miles of 91303 and list store, address, hours, and email address.";
    expect(hasResearchListIntent(request)).toBe(true);
    expect(hasLiveDataKeywords(request)).toBe(true);
  });

  it("detects delegated Cowork prompts from parent and current-step objectives", () => {
    expect(
      hasLiveDataIntent(
        [
          "Delegated role: Reviewer",
          "Parent objective: Find boardgame stores within 10 miles of 91303 with address, hours, and email.",
          "Current step objective: Verify missing hours and official contact details.",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("detects explicit external research actions without treating passive research references as web intent", () => {
    expect(
      hasExternalResearchIntent(
        "Please do some research on funny jokes and put together a PowerPoint presentation on it.",
      ),
    ).toBe(true);
    expect(hasExternalResearchIntent("Conduct research into PostgreSQL checkpoint behavior.")).toBe(true);
    expect(hasExternalResearchIntent("Conduct market research into CCG competitors.")).toBe(true);
    expect(hasExternalResearchIntent(marketResearchDeckRequest)).toBe(true);
    expect(hasExternalResearchIntent("Please research whether the claim is supported by reliable sources.")).toBe(true);

    expect(hasExternalResearchIntent("Summarize my research notes into a presentation.")).toBe(false);
    expect(hasExternalResearchIntent("Summarize my market research notes into a presentation.")).toBe(false);
    expect(hasExternalResearchIntent("The research section is already included below.")).toBe(false);
    expect(hasExternalResearchIntent("Rewrite this market research paragraph.")).toBe(false);
    expect(hasExternalResearchIntent("I already did some market research on CCGs; turn those notes into a deck.")).toBe(
      false,
    );
    expect(hasExternalResearchIntent("Rewrite this paragraph about research methods.")).toBe(false);
  });

  it("keeps presentation delivery wording out of the research subject", () => {
    expect(
      extractExternalResearchSubject("i want you to research the funniest jokes and then present them in a powerpoint"),
    ).toBe("the funniest jokes");
    expect(extractExternalResearchSubject("Research the launch results, then present them as a slide deck.")).toBe(
      "the launch results",
    );
    expect(extractExternalResearchSubject(marketResearchDeckRequest)).toBe(
      "CCGs and what makes each one unique and better than the competition",
    );
  });
});
