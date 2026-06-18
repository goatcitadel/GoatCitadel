import { describe, it, expect } from "vitest";
import { filterPassageFields, isPassageActive, type CitadelPassage } from "./citadel-passages.js";

const BASE_PASSAGE: CitadelPassage = {
  passageId: "p-001",
  sourceCitadelId: "citadel-alpha",
  destinationCitadelId: "citadel-beta",
  allowedFields: ["name", "role"],
};

// ---------------------------------------------------------------------------
// filterPassageFields
// ---------------------------------------------------------------------------

describe("filterPassageFields", () => {
  it("returns only allowed fields that are present in data", () => {
    const data = { name: "Alice", role: "admin", secret: "s3cr3t" };
    const result = filterPassageFields(BASE_PASSAGE, data);
    expect(result).toEqual({ name: "Alice", role: "admin" });
  });

  it("drops disallowed keys", () => {
    const data = { name: "Bob", secret: "hidden", other: 42 };
    const result = filterPassageFields(BASE_PASSAGE, data);
    expect(result).not.toHaveProperty("secret");
    expect(result).not.toHaveProperty("other");
  });

  it("ignores allowed keys that are absent in data", () => {
    // 'role' is allowed but absent; only 'name' should appear
    const data = { name: "Carol" };
    const result = filterPassageFields(BASE_PASSAGE, data);
    expect(result).toEqual({ name: "Carol" });
    expect(result).not.toHaveProperty("role");
  });

  it("does not mutate the input data object", () => {
    const data: Record<string, unknown> = {
      name: "Dave",
      role: "viewer",
      secret: "private",
    };
    const snapshot = { ...data };
    filterPassageFields(BASE_PASSAGE, data);
    expect(data).toEqual(snapshot);
  });

  it("returns an empty object when no allowed fields are present in data", () => {
    const data = { unrelated: true };
    const result = filterPassageFields(BASE_PASSAGE, data);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// isPassageActive
// ---------------------------------------------------------------------------

describe("isPassageActive", () => {
  const NOW = "2026-06-16T12:00:00.000Z";

  it("returns true when there is no expiresAt (passage never expires)", () => {
    expect(isPassageActive(BASE_PASSAGE, NOW)).toBe(true);
  });

  it("returns false when expiresAt is before now", () => {
    const expired: CitadelPassage = {
      ...BASE_PASSAGE,
      expiresAt: "2026-06-16T11:00:00.000Z", // one hour before NOW
    };
    expect(isPassageActive(expired, NOW)).toBe(false);
  });

  it("returns false when expiresAt equals now (not strictly after)", () => {
    const exactlyNow: CitadelPassage = {
      ...BASE_PASSAGE,
      expiresAt: NOW,
    };
    expect(isPassageActive(exactlyNow, NOW)).toBe(false);
  });

  it("returns true when expiresAt is strictly after now", () => {
    const future: CitadelPassage = {
      ...BASE_PASSAGE,
      expiresAt: "2026-06-16T13:00:00.000Z", // one hour after NOW
    };
    expect(isPassageActive(future, NOW)).toBe(true);
  });
});
