import { describe, expect, it } from "vitest";
import { presentErrorText } from "./present-error";

describe("presentErrorText (WK-N03, IN-L02)", () => {
  it("summarises a connection failure without the address or stack", () => {
    const raw = "ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect (node:net:1555:16)";
    const presented = presentErrorText(raw);
    expect(presented.summary).not.toMatch(/127\.0\.0\.1|5432|TCPConnectWrap|node:net/u);
    expect(presented.detail).toBe(raw);
  });

  it("keeps a plain operator sentence as it is, with no detail", () => {
    expect(presentErrorText("The provider rejected the API key.")).toEqual({
      summary: "The provider rejected the API key.",
    });
  });

  it("hides technical text it can't word, keeping it as detail", () => {
    const raw = "TypeError: Cannot read properties of undefined (reading 'items') at C:\\goat\\dist\\run.js:12";
    const presented = presentErrorText(raw);
    // Neutral wording: technical details may be switched off, and the site may not be a "step".
    expect(presented.summary).toBe("The recorded error isn't in a readable form.");
    expect(presented.detail).toBe(raw);
  });

  it("keeps plain sentences that only look technical", () => {
    // A leading "Error:" or "ERROR" label is dropped; the sentence stays.
    expect(presentErrorText("Error: The provider rejected the API key.").summary).toBe(
      "The provider rejected the API key.",
    );
    expect(presentErrorText("ERROR quota exceeded for this month.").summary).toBe("Quota exceeded for this month.");
    for (const plain of [
      "Retry after 10:30 UTC.",
      "Budget EXCEEDED for today.",
      "Waiting at gate (approval).",
      "Exit code 1 [build].",
    ])
      expect(presentErrorText(plain).summary).toBe(plain);
  });

  it("never rewords a recorded error into a run-state message just because it mentions approval or input", () => {
    // The chat copy maps any "approval" text to "waiting for approval", which is wrong for a recorded failure.
    expect(presentErrorText("The approval effect failed: target file is locked.").summary).toBe(
      "The approval effect failed: target file is locked.",
    );
    expect(presentErrorText("Missing user input for field name.").summary).toBe("Missing user input for field name.");
  });

  it("keeps only the first line of a multi-line message", () => {
    expect(presentErrorText("Tool timed out.\nretry=3 elapsed=30012ms").summary).toBe("Tool timed out.");
  });

  it("says nothing was recorded for an empty error", () => {
    expect(presentErrorText(undefined)).toEqual({ summary: "No error details were recorded." });
    expect(presentErrorText("   ")).toEqual({ summary: "No error details were recorded." });
  });
});
