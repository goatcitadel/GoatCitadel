import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString } from "@goatcitadel/contracts";
import {
  admitCompanionSignedDecision,
  COMPANION_SIGNED_APPROVALS_ENABLED,
  COMPANION_APPROVE_REFUSED_MESSAGE,
  COMPANION_RESOLUTION_NOTE_MAX_LENGTH,
  companionDecisionPayloadSha256,
  refuseCompanionReject,
  type CompanionSignedDecisionAdmissionInput,
} from "./companion-signed-approval.js";
import type { MobileApprovalSignatureVerification } from "./mobile-approval-key-service.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function admissionInput(
  overrides: Partial<CompanionSignedDecisionAdmissionInput> = {},
): CompanionSignedDecisionAdmissionInput {
  return {
    approvalId: "approval-1",
    decision: "approve",
    grantId: "grant-1",
    companionSessionId: "companion-1",
    signedDecision: {
      signedAt: "2026-11-02T12:00:00.000Z",
      nonce: "nonce-1",
      signature: "c2lnbmF0dXJl",
    },
    ...overrides,
  };
}

describe("companion signed approval admission", () => {
  it("ships switched off", () => {
    expect(COMPANION_SIGNED_APPROVALS_ENABLED).toBe(false);
  });

  it("hashes the empty string for approve and the canonical edited payload for edit", () => {
    expect(companionDecisionPayloadSha256("approve")).toBe(sha256(""));
    expect(companionDecisionPayloadSha256("edit", { b: 2, a: { d: 1, c: [1, 2] } })).toBe(
      sha256(canonicalJsonString({ a: { c: [1, 2], d: 1 }, b: 2 })),
    );
    expect(companionDecisionPayloadSha256("edit", undefined)).toBe(sha256(canonicalJsonString({})));
  });

  it("refuses with today's message while the switch is off, without verifying", async () => {
    const verify = vi.fn();
    const result = await admitCompanionSignedDecision(admissionInput(), { enabled: false, verify });
    expect(result).toEqual({ admitted: false, statusCode: 403, error: COMPANION_APPROVE_REFUSED_MESSAGE });
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses an approve with no signature, and a companion with no grant or session", async () => {
    const verify = vi.fn();
    const unsigned = await admitCompanionSignedDecision(admissionInput({ signedDecision: undefined }), {
      enabled: true,
      verify,
    });
    expect(unsigned).toMatchObject({ admitted: false, statusCode: 403 });
    expect(unsigned.admitted ? "" : unsigned.error).toBe(
      "Approving from the phone needs a decision signed by this phone's approval key.",
    );
    const noGrant = await admitCompanionSignedDecision(admissionInput({ grantId: undefined }), {
      enabled: true,
      verify,
    });
    expect(noGrant).toMatchObject({ admitted: false, statusCode: 403 });
    const noSession = await admitCompanionSignedDecision(admissionInput({ companionSessionId: "  " }), {
      enabled: true,
      verify,
    });
    expect(noSession).toMatchObject({ admitted: false, statusCode: 403 });
    expect(verify).not.toHaveBeenCalled();
  });

  it("verifies over the server-bound approval, decision, session and payload hash", async () => {
    const verify = vi.fn(
      async (): Promise<MobileApprovalSignatureVerification> => ({
        verified: true,
        keyId: "key-1",
        publicKeySha256: "a".repeat(64),
        revision: 1,
      }),
    );
    const result = await admitCompanionSignedDecision(
      admissionInput({ decision: "edit", editedPayload: { amount: 5 } }),
      { enabled: true, verify },
    );
    expect(result).toEqual({ admitted: true, keyId: "key-1" });
    expect(verify).toHaveBeenCalledWith({
      grantId: "grant-1",
      companionSessionId: "companion-1",
      approvalId: "approval-1",
      decision: "edit",
      decisionPayloadSha256: sha256(canonicalJsonString({ amount: 5 })),
      signedAt: "2026-11-02T12:00:00.000Z",
      nonce: "nonce-1",
      signature: "c2lnbmF0dXJl",
    });
  });

  it.each([
    ["no_active_key", 403, "This phone has no active approval key. Turn on phone approvals on the phone again."],
    ["grant_inactive", 403, "This phone's pairing is no longer active."],
    ["stale_timestamp", 403, "The phone's decision is too old or dated in the future. Try again on the phone."],
    ["malformed_request", 400, "The phone's signed decision could not be read."],
    ["signature_mismatch", 403, "The phone's signature does not match this approval and decision."],
  ] as const)("maps %s to a plain refusal", async (reason, statusCode, error) => {
    const verify = vi.fn(async (): Promise<MobileApprovalSignatureVerification> => ({ verified: false, reason }));
    const result = await admitCompanionSignedDecision(admissionInput(), { enabled: true, verify });
    expect(result).toEqual({ admitted: false, statusCode, error });
  });

  it("refuses an approve that carries an edited payload, and an edit without one, before verifying", async () => {
    const verify = vi.fn();
    const approveWithEdit = await admitCompanionSignedDecision(admissionInput({ editedPayload: { step: 9 } }), {
      enabled: true,
      verify,
    });
    expect(approveWithEdit).toEqual({
      admitted: false,
      statusCode: 400,
      error: "An approve from the phone can't change what is approved. Use edit for that.",
    });
    const editWithout = await admitCompanionSignedDecision(admissionInput({ decision: "edit" }), {
      enabled: true,
      verify,
    });
    expect(editWithout).toEqual({
      admitted: false,
      statusCode: 400,
      error: "An edit from the phone needs the edited details.",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("bounds a companion's resolution note and keeps a companion reject from changing the payload", () => {
    expect(refuseCompanionReject({})).toBeUndefined();
    expect(refuseCompanionReject({ resolutionNote: "n".repeat(COMPANION_RESOLUTION_NOTE_MAX_LENGTH) })).toBeUndefined();
    expect(refuseCompanionReject({ editedPayload: {} })).toEqual({
      statusCode: 400,
      error: "A reject from the phone can't change the request's details.",
    });
    expect(refuseCompanionReject({ resolutionNote: "n".repeat(COMPANION_RESOLUTION_NOTE_MAX_LENGTH + 1) })).toEqual({
      statusCode: 400,
      error: `A note from the phone can be at most ${COMPANION_RESOLUTION_NOTE_MAX_LENGTH} characters.`,
    });
  });

  it("fails closed when the verifier throws", async () => {
    const verify = vi.fn(async () => {
      throw new Error("storage down");
    });
    const result = await admitCompanionSignedDecision(admissionInput(), { enabled: true, verify });
    expect(result).toEqual({
      admitted: false,
      statusCode: 503,
      error: "The phone's signature could not be checked right now. Try again, or approve at the PC.",
    });
  });
});
