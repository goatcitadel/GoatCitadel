import { describe, expect, it } from "vitest";
import { recordedCostLabel } from "./recorded-cost";

describe("recorded turn cost", () => {
  it("does not turn an unqualified zero into an exact price", () => {
    expect(recordedCostLabel(0, undefined)).toBe("Unknown");
    expect(recordedCostLabel(0, "unknown")).toBe("Unknown");
  });

  it("distinguishes reported, estimated, and incomplete cost", () => {
    expect(recordedCostLabel(0, "provider_reported")).toBe("$0.00");
    expect(recordedCostLabel(0.25, "estimated")).toBe("About $0.25");
    expect(recordedCostLabel(0.25, undefined)).toBe("$0.25+");
  });
});
