import { expect, it } from "vitest";
import { resolveFollowThroughLocalTime } from "./follow-through-timing";
it("rejects nonexistent spring time and exposes both autumn occurrences instead of guessing", () => {
  expect(resolveFollowThroughLocalTime("2027-03-14T02:30", "America/Los_Angeles")).toEqual([]);
  expect(resolveFollowThroughLocalTime("2027-11-07T01:30", "America/Los_Angeles")).toEqual([
    "2027-11-07T08:30:00.000Z",
    "2027-11-07T09:30:00.000Z",
  ]);
});
it("resolves selected zones and rejects normalized invalid dates", () => {
  expect(resolveFollowThroughLocalTime("2027-02-01T17:45", "Asia/Kathmandu")).toEqual(["2027-02-01T12:00:00.000Z"]);
  expect(() => resolveFollowThroughLocalTime("2027-02-30T10:00", "UTC")).toThrow();
  expect(() => resolveFollowThroughLocalTime("2027-02-01T10:00", "Unknown/Zone")).toThrow();
});
