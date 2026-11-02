/**
 * Admission for a paired phone's approve or edit: accepted only with an Ed25519 signature from the grant's active
 * approval key over the `goatcitadel.mobile-approval-decision.v1` contract
 * (`buildMobileApprovalDecisionSigningPayload` in mobile-approval-key-service.ts). The Gateway binds the approval id, decision, grant and
 * companion session itself; the request supplies only the signature, its time and its nonce.
 *
 * Single use: the signed message names one approval and one decision, and an approval leaves `pending` exactly once
 * (the approvals repository's compare-and-swap), so a nonce is accepted at most once, durably. The route refuses a
 * replay because the approval is no longer waiting.
 */

import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { z } from "zod";
import type { MobileApprovalDecision, MobileApprovalSignatureVerification } from "./mobile-approval-key-service.js";

/**
 * The switch for signed phone approvals. Off in shipped builds ("production-dark", like the approval key service)
 * until the phone app's matching release passes its device-authentication proof; only tests build the mobile route
 * port with it on. Turning it on is a separate, small change.
 */
export const COMPANION_SIGNED_APPROVALS_ENABLED = false;

/** Today's refusal, kept word for word while the switch is off. */
export const COMPANION_APPROVE_REFUSED_MESSAGE =
  "Paired companions may review or reject approvals, but approval and edit require operator authority until a server-verifiable device approval key is registered.";

export const companionSignedDecisionSchema = z.object({
  signedAt: z.string().min(1).max(40),
  nonce: z.string().min(1).max(128),
  signature: z.string().min(1).max(512),
});

export type CompanionSignedDecision = z.infer<typeof companionSignedDecisionSchema>;

export interface CompanionSignedDecisionAdmissionInput {
  approvalId: string;
  decision: Exclude<MobileApprovalDecision, "reject">;
  editedPayload?: Record<string, unknown>;
  grantId?: string;
  companionSessionId?: string;
  signedDecision?: CompanionSignedDecision;
}

export type CompanionSignedDecisionVerifier = (input: {
  grantId: string;
  companionSessionId: string;
  approvalId: string;
  decision: MobileApprovalDecision;
  decisionPayloadSha256: string;
  signedAt: string;
  nonce: string;
  signature: string;
}) => Promise<MobileApprovalSignatureVerification>;

export type CompanionSignedDecisionAdmission =
  | { admitted: true; keyId: string }
  | { admitted: false; statusCode: 400 | 403 | 503; error: string };

const REFUSALS: Record<
  Extract<MobileApprovalSignatureVerification, { verified: false }>["reason"],
  { statusCode: 400 | 403; error: string }
> = {
  no_active_key: {
    statusCode: 403,
    error: "This phone has no active approval key. Turn on phone approvals on the phone again.",
  },
  grant_inactive: { statusCode: 403, error: "This phone's pairing is no longer active." },
  stale_timestamp: {
    statusCode: 403,
    error: "The phone's decision is too old or dated in the future. Try again on the phone.",
  },
  malformed_request: { statusCode: 400, error: "The phone's signed decision could not be read." },
  signature_mismatch: { statusCode: 403, error: "The phone's signature does not match this approval and decision." },
};

/** The longest resolution note a paired phone may send with its decision. */
export const COMPANION_RESOLUTION_NOTE_MAX_LENGTH = 500;

/** Checks every companion decision shares: no oversized note. A reject also never changes the request's payload. */
export function refuseCompanionReject(input: {
  editedPayload?: Record<string, unknown>;
  resolutionNote?: string;
}): { statusCode: 400; error: string } | undefined {
  if (input.editedPayload !== undefined) {
    return { statusCode: 400, error: "A reject from the phone can't change the request's details." };
  }
  return refuseCompanionNote(input.resolutionNote);
}

/** A companion's note is unsigned, so it stays short. */
export function refuseCompanionNote(
  resolutionNote: string | undefined,
): { statusCode: 400; error: string } | undefined {
  if (resolutionNote !== undefined && resolutionNote.length > COMPANION_RESOLUTION_NOTE_MAX_LENGTH) {
    return {
      statusCode: 400,
      error: `A note from the phone can be at most ${COMPANION_RESOLUTION_NOTE_MAX_LENGTH} characters.`,
    };
  }
  return undefined;
}

/** sha256 hex of what the operator confirmed: the empty string for approve, the canonical edited payload for edit. */
export function companionDecisionPayloadSha256(
  decision: Exclude<MobileApprovalDecision, "reject">,
  editedPayload?: Record<string, unknown>,
): string {
  const confirmed = decision === "edit" ? canonicalJsonString(editedPayload ?? {}) : "";
  return createHash("sha256").update(confirmed, "utf8").digest("hex");
}

/** Every path that is not a verified signature from the grant's active key refuses. */
export async function admitCompanionSignedDecision(
  input: CompanionSignedDecisionAdmissionInput,
  options: { enabled: boolean; verify: CompanionSignedDecisionVerifier },
): Promise<CompanionSignedDecisionAdmission> {
  if (!options.enabled) {
    return { admitted: false, statusCode: 403, error: COMPANION_APPROVE_REFUSED_MESSAGE };
  }
  // The approvals repository stores `editedPayload` for any decision, and an approve signs the empty string: an
  // approve must carry none, and an edit must carry the payload it signed.
  if (input.decision === "approve" && input.editedPayload !== undefined) {
    return {
      admitted: false,
      statusCode: 400,
      error: "An approve from the phone can't change what is approved. Use edit for that.",
    };
  }
  if (input.decision === "edit" && input.editedPayload === undefined) {
    return { admitted: false, statusCode: 400, error: "An edit from the phone needs the edited details." };
  }
  const grantId = input.grantId?.trim();
  const companionSessionId = input.companionSessionId?.trim();
  if (!grantId || !companionSessionId) {
    return { admitted: false, statusCode: 403, error: "Approving from the phone needs a paired phone session." };
  }
  const signed = input.signedDecision;
  if (!signed) {
    return {
      admitted: false,
      statusCode: 403,
      error: "Approving from the phone needs a decision signed by this phone's approval key.",
    };
  }
  let verification: MobileApprovalSignatureVerification;
  try {
    verification = await options.verify({
      grantId,
      companionSessionId,
      approvalId: input.approvalId,
      decision: input.decision,
      decisionPayloadSha256: companionDecisionPayloadSha256(input.decision, input.editedPayload),
      signedAt: signed.signedAt,
      nonce: signed.nonce,
      signature: signed.signature,
    });
  } catch (error) {
    // eslint-disable-next-line no-console -- bounded diagnostic; the decision is refused.
    console.warn("[goatcitadel] phone approval signature check failed", {
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    return {
      admitted: false,
      statusCode: 503,
      error: "The phone's signature could not be checked right now. Try again, or approve at the PC.",
    };
  }
  if (!verification.verified) {
    return { admitted: false, ...REFUSALS[verification.reason] };
  }
  return { admitted: true, keyId: verification.keyId };
}
