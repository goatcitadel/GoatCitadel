import { describe, expect, it } from "vitest";
import { journeyActionLabel } from "./library-vocabulary";

describe("journeyActionLabel", () => {
  it("reads a failed skill cleanup as a sentence, never as its action name", () => {
    expect(journeyActionLabel("remove_cleanup_failed")).toBe("A removed skill's folder couldn't be deleted");
    expect(journeyActionLabel("activate_cleanup_failed")).toBe(
      "A skill's temporary install folder couldn't be deleted",
    );
  });

  it("keeps plain words for any other action", () => {
    expect(journeyActionLabel("remove")).not.toMatch(/_/u);
    expect(journeyActionLabel("")).toBe("Journey event");
  });
});
