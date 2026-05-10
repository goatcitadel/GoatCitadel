import { describe, expect, it } from "vitest";
import { hasLiveDataKeywords } from "./live-data-detect.js";

describe("live data detection", () => {
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
});
