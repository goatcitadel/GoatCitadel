import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import {
  NotFoundError,
  ValidationError,
  redactSecretText,
  type MobileApprovalKeyListResponse,
  type MobileApprovalKeyRegistrationRequest,
  type MobileApprovalKeyRegistrationResponse,
  type MobileApprovalKeySummary,
} from "@goatcitadel/contracts";
import {
  deriveMobileApprovalKeyId,
  type AsyncStorage as Storage,
  type MobileApprovalKeyRecord,
} from "@goatcitadel/storage";

/**
 * Gateway-verifiable consumer approval-key owner (production-dark).
 *
 * Registers a device approval public key (Ed25519, released by device
 * authentication on the phone) durably bound to the companion grant, so
 * approval approve/edit can later be signature-verified server-side. The
 * `approval_key` capability stays `scaffolded` and
 * `verificationAvailability` stays "unavailable" until the mobile client
 * ships its side under the physical-device hold; nothing here changes the
 * operator-only approve/edit posture.
 */

export const MOBILE_APPROVAL_DECISION_CONTRACT_V1 = "goatcitadel.mobile-approval-decision.v1";
export const MOBILE_APPROVAL_DECISIONS = ["approve", "reject", "edit"] as const;
export type MobileApprovalDecision = (typeof MOBILE_APPROVAL_DECISIONS)[number];

const DEFAULT_DECISION_SIGNATURE_SKEW_MS = 5 * 60_000;
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_NONCE_LENGTH = 128;
const MAX_SIGNATURE_LENGTH = 512;

type MobileApprovalKeyStorage = Pick<Storage, "mobileApprovalKeys">;

export interface MobileApprovalKeyActorContext {
  grantId?: string;
  companionSessionId?: string;
}

export type MobileApprovalSignatureVerification =
  | { verified: true; keyId: string; publicKeySha256: string; revision: number }
  | {
      verified: false;
      reason: "no_active_key" | "grant_inactive" | "stale_timestamp" | "malformed_request" | "signature_mismatch";
    };

export class MobileApprovalKeyService {
  public constructor(
    private readonly deps: {
      storage: MobileApprovalKeyStorage;
      isGrantActive: (grantId: string) => Promise<boolean>;
      now?: () => Date;
    },
  ) {}

  public async register(
    input: MobileApprovalKeyRegistrationRequest,
    actor: MobileApprovalKeyActorContext,
  ): Promise<MobileApprovalKeyRegistrationResponse> {
    const grantId = requireGrantId(actor.grantId);
    if (!input.enabled) {
      const revoked = await this.deps.storage.mobileApprovalKeys.ensureRevoked({
        grantId,
        companionSessionId: actor.companionSessionId,
        now: this.nowIso(),
      });
      if (!revoked) {
        throw new NotFoundError({ entity: "mobile approval key", id: grantId });
      }
      return registrationResponse(revoked);
    }

    const material = normalizeEd25519PublicKey(input.publicKeyPem);
    const registration = await this.deps.storage.mobileApprovalKeys.upsertActiveKey({
      keyId: deriveMobileApprovalKeyId(grantId),
      grantId,
      publicKeyPem: material.publicKeyPem,
      publicKeySha256: material.publicKeySha256,
      keyProvenance: input.keyProvenance,
      companionSessionId: actor.companionSessionId,
      deviceLabel: input.deviceLabel ? redactSecretText(input.deviceLabel).value : undefined,
      now: this.nowIso(),
    });
    return registrationResponse(registration);
  }

  public async revokeGrant(grantIdInput: string | undefined): Promise<MobileApprovalKeyRecord[]> {
    const grantId = requireGrantId(grantIdInput);
    return await this.deps.storage.mobileApprovalKeys.revokeAllByGrant(grantId, this.nowIso());
  }

  public async listKeys(limit = 200): Promise<MobileApprovalKeyListResponse> {
    const records = await this.deps.storage.mobileApprovalKeys.list(limit);
    return { items: records.map(summarize) };
  }

