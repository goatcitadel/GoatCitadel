import { describe, expect, it } from "vitest";

import { DEFAULT_SCORE_DRAFT } from "./prompt-lab-types";

describe("prompt lab types runtime defaults", () => {
  it("keeps the score draft empty until the operator scores a run", () => {
    expect(DEFAULT_SCORE_DRAFT).toEqual({
      taskSuccess: null,
      honesty: null,
      executionQuality: null,
      robustness: null,
      usability: null,
      overrideVerdict: "",
      notes: "",
    });
  });
});
