import path from "node:path";
import type {
  IntegrationPluginAuthorManifest,
  IntegrationPluginInstallInput,
  IntegrationPluginInstallSourceType,
  IntegrationPluginRecord,
  IntegrationPluginSourceMetadata,
  IntegrationPluginTrustWarning,
} from "@goatcitadel/contracts";
import { resolveIntegrationPluginAuthorManifestSource } from "@goatcitadel/extensions-sdk";
export {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  validateIntegrationPluginAuthorManifest,
} from "@goatcitadel/extensions-sdk";

export interface ResolvedIntegrationPluginInstallMetadata {
  source: string;
  manifest?: IntegrationPluginAuthorManifest;
  manifestPath?: string;
  sourceMetadata: IntegrationPluginSourceMetadata;
  trustWarnings: IntegrationPluginTrustWarning[];
}

export interface BuildInstalledIntegrationPluginRecordInput {
  now: string;
  pluginId: string;
  source: string;
  sourceType?: IntegrationPluginInstallSourceType;
  expectedIntegrity?: string;
  existing?: IntegrationPluginRecord;
}

export function resolveIntegrationPluginInstallMetadata(
  source: string,
  options: Pick<IntegrationPluginInstallInput, "sourceType" | "expectedIntegrity"> = {},
): ResolvedIntegrationPluginInstallMetadata {
  const resolved = resolveIntegrationPluginAuthorManifestSource(source);
  const sourceType = options.sourceType ?? inferInstallSourceType(resolved.source);
  const expectedIntegrity = options.expectedIntegrity ?? resolved.manifest?.integrity?.expected;
  const integrityStatus = expectedIntegrity ? "missing" : sourceType === "local" ? "not_applicable" : "unknown";
  const trustWarnings = buildTrustWarnings(sourceType, integrityStatus, expectedIntegrity);
  return {
    source: resolved.source,
    manifest: resolved.manifest,
    manifestPath: resolved.manifestPath,
    sourceMetadata: {
      type: sourceType,
      display: normalizeInstallSourceDisplay(resolved.source, sourceType),
      packageName: resolved.manifest?.packageName,
      packageVersion: resolved.manifest?.version,
      integrityStatus,
      expectedIntegrity,
    },
    trustWarnings,
  };
}

export function buildInstalledIntegrationPluginRecord(
  input: BuildInstalledIntegrationPluginRecordInput,
): IntegrationPluginRecord {
  const installMetadata = resolveIntegrationPluginInstallMetadata(input.source, {
    sourceType: input.sourceType,
    expectedIntegrity: input.expectedIntegrity,
  });
  return {
    pluginId: input.pluginId,
    label: installMetadata.manifest?.label ?? input.existing?.label ?? toTitleCase(input.pluginId),
    version: installMetadata.manifest?.version ?? input.existing?.version ?? "0.1.0",
    description:
      installMetadata.manifest?.description ??
      input.existing?.description ??
      `Installed from ${installMetadata.source}`,
    source: installMetadata.source,
    enabled: input.existing?.enabled ?? true,
    installedAt: input.existing?.installedAt ?? input.now,
    updatedAt: input.now,
    capabilities: installMetadata.manifest?.capabilities ?? input.existing?.capabilities ?? ["channel.adapter"],
    sourceMetadata: installMetadata.sourceMetadata,
    integrityStatus: installMetadata.sourceMetadata.integrityStatus,
    trustWarnings: installMetadata.trustWarnings,
    theme: installMetadata.manifest?.theme ?? input.existing?.theme,
  };
}

function inferInstallSourceType(source: string): IntegrationPluginInstallSourceType {
  const trimmed = source.trim();
  if (!trimmed) {
    return "unknown";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.endsWith(".git") || isGitHubHttpsUrl(trimmed) ? "git" : "url";
  }
  if (/^(git\+|ssh:\/\/|git@)/i.test(trimmed)) {
    return "git";
  }
  if (/^(npm:|@?[\w.-]+\/[\w.-]+|@[\w.-]+\/[\w.-]+|[\w.-]+)$/i.test(trimmed) && !/[\\/:]/.test(trimmed)) {
    return "npm";
  }
  return path.isAbsolute(trimmed) || trimmed.startsWith(".") ? "local" : "manual";
}

function isGitHubHttpsUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function normalizeInstallSourceDisplay(source: string, sourceType: IntegrationPluginInstallSourceType): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "Unknown source";
  }
  if (sourceType === "local") {
    return `Local: ${path.basename(trimmed) || "plugin"}`;
  }
  if (sourceType === "git") {
    return "Git source";
  }
  if (sourceType === "url") {
    try {
      const parsed = new URL(trimmed);
      return `URL: ${parsed.hostname}`;
    } catch {
      return "URL source";
    }
  }
  if (sourceType === "npm") {
    return trimmed.replace(/^npm:/i, "");
  }
  return "Manual source";
}

function buildTrustWarnings(
  sourceType: IntegrationPluginInstallSourceType,
  integrityStatus: IntegrationPluginSourceMetadata["integrityStatus"],
  expectedIntegrity?: string,
): IntegrationPluginTrustWarning[] {
  const warnings: IntegrationPluginTrustWarning[] = [];
  if (integrityStatus === "missing" && expectedIntegrity) {
    warnings.push({
      code: "integrity_not_verified",
      severity: "warning",
      message: "An expected integrity value was supplied, but runtime package verification is not wired yet.",
    });
  }
  if (sourceType === "url" || sourceType === "manual" || sourceType === "unknown") {
    warnings.push({
      code: "unverified_source",
      severity: "warning",
      message: "Plugin source is not a verified local or package registry install.",
    });
  }
  return warnings;
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}
