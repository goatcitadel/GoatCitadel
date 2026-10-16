import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { SecretStoreService } from "./secret-store-service.js";

const log = logger.child("external-side-effect-replay-record");

const REPLAY_KEY_ACCOUNT = "external-side-effect-replay:master_key";
const AAD_PREFIX = "goatcitadel:external-side-effect-replay:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

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

export function resolveExternalSideEffectReplayKey(
  secretStore: Pick<SecretStoreService, "isAvailable" | "getSecret" | "setSecret"> | undefined,
): Buffer | undefined {
  try {
    if (!secretStore || !secretStore.isAvailable()) {
      return undefined;
    }
    let keyBase64 = secretStore.getSecret(REPLAY_KEY_ACCOUNT);
    if (!keyBase64) {
      keyBase64 = randomBytes(KEY_BYTES).toString("base64");
      secretStore.setSecret(REPLAY_KEY_ACCOUNT, keyBase64);
    }
    const key = Buffer.from(keyBase64, "base64");
    return key.length === KEY_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

export function createExternalSideEffectReplayRecords(
  deps: ExternalSideEffectReplayRecordDeps,
): ExternalSideEffectReplayRecords {
  return {
    async seal(input) {
      const key = deps.resolveKey();
      if (!key) {
        return false;
      }
      try {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
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
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
        decipher.setAAD(buildAad(run.runId, run.payloadHash));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
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
