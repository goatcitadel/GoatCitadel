import type { IntegrationPluginAuthorManifest, IntegrationPluginRecord } from "@goatcitadel/contracts";
import {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  resolveIntegrationPluginAuthorManifestSource,
} from "@goatcitadel/extensions-sdk";
export {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  validateIntegrationPluginAuthorManifest,
} from "@goatcitadel/extensions-sdk";

export interface ResolvedIntegrationPluginInstallMetadata {
  source: string;
  manifest?: IntegrationPluginAuthorManifest;
  manifestPath?: string;
}

export interface BuildInstalledIntegrationPluginRecordInput {
  now: string;
  pluginId: string;
  source: string;
  existing?: IntegrationPluginRecord;
}

export function resolveIntegrationPluginInstallMetadata(source: string): ResolvedIntegrationPluginInstallMetadata {
  const resolved = resolveIntegrationPluginAuthorManifestSource(source);
  return {
    source: resolved.source,
    manifest: resolved.manifest,
    manifestPath: resolved.manifestPath,
  };
}

export function buildInstalledIntegrationPluginRecord(
  input: BuildInstalledIntegrationPluginRecordInput,
): IntegrationPluginRecord {
  const installMetadata = resolveIntegrationPluginInstallMetadata(input.source);
  return {
    pluginId: input.pluginId,
    label: installMetadata.manifest?.label ?? input.existing?.label ?? toTitleCase(input.pluginId),
    version: installMetadata.manifest?.version ?? input.existing?.version ?? "0.1.0",
    description: installMetadata.manifest?.description
      ?? input.existing?.description
      ?? `Installed from ${installMetadata.source}`,
    source: installMetadata.source,
    enabled: input.existing?.enabled ?? true,
    installedAt: input.existing?.installedAt ?? input.now,
    updatedAt: input.now,
    capabilities: installMetadata.manifest?.capabilities ?? input.existing?.capabilities ?? ["channel.adapter"],
  };
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}
