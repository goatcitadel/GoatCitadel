import { createHash, createPrivateKey, randomBytes as nodeRandomBytes, sign as nodeSign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionControlAuthorize } from "@goatcitadel/mission-control-shared/api/session-control";
import { buildCompanionSigningPayload } from "./companion-auth-helpers.js";

/**
 * HX-411 governed CLI runtime helpers. These own the security-sensitive local
 * pieces the thin command layer composes: local control-secret generation and
 * hashing, the secure at-rest secret store, and the companion signer that turns
 * the injected device credential into signed-mutation headers by reusing the
 * exact `buildCompanionSigningPayload` the Gateway verifies against.
 *
 * The plaintext control secret only ever exists here in-process and in the
 * 0600 store file. It is never returned to the command layer for printing, never
 * placed on argv, and only ever leaves through the shared client's frozen token
 * header — never a log line, a URL, or a request body (only its SHA-256 does).
 */

/** The outer companion device identity the CLI signs with (never the control secret). */
export interface CompanionControlCredential {
  /** Purpose-bound `session_control_client` companion access token (bearer). */
  readonly accessToken: string;
  /** Companion session Ed25519 signing private key, PEM (PKCS8). */
  readonly signingPrivateKeyPem: string;
  /** Companion session id, informational; the Gateway derives authority from the bearer. */
  readonly companionSessionId?: string;
}

/** Identifies one stored control secret: a session controlled by one client instance. */
export interface SessionControlSecretRef {
  readonly sessionId: string;
  readonly clientInstanceId: string;
}

/**
 * Persists the plaintext control secret between discrete CLI invocations so
 * heartbeat/reconnect/release can present it without it ever appearing on argv.
 * Injected so tests use an in-memory fake and can prove no leak deterministically.
 */
export interface SessionControlSecretStore {
  save(ref: SessionControlSecretRef, secret: string): void;
  load(ref: SessionControlSecretRef): string | undefined;
  clear(ref: SessionControlSecretRef): void;
}

export interface SessionControlCliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Generate a 256-bit control secret locally as lowercase hex. */
export function generateControlSecret(randomBytes: (size: number) => Buffer = nodeRandomBytes): string {
  return randomBytes(32).toString("hex");
}

/** The lowercase SHA-256 of the plaintext control secret — the only form sent to the Gateway. */
export function hashControlSecretSha256(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The public last-eight-character token fingerprint. Derived from the HASH (not
 * the secret) so it matches the fingerprint the Gateway shows in content-free
 * projections, letting the operator correlate a request without any secret.
 */
export function controlTokenFingerprint(tokenHashSha256: string): string {
  return tokenHashSha256.slice(-8);
}

/** Build a mutation idempotency key from injected randomness (identifier-safe). */
export function createIdempotencyKey(label: string, randomBytes: (size: number) => Buffer = nodeRandomBytes): string {
  return `sc.${label}.${randomBytes(9).toString("hex")}`;
}

/**
 * Build the injected authorizer for the shared client. It always attaches the
 * companion bearer; for signed mutations it adds timestamp/nonce/signature by
 * signing the canonical `buildCompanionSigningPayload` string with the companion
 * Ed25519 private key. The control secret is never part of the signed payload —
 * the shared client adds it separately to the frozen token header.
 */
export function createCompanionControlAuthorize(deps: {
  companion: CompanionControlCredential;
  now: () => number;
  randomBytes: (size: number) => Buffer;
}): SessionControlAuthorize {
  const privateKey = createPrivateKey(deps.companion.signingPrivateKeyPem);
  return ({ method, path: requestPath, body }) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.companion.accessToken}`,
    };
    if (method.toUpperCase() !== "GET") {
      const timestamp = new Date(deps.now()).toISOString();
      const nonce = deps.randomBytes(18).toString("base64url");
      const payload = buildCompanionSigningPayload({ method, path: requestPath, timestamp, nonce, body });
      const signature = nodeSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
      headers["x-goatcitadel-companion-timestamp"] = timestamp;
      headers["x-goatcitadel-companion-nonce"] = nonce;
      headers["x-goatcitadel-companion-signature"] = signature;
    }
    return headers;
  };
}

/**
 * Filesystem-backed secret store. One 0600 file per session/client-instance
 * under `baseDir`, containing only the raw secret. The file is created with
 * restrictive permissions before the secret is written.
 */
export function createFileSessionControlSecretStore(baseDir: string): SessionControlSecretStore {
  function secretPath(ref: SessionControlSecretRef): string {
    const safe = `${encodeStoreSegment(ref.sessionId)}__${encodeStoreSegment(ref.clientInstanceId)}.secret`;
    return path.join(baseDir, safe);
  }
  return {
    save(ref, secret) {
      mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      const file = secretPath(ref);
      writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best-effort on platforms without POSIX permission semantics.
      }
    },
    load(ref) {
      try {
        return readFileSync(secretPath(ref), "utf8");
      } catch {
        return undefined;
      }
    },
    clear(ref) {
      try {
        rmSync(secretPath(ref), { force: true });
      } catch {
        // Absent secret is already the desired post-condition.
      }
    },
  };
}

function encodeStoreSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
