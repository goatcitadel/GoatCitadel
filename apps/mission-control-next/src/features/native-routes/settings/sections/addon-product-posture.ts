// Pure add-on/capability-pack posture summary, split out of AddonsSection.tsx
// to keep that component under the max-lines budget.
import type {
  AddonCatalogEntry,
  AddonInstalledRecord,
  CapabilityPackManifest,
  CapabilityPackStagedRecord,
} from "@goatcitadel/contracts";

type AddonPostureCriterionState = "Proven" | "Partial" | "Out of 1.0";

interface AddonProductPostureCriterion {
  id: string;
  label: string;
  description: string;
  meta: AddonPostureCriterionState;
}

interface AddonProductPosture {
  stats: Array<{ label: string; value: string }>;
  criteria: AddonProductPostureCriterion[];
}

export function buildAddonProductPosture(data: {
  catalog: AddonCatalogEntry[];
  installed: AddonInstalledRecord[];
  capabilityPacks: CapabilityPackManifest[];
  stagedPacks: CapabilityPackStagedRecord[];
}): AddonProductPosture {
  const catalogCount = data.catalog.length;
  const installedCount = data.installed.length;
  const enabledCount = data.installed.filter(
    (item) => item.enabled !== false && item.runtimeStatus !== "disabled",
  ).length;
  const provenanceCount = data.catalog.filter((item) => item.owner && item.repoUrl && item.trustTier).length;
  const explicitDownloadCount = data.catalog.filter((item) => item.requiresSeparateRepoDownload === true).length;
  const healthCheckCount =
    data.catalog.reduce((count, item) => count + (item.healthChecks ?? []).length, 0) +
    data.installed.filter((item) => item.lastError || item.pid).length;
  const reviewFirstPackCount = data.capabilityPacks.filter((pack) =>
    pack.assets.some((asset) => asset.installMode === "review_required" || asset.installMode === "disabled"),
  ).length;
  const stagedPackCount = data.stagedPacks.length;
  const criteria: AddonProductPostureCriterion[] = [
    {
      id: "catalog-provenance",
      label: "Catalog provenance",
      description: catalogCount
        ? `${provenanceCount}/${catalogCount} catalog entries expose owner, repository, and trust tier.`
        : "No catalog entries are available from the gateway.",
      meta: provenanceCount === catalogCount && catalogCount > 0 ? "Proven" : "Partial",
    },
    {
      id: "install-review",
      label: "Install review",
      description: explicitDownloadCount
        ? `${explicitDownloadCount} add-ons require explicit separate-repository download confirmation.`
        : "Install routes exist, but no selected catalog entry currently proves the repo-download review gate.",
      meta: explicitDownloadCount ? "Proven" : "Partial",
    },
    {
      id: "permission-grants",
      label: "Permission grants",
      description:
        "Per-add-on tool permissions and side-effect scopes are not modeled as a graduated grant surface yet.",
      meta: "Out of 1.0",
    },
    {
      id: "enable-disable-truth",
      label: "Enable/disable truth",
      description: installedCount
        ? `${installedCount} installed records expose runtime status; ${enabledCount} are currently enabled.`
        : "Lifecycle APIs are present, but no installed record is available to prove operator state.",
      meta: installedCount ? "Proven" : "Partial",
    },
    {
      id: "version-update",
      label: "Version and update path",
      description:
        "Update actions and install refs exist, but catalog versioning is not yet a full marketplace contract.",
      meta: "Partial",
    },
    {
      id: "rollback-uninstall",
      label: "Rollback and uninstall",
      description: "Uninstall is operator-visible; rollback is not yet represented as a first-class add-on action.",
      meta: "Partial",
    },
    {
      id: "runtime-health",
      label: "Runtime health",
      description: healthCheckCount
        ? `${healthCheckCount} health or runtime signals are visible across catalog and installed records.`
        : "No health checks or process signals are visible for the current add-on set.",
      meta: healthCheckCount ? "Proven" : "Partial",
    },
    {
      id: "operator-logs",
      label: "Operator logs",
      description: "Add-on logs are not yet surfaced as a durable operator evidence lane.",
      meta: "Out of 1.0",
    },
    {
      id: "local-boundary",
      label: "Local-only boundary",
      description:
        stagedPackCount > 0
          ? `${stagedPackCount} staged pack records preserve review evidence without activating assets.`
          : reviewFirstPackCount > 0
            ? `${reviewFirstPackCount} capability packs still stage assets for review instead of implying marketplace install.`
            : "The product posture remains local/operator-reviewed, with no public marketplace claim.",
      meta: "Proven",
    },
  ];
  const provenCount = criteria.filter((item) => item.meta === "Proven").length;
  return {
    stats: [
      { label: "1.0 posture", value: "Experimental" },
      { label: "Marketplace", value: "Out of 1.0" },
      { label: "Installed proof", value: `${installedCount}/${catalogCount}` },
      { label: "Pack stages", value: String(stagedPackCount) },
      { label: "Graduation", value: `${provenCount}/${criteria.length}` },
    ],
    criteria,
  };
}
