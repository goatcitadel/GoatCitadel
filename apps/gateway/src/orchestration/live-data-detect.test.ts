import { describe, expect, it } from "vitest";
import { hasLiveDataKeywords } from "./live-data-detect.js";

describe("live data detection", () => {
  it("treats explicit browser tool instructions as web lookup intent", () => {
    expect(hasLiveDataKeywords("Use browser.search to verify the latest package versions.")).toBe(true);
    expect(hasLiveDataKeywords("Open the release page with browser.navigate and compare it.")).toBe(true);
  });
});
