import { createHash } from "node:crypto";
import type { ChannelSetupDraft, ChannelSetupTestResult, IntegrationConnection } from "@goatcitadel/contracts";

export interface ChannelSetupRecentTestCacheEntry {
  signature: string;
  result: ChannelSetupTestResult;
}

export function buildChannelSetupRecentTestSignature(
  draft: ChannelSetupDraft,
  connection: IntegrationConnection,
  testVersion: string,
): string {
  return createHash("sha256")
    .update(
      stableStringifyForCache({
        catalogId: draft.catalogId,
        lifecycleMode: draft.lifecycleMode,
        contentVersion: draft.contentVersion,
        validationVersion: draft.validationVersion,
        testVersion,
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
}): ChannelSetupTestResult | undefined {
  const cached = input.cache.get(input.draft.draftId);
  if (!cached || cached.result.status === "error") {
    return undefined;
  }
  const signature = buildChannelSetupRecentTestSignature(input.draft, input.connection, input.testVersion);
  if (cached.signature !== signature) {
    input.cache.delete(input.draft.draftId);
    return undefined;
  }
  return cached.result;
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
