import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { SecretStoreService } from "./secret-store-service.js";

const log = logger.child("external-side-effect-replay-record");

const REPLAY_KEY_ACCOUNT = "external-side-effect-replay:master_key";
const AAD_PREFIX = "goatcitadel:external-side-effect-replay:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ExternalSideEffectReplayRecords {
  seal(input: { runId: string; payloadHash: string; payload: unknown }): Promise<boolean>;
  open(run: Pick<ExternalSideEffectRunRecord, "runId" | "payloadHash">): Promise<{ payload: unknown } | undefined>;
}

export interface ExternalSideEffectReplayRecordDeps {
  resolveKey(): Buffer | undefined | Promise<Buffer | undefined>;
  runs: {
    attachReplayRecord(runId: string, json: string): boolean | Promise<boolean>;
    getReplayRecord(runId: string): string | undefined | Promise<string | undefined>;
  };
}

function buildAad(runId: string, payloadHash: string): string {
  return `${AAD_PREFIX}\0${runId}\0${payloadHash}`;
}

type ReplayKeySecretStore = Pick<SecretStoreService, "isAvailable" | "getSecret" | "setSecret"> &
  Partial<Pick<SecretStoreService, "isWriteCustodySafe">>;

/** Reports whether any run still holds a sealed record that the stored key must keep opening. */
export interface ReplayKeyGenerationGuard {
  hasReplayRecords(): boolean | Promise<boolean>;
}

/**
 * One keychain lookup per call. A fresh key is generated and stored only when none
 * exists, the store can write without exposing the value (the macOS `security(1)`
 * adapter puts it on argv), AND the guard proves no sealed record exists yet. A
 * lookup miss while sealed records exist is treated as a transient keychain failure:
 * replacing the key would orphan every record, so this returns undefined instead.
 */
export async function resolveExternalSideEffectReplayKey(
  secretStore: ReplayKeySecretStore | undefined,
  guard?: ReplayKeyGenerationGuard,
): Promise<Buffer | undefined> {
  try {
    return await resolveReplayKeyOrThrow(secretStore, guard);
  } catch {
    return undefined;
  }
}

/**
 * The same lookup as `resolveExternalSideEffectReplayKey`, but a thrown secret-store or guard
 * failure propagates instead of reading as "no key", so a caller can tell a transient key-store
 * outage apart from a missing key.
 */
async function resolveReplayKeyOrThrow(
  secretStore: ReplayKeySecretStore | undefined,
  guard?: ReplayKeyGenerationGuard,
): Promise<Buffer | undefined> {
  if (!secretStore || !secretStore.isAvailable()) {
    return undefined;
  }
  let keyBase64 = secretStore.getSecret(REPLAY_KEY_ACCOUNT);
  if (!keyBase64) {
    if (secretStore.isWriteCustodySafe?.() === false) {
      return undefined;
    }
    if (!guard || (await guard.hasReplayRecords())) {
      log.warn(
        "External side-effect replay key lookup missed while sealed records may exist; no replacement key generated",
      );
      return undefined;
    }
    keyBase64 = randomBytes(KEY_BYTES).toString("base64");
    secretStore.setSecret(REPLAY_KEY_ACCOUNT, keyBase64);
  }
  const key = Buffer.from(keyBase64, "base64");
  return key.length === KEY_BYTES ? key : undefined;
}

interface ReplayKeyResolvers {
  /** Reports a thrown key-store or guard failure as undefined. */
  swallowing: () => Promise<Buffer | undefined>;
  /** Rethrows a key-store or guard failure; a missing key is still undefined. */
  throwing: () => Promise<Buffer | undefined>;
}

/** Both resolver flavours over one memoized key, so neither can ever generate a second key. */
function createReplayKeyResolvers(
  secretStore: ReplayKeySecretStore | undefined,
  guard?: ReplayKeyGenerationGuard,
): ReplayKeyResolvers {
  let resolved: Buffer | undefined;
  const throwing = async () => {
    if (!resolved) {
      resolved = await resolveReplayKeyOrThrow(secretStore, guard);
    }
    return resolved;
  };
  const swallowing = async () => {
    try {
      return await throwing();
    } catch {
      return undefined;
    }
  };
  return { swallowing, throwing };
}

