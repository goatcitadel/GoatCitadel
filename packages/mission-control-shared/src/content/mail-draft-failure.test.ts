import { describe, expect, it } from "vitest";
import { MAIL_DRAFT_FAILURE_REASONS } from "@goatcitadel/contracts";
import { describeMailDraftFailure } from "./mail-draft-failure.js";

describe("describeMailDraftFailure", () => {
  it("maps every known Gateway reason to operator copy without a raw detail", () => {
    for (const reason of Object.values(MAIL_DRAFT_FAILURE_REASONS)) {
      const copy = describeMailDraftFailure(reason);
      expect(copy.technicalDetail).toBeUndefined();
      expect(copy.summary).not.toBe(reason);
      expect(copy.summary.length).toBeGreaterThan(0);
    }
  });

  it("keeps provider text out of the summary and returns it as technical detail", () => {
    const raw = "Mail send failed: 535 5.7.8 Username and Password not accepted. host=smtp.example.test";
    const copy = describeMailDraftFailure(raw);
    expect(copy.summary).toBe("The mail provider refused the message. Nothing was sent.");
    expect(copy.summary).not.toContain("535");
    expect(copy.technicalDetail).toBe(raw);
  });

  it("recognizes each detail-carrying reason prefix", () => {
    expect(describeMailDraftFailure("Mail send was not executed: blocked by policy").summary).toMatch(/Policy/u);
    expect(
      describeMailDraftFailure("The send approval request failed (db timeout); nothing was sent.").summary,
    ).toMatch(/could not be requested/u);
    expect(describeMailDraftFailure("This mail account (manual) cannot send; connect Gmail.").summary).toMatch(
      /cannot send mail/u,
    );
  });

  it("treats an unrecognized reason as raw detail and bounds it", () => {
    const raw = `ECONNRESET ${"x".repeat(2000)}`;
    const copy = describeMailDraftFailure(raw);
    expect(copy.summary).toBe("Nothing was sent. The Gateway recorded a reason this view does not recognize.");
    expect(copy.technicalDetail?.length).toBeLessThanOrEqual(601);
    expect(copy.technicalDetail?.startsWith("ECONNRESET")).toBe(true);
  });

  it("says so when no reason was recorded", () => {
    expect(describeMailDraftFailure(undefined)).toEqual({
      summary: "Nothing was sent. The Gateway did not record a reason.",
    });
    expect(describeMailDraftFailure("  ").technicalDetail).toBeUndefined();
  });
});
