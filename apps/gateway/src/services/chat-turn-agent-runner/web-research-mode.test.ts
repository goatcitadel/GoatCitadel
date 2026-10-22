import { describe, expect, it } from "vitest";
import { resolveTurnWebLookupIntent } from "./web-research-mode.js";

describe("resolveTurnWebLookupIntent", () => {
  it("treats Deep mode as web lookup when nothing else claims the turn", () => {
    expect(
      resolveTurnWebLookupIntent({
        webMode: "deep",
        detectedWebLookupIntent: false,
        localFileIntent: false,
        workflowSkillCapture: false,
      }),
    ).toBe(true);
  });

  it("lets local-file intent win over Deep mode", () => {
    expect(
      resolveTurnWebLookupIntent({
        webMode: "deep",
        detectedWebLookupIntent: false,
        localFileIntent: true,
        workflowSkillCapture: false,
      }),
    ).toBe(false);
  });

  it("never turns on web lookup when web is off", () => {
    expect(
      resolveTurnWebLookupIntent({
        webMode: "off",
        detectedWebLookupIntent: true,
        localFileIntent: false,
        workflowSkillCapture: false,
      }),
    ).toBe(false);
  });

  it("keeps Auto mode on regex detection only", () => {
    const base = { webMode: "auto" as const, localFileIntent: false, workflowSkillCapture: false };
    expect(resolveTurnWebLookupIntent({ ...base, detectedWebLookupIntent: false })).toBe(false);
    expect(resolveTurnWebLookupIntent({ ...base, detectedWebLookupIntent: true })).toBe(true);
  });
});