/**
 * Memoizes the first successfully resolved key. Once a key has resolved, later calls
 * never touch the keychain again, so a transient lookup miss can never generate a
 * replacement key that would orphan every sealed record. Failed lookups retry.
 */
export function createExternalSideEffectReplayKeyResolver(
  secretStore: ReplayKeySecretStore | undefined,
  guard?: ReplayKeyGenerationGuard,
): () => Promise<Buffer | undefined> {
  return createReplayKeyResolvers(secretStore, guard).swallowing;
}

const sharedResolvers = new WeakMap<object, ReplayKeyResolvers>();

function sharedReplayKeyResolvers(secretStore: ReplayKeySecretStore, guard: ReplayKeyGenerationGuard) {
  let resolvers = sharedResolvers.get(secretStore);
  if (!resolvers) {
    resolvers = createReplayKeyResolvers(secretStore, guard);
    sharedResolvers.set(secretStore, resolvers);
  }
  return resolvers;
}

/** Process-wide memoized resolver per secret store, shared by every action host built on it. */
export function sharedExternalSideEffectReplayKeyResolver(
  secretStore: ReplayKeySecretStore | undefined,
  guard: ReplayKeyGenerationGuard,
): () => Promise<Buffer | undefined> {
  return secretStore ? sharedReplayKeyResolvers(secretStore, guard).swallowing : async () => undefined;
}

/**
 * The shared resolver's throwing flavour: the same key account, guard and per-store memoized key,
 * but a thrown key-store or guard failure propagates. Only the Citadel Ward request vault uses
 * it, so an approved effect retries a transient outage instead of failing terminally.
 */
export function sharedExternalSideEffectReplayKeyResolverOrThrow(
  secretStore: ReplayKeySecretStore | undefined,
  guard: ReplayKeyGenerationGuard,
): () => Promise<Buffer | undefined> {
  return secretStore ? sharedReplayKeyResolvers(secretStore, guard).throwing : async () => undefined;
}

/** The sealed form of a replay payload: AES-256-GCM over `{"payload": …}` JSON, base64 fields. */
export interface ReplayEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Seals `payload` under `key`, bound to `aad`. Throws only on a malformed key. */
export function sealReplayEnvelope(key: Buffer, aad: string, payload: unknown): ReplayEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ payload }), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Opens an envelope sealed by `sealReplayEnvelope` under the same key and AAD. Returns
 * undefined (never throws) for a malformed, tampered, mis-bound or wrong-key envelope.
 */
export function openReplayEnvelope(key: Buffer, aad: string, envelope: unknown): { payload: unknown } | undefined {
  try {
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      return undefined;
    }
    const record = envelope as Record<string, unknown>;
    if (
      record.v !== 1 ||
      record.alg !== "aes-256-gcm" ||
      typeof record.iv !== "string" ||
      typeof record.ciphertext !== "string" ||
      typeof record.tag !== "string"
    ) {
      return undefined;
    }
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      return undefined;
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "payload")) {
      return undefined;
    }
    return { payload: (parsed as { payload: unknown }).payload };
  } catch {
    return undefined;
  }
}

export function createExternalSideEffectReplayRecords(
  deps: ExternalSideEffectReplayRecordDeps,
): ExternalSideEffectReplayRecords {
  return {
    async seal(input) {
      try {
        const key = await deps.resolveKey();
        if (!key) {
          return false;
        }
        const envelope = sealReplayEnvelope(key, buildAad(input.runId, input.payloadHash), input.payload);
        return await deps.runs.attachReplayRecord(input.runId, JSON.stringify(envelope));
      } catch (error) {
        log.warn("External side-effect replay record could not be sealed", {
          runId: input.runId,
          error: error instanceof Error ? error.message : "unknown error",
        });
        return false;
      }
    },
    async open(run) {
      try {
        const key = await deps.resolveKey();
        if (!key) {
          return undefined;
        }
        const json = await deps.runs.getReplayRecord(run.runId);
        if (!json) {
          return undefined;
        }
        return openReplayEnvelope(key, buildAad(run.runId, run.payloadHash), JSON.parse(json));
      } catch {
        return undefined;
      }
    },
  };
}
