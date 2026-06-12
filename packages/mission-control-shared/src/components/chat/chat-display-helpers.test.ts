import { describe, expect, it } from "vitest";
import { humanizeEnum, toTitleCase } from "./chat-display-helpers";

describe("humanizeEnum", () => {
  it("maps known system enums to friendly phrasing", () => {
    expect(humanizeEnum("error_fallback")).toBe("auto-failover");
    expect(humanizeEnum("template_fallback")).toBe("template default");
    expect(humanizeEnum("waiting_for_approval")).toBe("waiting for approval");
    expect(humanizeEnum("live")).toBe("live");
  });

  it("title-cases unmapped bare snake_case identifiers so raw enum text does not leak", () => {
    expect(humanizeEnum("some_new_state")).toBe("Some New State");
    expect(humanizeEnum("fallback")).toBe("Fallback");
  });

  it("leaves already human-readable phrases untouched", () => {
    expect(humanizeEnum("primary rate-limited")).toBe("primary rate-limited");
  });

  it("returns an empty string for nullish or blank input", () => {
    expect(humanizeEnum(undefined)).toBe("");
    expect(humanizeEnum(null)).toBe("");
    expect(humanizeEnum("   ")).toBe("");
  });

  it("keeps toTitleCase available for callers that always want title case", () => {
    expect(toTitleCase("error_fallback")).toBe("Error Fallback");
  });
});
