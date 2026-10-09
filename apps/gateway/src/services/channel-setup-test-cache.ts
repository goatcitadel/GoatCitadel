import { createHash } from "node:crypto";
import { ValidationError, type ChannelSetupDraft, type ChannelSetupTestResult, type IntegrationConnection } from "@goatcitadel/contracts";

export interface ChannelSetupRecentTestCacheEntry {
  signature: string;
  result: ChannelSetupTestResult;
}

export const CHANNEL_SETUP_TEST_MAX_AGE_MS = 5 * 60_000;

export function channelSetupProofExpiresAt(checkedAt: string): string | undefined {
  const expiresAt = Date.parse(checkedAt) + CHANNEL_SETUP_TEST_MAX_AGE_MS;
  return Number.isFinite(expiresAt) && Math.abs(expiresAt) <= 8.64e15 ? new Date(expiresAt).toISOString() : undefined;
}

export interface ChannelSetupProofSignatureOptions {
  contentVersion?: string;
  validationVersion?: string;
  secretFieldKeys?: readonly string[];
  resolveConnectionSecret?: (config: Record<string, unknown>, directKey: string, envKey: string, catalogId: string) => string | undefined;
}

export function buildChannelSetupRecentTestSignature(
  draft: ChannelSetupDraft,
  connection: IntegrationConnection,
  testVersion: string,
  options: ChannelSetupProofSignatureOptions = {},
): string {
  let resolvedCredentials: Record<string, string | null> | undefined;
  if (options.resolveConnectionSecret) {
    resolvedCredentials = {};
    for (const key of options.secretFieldKeys ?? []) {
      if (connection.config[key] === undefined && connection.config[key + "Env"] === undefined) continue;
      try { resolvedCredentials[key] = options.resolveConnectionSecret(connection.config, key, key + "Env", draft.catalogId) ?? null; }
      catch { throw new ValidationError({ message: "Current channel credentials could not be resolved for setup evidence. Verify credential custody and retest." }); }
    }
  }
  return createHash("sha256")
    .update(
      stableStringifyForCache({
        catalogId: draft.catalogId,
        connectionRevision: draft.connectionRevision,
        lifecycleMode: draft.lifecycleMode,
        contentVersion: options.contentVersion ?? draft.contentVersion,
        validationVersion: options.validationVersion ?? draft.validationVersion,
        testVersion,
        ...(resolvedCredentials ? { resolvedCredentials } : {}),
        connection: {
          catalogId: connection.catalogId,
          kind: connection.kind,
          key: connection.key,
          label: connection.label,
          enabled: connection.enabled,
          config: connection.config,
        },
      }),
    )
    .digest("hex");
}

export function resolveReusableChannelSetupTestResult(input: {
  cache: Map<string, ChannelSetupRecentTestCacheEntry>;
  draft: ChannelSetupDraft;
  connection: IntegrationConnection;
  testVersion: string;
  nowMs?: number;
  signature?: string;
}): ChannelSetupTestResult | undefined {
  const cached = input.cache.get(input.draft.draftId);
  if (!cached || cached.result.status === "error") {
    return undefined;
  }
  const age = (input.nowMs ?? Date.now()) - Date.parse(cached.result.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > CHANNEL_SETUP_TEST_MAX_AGE_MS) {
    input.cache.delete(input.draft.draftId);
    return undefined;
  }
  const signature = input.signature ?? buildChannelSetupRecentTestSignature(input.draft, input.connection, input.testVersion);
  if (cached.signature !== signature) {
    input.cache.delete(input.draft.draftId);
    return undefined;
  }
  return { ...cached.result, draftRevision: input.draft.revision, proofExpiresAt: channelSetupProofExpiresAt(cached.result.checkedAt) };
}

function stableStringifyForCache(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyForCache(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyForCache((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
