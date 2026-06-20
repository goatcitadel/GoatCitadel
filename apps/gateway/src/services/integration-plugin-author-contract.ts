import path from "node:path";
import type {
  IntegrationPluginAuthorManifest,
  IntegrationPluginInstallInput,
  IntegrationPluginInstallSourceType,
  IntegrationPluginRecord,
  IntegrationPluginSourceMetadata,
  IntegrationPluginTrustWarning,
  PluginDescriptorHealth,
} from "@goatcitadel/contracts";
import { resolveIntegrationPluginAuthorManifestSource } from "@goatcitadel/extensions-sdk";
export {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  validateIntegrationPluginAuthorManifest,
  validateIntegrationPluginAuthorManifestDetailed,
} from "@goatcitadel/extensions-sdk";

export interface ResolvedIntegrationPluginInstallMetadata {
  source: string;
  manifest?: IntegrationPluginAuthorManifest;
  manifestPath?: string;
  sourceMetadata: IntegrationPluginSourceMetadata;
  trustWarnings: IntegrationPluginTrustWarning[];
  descriptorHealth: PluginDescriptorHealth;
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
  const descriptorHealth = buildPluginDescriptorHealth(resolved, source);
  const expectedIntegrity = options.expectedIntegrity ?? resolved.manifest?.integrity?.expected;
  const integrityStatus = expectedIntegrity ? "missing" : sourceType === "local" ? "not_applicable" : "unknown";
  const trustWarnings = [
    ...buildTrustWarnings(sourceType, integrityStatus, expectedIntegrity),
    ...descriptorHealth.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
    })),
  ];
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
    descriptorHealth,
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
    enabled: installMetadata.descriptorHealth.status === "quarantined" ? false : (input.existing?.enabled ?? true),
    installedAt: input.existing?.installedAt ?? input.now,
    updatedAt: input.now,
    capabilities: installMetadata.manifest?.capabilities ?? input.existing?.capabilities ?? ["channel.adapter"],
    sourceMetadata: installMetadata.sourceMetadata,
    integrityStatus:
      installMetadata.descriptorHealth.status === "quarantined"
        ? "quarantined"
        : installMetadata.sourceMetadata.integrityStatus,
    trustWarnings: installMetadata.trustWarnings,
    descriptorHealth: installMetadata.descriptorHealth,
    theme: installMetadata.manifest?.theme ?? input.existing?.theme,
    toolOverrides: installMetadata.manifest?.toolOverrides
      ? installMetadata.manifest.toolOverrides.map((entry) => ({
          toolName: entry.toolName.trim(),
          override: entry.override,
          status: "pending_owner_approval" as const,
        }))
      : input.existing?.toolOverrides,
  };
}

function buildPluginDescriptorHealth(
  resolved: ReturnType<typeof resolveIntegrationPluginAuthorManifestSource>,
  requestedSource: string,
): PluginDescriptorHealth {
  const checkedAt = new Date().toISOString();
  const baseEvidence = {
    owner: "gateway" as const,
    source: "integration_plugin_descriptor" as const,
    timestamp: checkedAt,
  };
  if (!resolved.manifestPath) {
    return {
      status: "warning",
      checkedAt,
      source: resolved.source || requestedSource,
      summary: "No GoatCitadel integration-plugin descriptor was found; install remains inspectable only.",
      issues: [
        {
          code: "descriptor.missing",
          severity: "warning",
          message: "goatcitadel.integration-plugin.json was not found for this plugin source.",
          action: "Add a descriptor manifest to make capabilities, version, and provenance reviewable.",
        },
      ],
      evidence: {
        ...baseEvidence,
        status: "warning",
      },
    };
  }
  if (resolved.manifestIssues?.length) {
    return {
      status: "quarantined",
      checkedAt,
      source: resolved.source || requestedSource,
      manifestPath: resolved.manifestPath,
      summary: "Plugin descriptor is malformed and has been quarantined from callable runtime.",
      issues: resolved.manifestIssues,
      evidence: {
        ...baseEvidence,
        status: "quarantined",
      },
    };
  }
  if (resolved.manifestError) {
    return {
      status: "quarantined",
      checkedAt,
      source: resolved.source || requestedSource,
      manifestPath: resolved.manifestPath,
      summary: "Plugin descriptor could not be parsed and has been quarantined from callable runtime.",
      issues: [
        {
          code: "descriptor.parse_failed",
          severity: "critical",
          message: resolved.manifestError,
          action: "Fix descriptor JSON and reinstall or repair the plugin.",
        },
      ],
      evidence: {
        ...baseEvidence,
        status: "quarantined",
      },
    };
  }
  if (resolved.manifest && resolved.descriptorHash) {
    return {
      status: "healthy",
      checkedAt,
      source: resolved.source || requestedSource,
      manifestPath: resolved.manifestPath,
      summary: "Plugin descriptor validated successfully.",
      issues: [],
      evidence: {
        ...baseEvidence,
        status: "healthy",
        descriptorHash: resolved.descriptorHash,
      },
    };
  }
  return {
    status: "quarantined",
    checkedAt,
    source: resolved.source || requestedSource,
    manifestPath: resolved.manifestPath,
    summary: "Plugin descriptor could not be validated and has been quarantined from callable runtime.",
    issues: [
      {
        code: "descriptor.validation_unavailable",
        severity: "critical",
        message: "Descriptor validation did not return a manifest or validation issues.",
        action: "Repair the plugin descriptor and reinstall.",
      },
    ],
    evidence: {
      ...baseEvidence,
      status: "quarantined",
    },
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
