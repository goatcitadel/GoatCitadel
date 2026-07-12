import { describe, expect, it } from "vitest";
import { readToolDomainExecutionFailure } from "./tool-domain-result-truth.js";

describe("tool-domain-result-truth", () => {
  it("classifies a failed communications result even when the policy envelope executed", () => {
    expect(
      readToolDomainExecutionFailure(
        {
          status: "failed",
          deliveryStatus: "not_available",
          error: "Channel connection is disabled.",
          fallbackReason: "Channel connection is disabled.",
        },
        "allowed_via_approval:approval-1",
      ),
    ).toEqual({
      message: "Channel connection is disabled.",
      kind: "failed",
      manualReconciliationRequired: false,
    });
  });

  it("preserves unknown-after-send HTTP truth as manual reconciliation", () => {
    expect(
      readToolDomainExecutionFailure(
        {
          status: "failed",
          deliveryStatus: "manual_reconciliation_required",
          externalOutcome: "unknown_after_send",
          manualReconciliationRequired: true,
          error: "The remote outcome is unknown after dispatch.",
        },
        "execution outcome unknown",
      ),
    ).toEqual({
      message: "The remote outcome is unknown after dispatch.",
      kind: "manual_reconciliation",
      manualReconciliationRequired: true,
    });
  });

  it("does not misclassify successful domain results", () => {
    expect(
      readToolDomainExecutionFailure(
        { status: "sent", deliveryStatus: "sent", providerMessageId: "message-1" },
        "allowed",
      ),
    ).toBeUndefined();
    expect(readToolDomainExecutionFailure({ status: 204, ok: true }, "allowed")).toBeUndefined();
    expect(
      readToolDomainExecutionFailure(
        {
          fallbackUsed: true,
          fallbackReason: "Primary browser adapter unavailable.",
          results: [{ title: "Recovered result", url: "https://example.com" }],
        },
        "allowed",
      ),
    ).toBeUndefined();
  });

  it("keeps explicit failure truth authoritative over fallback success hints", () => {
    expect(
      readToolDomainExecutionFailure(
        { ok: false, fallbackUsed: true, fallbackReason: "Fallback also failed." },
        "allowed",
      ),
    ).toMatchObject({ kind: "failed", message: "Fallback also failed." });
  });
});
