import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupIssue,
  ChannelSetupTestResult,
  ChannelSetupValidationLevel,
  ChannelSetupValidationResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import {
  resolveReusableChannelSetupTestResult,
  type ChannelSetupRecentTestCacheEntry,
} from "./channel-setup-test-cache.js";

export interface ChannelSetupHost {
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
}

export function buildDefaultChannelSetupDraft(definition: ChannelSetupDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const step of definition.wizard.steps) {
    for (const field of step.fields ?? []) {
      if (field.defaultValue !== undefined) {
        defaults[field.key] = field.defaultValue;
      }
    }
  }
  return defaults;
}

export function buildChannelSetupValidationResult(
  draft: ChannelSetupDraft,
  levels: ChannelSetupValidationLevel[],
  issues: ChannelSetupIssue[],
): ChannelSetupValidationResult {
  const status = issues.some((issue) => issue.level === "error")
    ? "error"
    : issues.some((issue) => issue.level === "warn")
      ? "warn"
      : "ok";
  return {
    draftId: draft.draftId,
    draftRevision: draft.revision,
    status,
    levels,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

export async function buildEphemeralChannelConnection(
  host: ChannelSetupHost,
  draft: ChannelSetupDraft,
  secretFieldKeys?: string[],
): Promise<IntegrationConnection> {
  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === draft.catalogId);
  if (!catalog) {
    throw new Error(`Unknown integration catalog id: ${draft.catalogId}`);
  }
  const nextConfig = runtime.normalize(draft);
  const currentConfig = draft.connectionId ? (await host.getIntegrationConnection(draft.connectionId)).config : {};
  const preservedSecrets = Object.fromEntries(
    (secretFieldKeys ?? runtime.definition.adapter.secretFieldKeys)
      .filter((key) => nextConfig[key] === undefined && currentConfig[key] !== undefined)
      .map((key) => [key, currentConfig[key]]),
  );
  return {
    connectionId: draft.connectionId ?? draft.draftId,
    catalogId: catalog.catalogId,
    kind: catalog.kind,
    key: catalog.key,
    label: draft.label?.trim() || catalog.label,
    enabled: draft.enabled,
    status: "connected",
    config: {
      ...currentConfig,
      ...preservedSecrets,
      ...nextConfig,
    },
    createdAt: draft.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export async function getReusableChannelSetupTestResult(
  host: ChannelSetupHost,
  cache: Map<string, ChannelSetupRecentTestCacheEntry>,
  draft: ChannelSetupDraft,
): Promise<ChannelSetupTestResult | undefined> {
  const runtime = requireChannelSetupDefinition(draft.catalogId);
  const connection = await buildEphemeralChannelConnection(host, draft, runtime.definition.adapter.secretFieldKeys);
  return resolveReusableChannelSetupTestResult({
    cache,
    draft,
    connection,
    testVersion: runtime.definition.testing.testVersion,
  });
}
