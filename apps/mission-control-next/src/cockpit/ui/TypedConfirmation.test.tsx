import { expect, it } from "vitest";
import { typedConfirmationMatches } from "./TypedConfirmation";

it("matches the phrase ignoring case, outer spaces and repeated inner spaces (DESIGN: case- and space-insensitive)", () => {
  expect(typedConfirmationMatches("Reject All", "reject all")).toBe(true);
  expect(typedConfirmationMatches("  reject all  ", "reject all")).toBe(true);
  expect(typedConfirmationMatches("reject  all", "reject all")).toBe(true);
  expect(typedConfirmationMatches("reject\tall", "reject all")).toBe(true);
});

it("still rejects a different phrase", () => {
  expect(typedConfirmationMatches("reject al", "reject all")).toBe(false);
  expect(typedConfirmationMatches("rejectall", "reject all")).toBe(false);
});
