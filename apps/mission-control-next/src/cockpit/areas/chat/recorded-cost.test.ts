import { describe, expect, it } from "vitest";
import { recordedCostLabel, subscriptionCostLabel } from "./recorded-cost";

describe("recorded turn cost", () => {
  it("does not turn an unqualified zero into an exact price", () => {
    expect(recordedCostLabel(0, undefined)).toBe("Unknown");
    expect(recordedCostLabel(0, "unknown")).toBe("Unknown");
  });

  it("distinguishes reported, estimated, and incomplete cost", () => {
    expect(recordedCostLabel(0, "provider_reported")).toBe("$0.00");
    expect(recordedCostLabel(0.25, "estimated")).toBe("About $0.25");
    expect(recordedCostLabel(0.25, undefined)).toBe("at least $0.25");
  });
});

describe("subscription-billed cost (#499)", () => {
  it("names the subscription a sign-in mode bills against", () => {
    expect(subscriptionCostLabel("claude-code-cli-login")).toBe("Included in Claude subscription");
    expect(subscriptionCostLabel("claude-code-oauth")).toBe("Included in Claude subscription");
    expect(subscriptionCostLabel("codex-oauth")).toBe("Included in ChatGPT subscription");
    expect(subscriptionCostLabel("api-key")).toBeUndefined();
    expect(subscriptionCostLabel(undefined)).toBeUndefined();
  });

  it("replaces only an unknown cost; a recorded amount still reads as recorded", () => {
    const included = "Included in Claude subscription";
    expect(recordedCostLabel(undefined, undefined, included)).toBe(included);
    expect(recordedCostLabel(0, undefined, included)).toBe(included);
    expect(recordedCostLabel(0.25, "estimated", included)).toBe("About $0.25");
  });
});
