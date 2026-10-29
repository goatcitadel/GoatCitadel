import { describe, expect, it } from "vitest";
import { redactStructuredSecrets } from "@goatcitadel/contracts";
import { integrationPublicConfigMatches } from "./integration-editor-receipts";

/** The canonical structured redactor the Gateway's public projection starts from. */
function project<T>(value: T): T {
  return redactStructuredSecrets(value, { redactEnvAssignmentsAsWhole: true }).value;
}

describe("integrationPublicConfigMatches", () => {
  it("accepts a whole-value redaction, whatever was submitted", () => {
    expect(integrationPublicConfigMatches("abc.def-ghi.jkl1234567890", "[REDACTED]")).toBe(true);
    expect(integrationPublicConfigMatches("", "[REDACTED]")).toBe(true);
  });

  it("accepts a URL whose credential query value the projection withholds", () => {
    const submitted = {
      serverUrl: "https://chat.example.com/?token=abc",
      baseUrl: "https://chat.example.com/api?token=abc&team=ops",
    };
    const saved = project(submitted);
    expect(saved.serverUrl).toBe("https://chat.example.com/?token=[REDACTED]");
    expect(saved.baseUrl).toBe("https://chat.example.com/api?token=[REDACTED]&team=ops");
    expect(integrationPublicConfigMatches(submitted, saved)).toBe(true);
  });

  it("accepts withheld webhook path segments, one marker per withheld run", () => {
    // The Gateway's credential-URL projection (apps/gateway/src/services/public-secret-projection.ts) withholds the
    // segments after a /webhook/ label; the contracts redactor leaves this path alone, so the reply is written out.
    expect(
      integrationPublicConfigMatches(
        "https://chat.example.com/webhook/abc123/def456",
        "https://chat.example.com/webhook/[REDACTED]/[REDACTED]",
      ),
    ).toBe(true);
    expect(
      integrationPublicConfigMatches("https://chat.example.com/?token=", "https://chat.example.com/?token=[REDACTED]"),
    ).toBe(true);
  });

  it("rejects a partly withheld reply whose echoed parts differ from the submitted value", () => {
    const submitted = "https://chat.example.com/?token=abc&team=ops";
    expect(integrationPublicConfigMatches(submitted, "https://chat.other.example/?token=[REDACTED]&team=ops")).toBe(
      false,
    );
    expect(integrationPublicConfigMatches(submitted, "https://chat.example.com/?token=[REDACTED]&team=dev")).toBe(
      false,
    );
    expect(
      integrationPublicConfigMatches(
        "https://chat.example.com/?token=abc",
        "https://chat.example.com/?token=[REDACTED]&team=ops",
      ),
    ).toBe(false);
    expect(
      integrationPublicConfigMatches(
        "https://chat.example.com/webhook/abc123",
        "https://chat.example.com/webhook/[REDACTED]/[REDACTED]",
      ),
    ).toBe(false);
  });

  it("never lets the echoed prefix and suffix overlap, or reorder the echoed parts", () => {
    expect(integrationPublicConfigMatches("ab", "ab[REDACTED]b")).toBe(false);
    expect(integrationPublicConfigMatches("abc", "a[REDACTED]x[REDACTED]c")).toBe(false);
    expect(integrationPublicConfigMatches("a-y-x-c", "a[REDACTED]x[REDACTED]y[REDACTED]c")).toBe(false);
    expect(integrationPublicConfigMatches("a-x-y-c", "a[REDACTED]x[REDACTED]y[REDACTED]c")).toBe(true);
  });

  it("keeps a partial marker from acknowledging a value that was not a string", () => {
    expect(integrationPublicConfigMatches(42, "4[REDACTED]")).toBe(false);
    expect(integrationPublicConfigMatches({ url: "x" }, "x[REDACTED]")).toBe(false);
  });
});