  /**
   * Verifies an Ed25519 approval-decision signature against the grant's
   * registered active key. Fail-closed on every path: absent/revoked key,
   * inactive grant, stale timestamp, malformed inputs, and digest mismatch all
   * report `verified: false`. Nonce single-use/replay tombstones belong to the
   * approvals route wiring when the capability leaves `scaffolded`; this
   * helper owns key custody and cryptographic verification only.
   */
  public async verifyApprovalDecisionSignature(input: {
    grantId: string;
    companionSessionId: string;
    approvalId: string;
    decision: MobileApprovalDecision;
    /** sha256 hex of the canonical decision payload the user confirmed (edits/empty-string hash for none). */
    decisionPayloadSha256: string;
    signedAt: string;
    nonce: string;
    /** base64url Ed25519 signature over {@link buildMobileApprovalDecisionSigningPayload}. */
    signature: string;
    maxSkewMs?: number;
  }): Promise<MobileApprovalSignatureVerification> {
    if (!isWellFormedDecisionRequest(input)) {
      return { verified: false, reason: "malformed_request" };
    }
    const key = await this.deps.storage.mobileApprovalKeys.getActiveByGrant(input.grantId);
    if (!key) {
      return { verified: false, reason: "no_active_key" };
    }
    let grantActive: boolean;
    try {
      grantActive = await this.deps.isGrantActive(input.grantId);
    } catch {
      grantActive = false;
    }
    if (!grantActive) {
      return { verified: false, reason: "grant_inactive" };
    }
    const signedAtMs = Date.parse(input.signedAt);
    const skew = Math.max(1_000, Math.floor(input.maxSkewMs ?? DEFAULT_DECISION_SIGNATURE_SKEW_MS));
    if (!Number.isFinite(signedAtMs) || Math.abs(this.now().getTime() - signedAtMs) > skew) {
      return { verified: false, reason: "stale_timestamp" };
    }
    let publicKey: KeyObject;
    let signature: Buffer;
    try {
      publicKey = createPublicKey(key.publicKeyPem);
      signature = Buffer.from(input.signature, "base64url");
    } catch {
      return { verified: false, reason: "malformed_request" };
    }
    const payload = buildMobileApprovalDecisionSigningPayload(input);
    let matches: boolean;
    try {
      matches = verify(null, Buffer.from(payload, "utf8"), publicKey, signature);
    } catch {
      matches = false;
    }
    if (!matches) {
      return { verified: false, reason: "signature_mismatch" };
    }
    return { verified: true, keyId: key.keyId, publicKeySha256: key.publicKeySha256, revision: key.revision };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

/**
 * Canonical signing payload for a mobile approval decision. The mobile client
 * must sign exactly this byte sequence with the device-authentication-gated
 * approval key. Versioned so a future contract can move without ambiguity.
 */
export function buildMobileApprovalDecisionSigningPayload(input: {
  approvalId: string;
  decision: MobileApprovalDecision;
  decisionPayloadSha256: string;
  signedAt: string;
  companionSessionId: string;
  nonce: string;
}): string {
  return [
    MOBILE_APPROVAL_DECISION_CONTRACT_V1,
    `approvalId:${input.approvalId}`,
    `decision:${input.decision}`,
    `payloadSha256:${input.decisionPayloadSha256}`,
    `signedAt:${input.signedAt}`,
    `companionSessionId:${input.companionSessionId}`,
    `nonce:${input.nonce}`,
  ].join("\n");
}

/**
 * Validates the submitted PEM is a genuine Ed25519 SPKI public key and
 * canonicalizes it: the stored PEM and authoritative digest are recomputed
 * from the parsed key material, never from caller-formatted text.
 */
export function normalizeEd25519PublicKey(publicKeyPem: string): { publicKeyPem: string; publicKeySha256: string } {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new ValidationError({ message: "The mobile approval key must be a valid public key in PEM form." });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new ValidationError({ message: "The mobile approval key must be an Ed25519 public key." });
  }
  const der = key.export({ type: "spki", format: "der" });
  return {
    publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
    publicKeySha256: createHash("sha256").update(der).digest("hex"),
  };
}

function registrationResponse(record: MobileApprovalKeyRecord): MobileApprovalKeyRegistrationResponse {
  return {
    keyId: record.keyId,
    algorithm: record.algorithm,
    enabled: record.lifecycleState === "active",
    keyProvenance: record.keyProvenance,
    publicKeySha256: record.publicKeySha256,
    registeredAt: record.registeredAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    // Production-dark: registering a key alone never turns signature-gated
    // approval on. The flip requires the mobile client's device-auth release
    // proof and the capability decision that retires `scaffolded`.
    verificationAvailability: "unavailable",
  };
}

function summarize(record: MobileApprovalKeyRecord): MobileApprovalKeySummary {
  return {
    keyId: record.keyId,
    grantId: record.grantId,
    algorithm: record.algorithm,
    lifecycleState: record.lifecycleState,
    keyProvenance: record.keyProvenance,
    publicKeySha256: record.publicKeySha256,
    revision: record.revision,
    registeredAt: record.registeredAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
  };
}

function requireGrantId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_OPAQUE_ID_LENGTH) {
    throw new ValidationError({ message: "A durable companion grant is required for a mobile approval key." });
  }
  return normalized;
}

function isWellFormedDecisionRequest(input: {
  grantId: string;
  companionSessionId: string;
  approvalId: string;
  decision: MobileApprovalDecision;
  decisionPayloadSha256: string;
  signedAt: string;
  nonce: string;
  signature: string;
}): boolean {
  return (
    isOpaqueId(input.grantId) &&
    isOpaqueId(input.companionSessionId) &&
    isOpaqueId(input.approvalId) &&
    (MOBILE_APPROVAL_DECISIONS as readonly string[]).includes(input.decision) &&
    /^[0-9a-f]{64}$/u.test(input.decisionPayloadSha256) &&
    typeof input.signedAt === "string" &&
    input.signedAt.length <= 40 &&
    typeof input.nonce === "string" &&
    input.nonce.length >= 1 &&
    input.nonce.length <= MAX_NONCE_LENGTH &&
    !/\s/u.test(input.nonce) &&
    typeof input.signature === "string" &&
    input.signature.length >= 1 &&
    input.signature.length <= MAX_SIGNATURE_LENGTH
  );
}

function isOpaqueId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
}

/** Constant-time hex digest comparison for future route wiring. */
export function safeApprovalDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}
