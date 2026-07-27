import { describe, expect, it } from "vitest";

import { humanizeEnumToken } from "./native-helpers";

describe("humanizeEnumToken", () => {
  it("returns an empty string for null, undefined, empty, and whitespace-only input", () => {
    expect(humanizeEnumToken(null)).toBe("");
    expect(humanizeEnumToken(undefined)).toBe("");
    expect(humanizeEnumToken("")).toBe("");
    expect(humanizeEnumToken("   ")).toBe("");
    expect(humanizeEnumToken("___")).toBe("");
  });

  it("humanizes snake_case and kebab-case machine tokens", () => {
    expect(humanizeEnumToken("not_started")).toBe("Not started");
    expect(humanizeEnumToken("provider-ready")).toBe("Provider ready");
    expect(humanizeEnumToken("hybrid_guarded")).toBe("Hybrid guarded");
    expect(humanizeEnumToken("approval_required")).toBe("Approval required");
  });

  it("collapses separator runs and trims edges", () => {
    expect(humanizeEnumToken("__not--_started__")).toBe("Not started");
    expect(humanizeEnumToken("external_local_url")).toBe("External local url");
  });

  it("leaves already-human values intact apart from the leading capital", () => {
    expect(humanizeEnumToken("balanced")).toBe("Balanced");
    expect(humanizeEnumToken("Already Human")).toBe("Already Human");
    expect(humanizeEnumToken("Not required")).toBe("Not required");
  });
});
