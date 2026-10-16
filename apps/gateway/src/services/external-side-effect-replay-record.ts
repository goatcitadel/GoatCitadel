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
  resolveKey(): Buffer | undefined;
  runs: {
    attachReplayRecord(runId: string, json: string): boolean | Promise<boolean>;
    getReplayRecord(runId: string): string | undefined | Promise<string | undefined>;
  };
}

function buildAad(runId: string, payloadHash: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}\0${runId}\0${payloadHash}`, "utf8");
}

type ReplayKeySecretStore = Pick<SecretStoreService, "isAvailable" | "getSecret" | "setSecret"> &
  Partial<Pick<SecretStoreService, "isWriteCustodySafe">>;

/**
 * One keychain lookup per call. A fresh key is generated and stored only when none
 * exists AND the store can write without exposing the value; where it cannot (the
 * macOS `security(1)` adapter puts it on argv) this returns undefined and nothing
 * is sealed.
 */
export function resolveExternalSideEffectReplayKey(secretStore: ReplayKeySecretStore | undefined): Buffer | undefined {
  try {
    if (!secretStore || !secretStore.isAvailable()) {
      return undefined;
    }
    let keyBase64 = secretStore.getSecret(REPLAY_KEY_ACCOUNT);
    if (!keyBase64) {
      if (secretStore.isWriteCustodySafe?.() === false) {
        return undefined;
      }
      keyBase64 = randomBytes(KEY_BYTES).toString("base64");
      secretStore.setSecret(REPLAY_KEY_ACCOUNT, keyBase64);
    }
    const key = Buffer.from(keyBase64, "base64");
    return key.length === KEY_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Memoizes the first successfully resolved key. Once a key has resolved, later calls
 * never touch the keychain again, so a transient lookup miss can never generate a
 * replacement key that would orphan every sealed record. Failed lookups retry.
 */
export function createExternalSideEffectReplayKeyResolver(
  secretStore: ReplayKeySecretStore | undefined,
): () => Buffer | undefined {
  let resolved: Buffer | undefined;
  return () => {
    if (!resolved) {
      resolved = resolveExternalSideEffectReplayKey(secretStore);
    }
    return resolved;
  };
}

const sharedResolvers = new WeakMap<object, () => Buffer | undefined>();

/** Process-wide memoized resolver per secret store, shared by every action host built on it. */
export function sharedExternalSideEffectReplayKeyResolver(
  secretStore: ReplayKeySecretStore | undefined,
): () => Buffer | undefined {
  if (!secretStore) {
    return () => undefined;
  }
  let resolver = sharedResolvers.get(secretStore);
  if (!resolver) {
    resolver = createExternalSideEffectReplayKeyResolver(secretStore);
    sharedResolvers.set(secretStore, resolver);
  }
  return resolver;
}

export function createExternalSideEffectReplayRecords(
  deps: ExternalSideEffectReplayRecordDeps,
): ExternalSideEffectReplayRecords {
  return {
    async seal(input) {
      try {
        const key = deps.resolveKey();
        if (!key) {
          return false;
        }
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(buildAad(input.runId, input.payloadHash));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify({ payload: input.payload }), "utf8"),
          cipher.final(),
        ]);
        const record = JSON.stringify({
          v: 1,
          alg: "aes-256-gcm",
          iv: iv.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
        });
        return await deps.runs.attachReplayRecord(input.runId, record);
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
        const key = deps.resolveKey();
        if (!key) {
          return undefined;
        }
        const json = await deps.runs.getReplayRecord(run.runId);
        if (!json) {
          return undefined;
        }
        const record = JSON.parse(json) as Record<string, unknown>;
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
        decipher.setAAD(buildAad(run.runId, run.payloadHash));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(record.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
        const parsed = JSON.parse(plaintext) as { payload?: unknown };
        return { payload: parsed.payload };
      } catch {
        return undefined;
      }
    },
  };
}
