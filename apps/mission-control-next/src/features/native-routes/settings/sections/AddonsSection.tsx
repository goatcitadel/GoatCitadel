// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Play, Plug2, Plus, RefreshCw, ShieldCheck, Square, Trash2 } from "lucide-react";
import type {
  AddonCatalogEntry,
  AddonInstalledRecord,
  CapabilityPackExportResponse,
  CapabilityPackManifest,
  CapabilityPackPreview,
  CapabilityPackStagedRecord,
} from "@goatcitadel/contracts";
import {
  disableAddon,
  enableAddon,
  exportCapabilityPack,
  fetchAddonsCatalog,
  fetchAddonStatus,
  fetchCapabilityPackPreview,
  fetchCapabilityPacks,
  fetchInstalledAddons,
  fetchLocalCapabilityPackPreview,
  fetchStagedCapabilityPacks,
  installAddon,
  installCapabilityPack,
  installLocalCapabilityPack,
  launchAddon,
  materializeStagedCapabilityPack,
  stopAddon,
  uninstallAddon,
  updateAddon,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  type LoadState,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";

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

function buildAddonProductPosture(data: {
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

export function AddonsSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [catalog, installed, capabilityPacks, stagedPacks] = await Promise.all([
      nativeLoad("Add-on catalog", fetchAddonsCatalog(), { items: [] }),
      nativeLoad("Installed add-ons", fetchInstalledAddons(), { items: [] }),
      nativeLoad("Capability packs", fetchCapabilityPacks(), { items: [] }),
      nativeLoad("Staged capability packs", fetchStagedCapabilityPacks(), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([catalog, installed, capabilityPacks, stagedPacks]),
      catalog: catalog.data.items,
      installed: installed.data.items,
      capabilityPacks: capabilityPacks.data.items,
      stagedPacks: stagedPacks.data.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAddonId, setSelectedAddonId] = useState("");
  const [selectedPackId, setSelectedPackId] = useState("");
  const [status, setStatus] = useState<LoadState<Awaited<ReturnType<typeof fetchAddonStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });
  const [packPreview, setPackPreview] = useState<LoadState<CapabilityPackPreview>>({
    loading: false,
    error: null,
    data: null,
  });
  const [localPackText, setLocalPackText] = useState("");
  const [localPackPreview, setLocalPackPreview] = useState<LoadState<CapabilityPackPreview>>({
    loading: false,
    error: null,
    data: null,
  });
  const [packExport, setPackExport] = useState<LoadState<CapabilityPackExportResponse>>({
    loading: false,
    error: null,
    data: null,
  });

  const installedById = useMemo(
    () => new Map((data?.installed ?? []).map((item) => [item.addonId, item])),
    [data?.installed],
  );
  const selectedAddon = data?.catalog?.find((item) => item.addonId === selectedAddonId) ?? data?.catalog?.[0] ?? null;
  const selectedPack =
    data?.capabilityPacks?.find((item) => item.packId === selectedPackId) ?? data?.capabilityPacks?.[0] ?? null;
  const selectedInstalledRecord = selectedAddon
    ? (status.data?.installed ?? installedById.get(selectedAddon.addonId))
    : undefined;
  const selectedAddonInstalled = Boolean(selectedInstalledRecord);
  const selectedAddonEnabled = selectedInstalledRecord
    ? selectedInstalledRecord.enabled !== false && selectedInstalledRecord.runtimeStatus !== "disabled"
    : false;
  const selectedAddonRuntimeStatus = status.data?.status ?? selectedInstalledRecord?.runtimeStatus ?? "not_installed";
  const selectedAddonCanStop =
    selectedAddonInstalled && selectedAddonEnabled && ["running", "error"].includes(selectedAddonRuntimeStatus);
  const productPosture = useMemo(
    () =>
      data
        ? buildAddonProductPosture({
            catalog: data.catalog ?? [],
            installed: data.installed ?? [],
            capabilityPacks: data.capabilityPacks ?? [],
            stagedPacks: data.stagedPacks ?? [],
          })
        : null,
    [data],
  );

  useEffect(() => {
    if (!data?.catalog?.length) {
      setSelectedAddonId("");
      return;
    }
    setSelectedAddonId((current) =>
      current && data.catalog.some((item) => item.addonId === current) ? current : data.catalog[0]?.addonId || "",
    );
  }, [data?.catalog]);

  useEffect(() => {
    if (!selectedAddon) {
      setStatus({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setStatus({ loading: true, error: null, data: null });
    void fetchAddonStatus(selectedAddon.addonId)
      .then((result) => {
        if (!cancelled) {
          setStatus({ loading: false, error: null, data: result });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setStatus({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAddon]);

  useEffect(() => {
    if (!data?.capabilityPacks?.length) {
      setSelectedPackId("");
      return;
    }
    setSelectedPackId((current) =>
      current && data.capabilityPacks.some((item) => item.packId === current)
        ? current
        : data.capabilityPacks[0]?.packId || "",
    );
  }, [data?.capabilityPacks]);

  useEffect(() => {
    if (!selectedPack) {
      setPackPreview({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setPackPreview({ loading: true, error: null, data: null });
    void fetchCapabilityPackPreview(selectedPack.packId)
      .then((result) => {
        if (!cancelled) {
          setPackPreview({ loading: false, error: null, data: result });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setPackPreview({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPack]);

  useEffect(() => {
    setPackExport({ loading: false, error: null, data: null });
  }, [selectedPackId]);

  const runAddonAction = async (operation: () => Promise<unknown>, successMessage: string) => {
    try {
      await operation();
      setNotice({ tone: "success", message: successMessage });
      await reload();
      if (selectedAddon) {
        const nextStatus = await fetchAddonStatus(selectedAddon.addonId);
        setStatus({ loading: false, error: null, data: nextStatus });
      }
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  const readLocalPackManifest = (): CapabilityPackManifest => {
    try {
      const parsed = JSON.parse(localPackText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Manifest must be a JSON object.");
      }
      return parsed as CapabilityPackManifest;
    } catch (parseError) {
      throw new Error(parseError instanceof Error ? parseError.message : "Invalid capability pack JSON.", {
        cause: parseError,
      });
    }
  };

  const previewLocalPack = async () => {
    setLocalPackPreview({ loading: true, error: null, data: null });
    try {
      const result = await fetchLocalCapabilityPackPreview(readLocalPackManifest());
      setLocalPackPreview({ loading: false, error: null, data: result });
      setNotice({ tone: "success", message: `${result.manifest.name} preview ready.` });
    } catch (previewError) {
      setLocalPackPreview({ loading: false, error: getErrorMessage(previewError), data: null });
      setNotice({ tone: "error", message: getErrorMessage(previewError) });
    }
  };

  const stageLocalPack = async () => {
    try {
      const result = await installLocalCapabilityPack(readLocalPackManifest(), { actorId: "operator" });
      setNotice({ tone: "success", message: `${result.preview.manifest.name} staged for review.` });
      setLocalPackPreview({ loading: false, error: null, data: result.preview });
      await reload();
    } catch (installError) {
      setNotice({ tone: "error", message: getErrorMessage(installError) });
    }
  };

  const exportSelectedPack = async () => {
    if (!selectedPack) {
      return;
    }
    setPackExport({ loading: true, error: null, data: null });
    try {
      const result = await exportCapabilityPack(selectedPack.packId);
      setPackExport({ loading: false, error: null, data: result });
      setNotice({ tone: "success", message: `${result.manifest.name} export projection ready.` });
    } catch (exportError) {
      setPackExport({ loading: false, error: getErrorMessage(exportError), data: null });
      setNotice({ tone: "error", message: getErrorMessage(exportError) });
    }
  };

  const recordStagedPackMaterialization = async (record: CapabilityPackStagedRecord) => {
    if (!record.evidenceEnvelopeId) {
      setNotice({ tone: "error", message: "Staged pack evidence id is missing." });
      return;
    }
    try {
      const result = await materializeStagedCapabilityPack(record.evidenceEnvelopeId, {
        actorId: "operator",
        confirmReview: true,
        assetIds: record.stagedAssets.map((asset) => asset.assetId),
        note: "Operator recorded reviewed materialization from Settings Add-ons.",
      });
      setNotice({
        tone: "success",
        message: `${record.name} review recorded for ${result.assets.filter((asset) => asset.requested).length} assets.`,
      });
      await reload();
    } catch (materializeError) {
      setNotice({ tone: "error", message: getErrorMessage(materializeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {productPosture ? (
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="1.0 add-on posture"
              subtitle="Experimental local extensions with operator-reviewed install and launch controls."
              stats={productPosture.stats}
              scrollBody
              bodyMaxHeight="min(58vh, 34rem)"
            >
              <SettingsActionList
                items={productPosture.criteria.map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.description,
                  actionLabel: item.meta,
                }))}
                maxHeight="min(42vh, 24rem)"
              />
            </NativeCard>
          ) : null}
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Add-on catalog"
            subtitle="Experimental add-on runtimes and their current local install posture."
            scrollBody
            bodyMaxHeight="min(58vh, 34rem)"
            stats={[
              { label: "Catalog", value: String(data.catalog?.length ?? 0) },
              { label: "Installed", value: String(data.installed?.length ?? 0) },
            ]}
          >
            <NativeSelectableList
              items={(data.catalog ?? []).map((item) => {
                const installed = installedById.get(item.addonId);
                const lifecycle = installed
                  ? installed.enabled === false || installed.runtimeStatus === "disabled"
                    ? "disabled"
                    : "enabled"
                  : "not installed";
                return {
                  id: item.addonId,
                  title: item.label,
                  meta: item.trustTier,
                  body: `${item.category} · ${lifecycle}`,
                };
              })}
              selectedId={selectedAddonId}
              onSelect={setSelectedAddonId}
              emptyLabel="No add-ons returned from the catalog."
              maxHeight="min(42vh, 24rem)"
            />
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedAddon?.label ?? "Add-on detail"}
            subtitle="Operator-reviewed lifecycle controls for the selected local add-on."
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
          >
            {selectedAddon ? (
              <>
                <SettingsCodeBlock label="Description">{selectedAddon.description}</SettingsCodeBlock>
                <NativeMetricGrid
                  items={[
                    { label: "Trust tier", value: selectedAddon.trustTier, meta: selectedAddon.owner },
                    {
                      label: "Runtime",
                      value: selectedAddonRuntimeStatus,
                      meta: selectedAddon.runtimeType,
                    },
                    {
                      label: "Lifecycle",
                      value: selectedAddonInstalled ? (selectedAddonEnabled ? "enabled" : "disabled") : "not installed",
                      meta: selectedInstalledRecord?.updatedAt ?? "No installed record",
                    },
                    {
                      label: "Web entry",
                      value: selectedAddon.webEntryMode,
                      meta: selectedAddon.launchUrl ?? "No launch URL",
                    },
                  ]}
                />
                <SettingsButtonRow>
                  <NativeButton
                    variant="default"
                    onClick={() =>
                      void runAddonAction(
                        () => installAddon(selectedAddon.addonId, { confirmRepoDownload: true, actorId: "operator" }),
                        `${selectedAddon.label} install requested.`,
                      )
                    }
                  >
                    <Plus size={16} />
                    Install
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    onClick={() =>
                      void runAddonAction(
                        () => updateAddon(selectedAddon.addonId),
                        `${selectedAddon.label} update requested.`,
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    Update
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    disabled={!selectedAddonInstalled || selectedAddonEnabled}
                    onClick={() =>
                      void runAddonAction(
                        () => enableAddon(selectedAddon.addonId),
                        `${selectedAddon.label} enabled for operator launch.`,
                      )
                    }
                  >
                    <ShieldCheck size={16} />
                    Enable
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    disabled={!selectedAddonInstalled || !selectedAddonEnabled}
                    onClick={() =>
                      void runAddonAction(
                        () => disableAddon(selectedAddon.addonId),
                        `${selectedAddon.label} disabled and slots removed.`,
                      )
                    }
                  >
                    <Plug2 size={16} />
                    Disable
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    disabled={!selectedAddonInstalled || !selectedAddonEnabled}
                    onClick={() =>
                      void runAddonAction(
                        () => launchAddon(selectedAddon.addonId),
                        `${selectedAddon.label} launch requested.`,
                      )
                    }
                  >
                    <Play size={16} />
                    Launch
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    disabled={!selectedAddonCanStop}
                    onClick={() =>
                      void runAddonAction(
                        () => stopAddon(selectedAddon.addonId),
                        `${selectedAddon.label} stop requested.`,
                      )
                    }
                  >
                    <Square size={16} />
                    Stop
                  </NativeButton>
                  <NativeButton
                    variant="destructive"
                    onClick={() => {
                      if (!window.confirm(`Uninstall ${selectedAddon.label}?`)) {
                        return;
                      }
                      void runAddonAction(
                        () => uninstallAddon(selectedAddon.addonId),
                        `${selectedAddon.label} uninstalled.`,
                      );
                    }}
                  >
                    <Trash2 size={16} />
                    Uninstall
                  </NativeButton>
                </SettingsButtonRow>
                <SettingsActionList
                  items={selectedAddon.installCommands.map((item) => ({
                    label: item.command,
                    description: item.note || "Install command",
                    meta: item.args?.join(" ") || "No args",
                  }))}
                />
                {status.data?.healthChecks?.length ? (
                  <SettingsActionList
                    items={status.data.healthChecks.map((item) => ({
                      label: item.key,
                      description: item.message,
                      meta: item.status,
                    }))}
                  />
                ) : null}
              </>
            ) : (
              <SettingsEmptyState label="Choose an add-on from the catalog." />
            )}
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Capability packs"
            subtitle="Bundled review-first packs over skills, add-ons, MCP templates, plugins, and runtime presets."
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
            stats={[
              { label: "Packs", value: String(data.capabilityPacks?.length ?? 0) },
              { label: "Staged", value: String(data.stagedPacks?.length ?? 0) },
              { label: "Selected", value: selectedPack?.trustTier ?? "none" },
            ]}
          >
            <NativeSelectableList
              items={(data.capabilityPacks ?? []).map((item) => ({
                id: item.packId,
                title: item.name,
                meta: item.trustTier,
                body: `${item.version} · ${item.assets.length} assets · ${item.tags.join(", ")}`,
              }))}
              selectedId={selectedPackId}
              onSelect={setSelectedPackId}
              emptyLabel="No bundled capability packs are available."
              maxHeight="min(30vh, 17rem)"
            />
            {selectedPack ? (
              <>
                <SettingsCodeBlock label="Pack preview">{selectedPack.description}</SettingsCodeBlock>
                {packPreview.error ? (
                  <SettingsEmptyState label={`Preview failed: ${packPreview.error}`} />
                ) : packPreview.data ? (
                  <>
                    <NativeMetricGrid
                      items={[
                        {
                          label: "Trust",
                          value: packPreview.data.manifest?.trustTier ?? "unknown",
                          meta: "local bundled manifest",
                        },
                        {
                          label: "Review",
                          value: packPreview.data.reviewRequired ? "required" : "not required",
                          meta: packPreview.data.policyChanges?.redactionMode,
                        },
                        {
                          label: "Unsupported",
                          value: String(packPreview.data.unsupportedAssets?.length ?? 0),
                          meta: "runtime support check",
                        },
                      ]}
                    />
                    <SettingsActionList
                      items={(packPreview.data.installPlan ?? []).map((item) => ({
                        label: `${item.kind}: ${item.assetId}`,
                        description: item.reason,
                        meta: item.outcome,
                      }))}
                      emptyLabel="No installable assets in this pack."
                    />
                    <SettingsActionList
                      items={(packPreview.data.manifest?.installWarnings ?? []).map((warning, index) => ({
                        id: `${packPreview.data?.manifest?.packId}-warning-${index}`,
                        label: "Warning",
                        description: warning,
                        meta: "review",
                      }))}
                      emptyLabel="No warnings for this pack."
                    />
                    <SettingsButtonRow>
                      <NativeButton
                        variant="default"
                        disabled={packPreview.loading}
                        onClick={() =>
                          void runAddonAction(
                            () => installCapabilityPack(selectedPack.packId, { actorId: "operator" }),
                            `${selectedPack.name} staged for review.`,
                          )
                        }
                      >
                        <ShieldCheck size={16} />
                        Stage pack
                      </NativeButton>
                      <NativeButton
                        variant="secondary"
                        disabled={packExport.loading}
                        onClick={() => void exportSelectedPack()}
                      >
                        <ExternalLink size={16} />
                        Export manifest
                      </NativeButton>
                    </SettingsButtonRow>
                    {packExport.error ? (
                      <SettingsEmptyState label={`Export failed: ${packExport.error}`} />
                    ) : packExport.data ? (
                      <SettingsCodeBlock label="Read-only export">
                        {JSON.stringify(packExport.data, null, 2)}
                      </SettingsCodeBlock>
                    ) : null}
                  </>
                ) : (
                  <SettingsEmptyState
                    label={packPreview.loading ? "Loading pack preview..." : "Preview unavailable."}
                  />
                )}
              </>
            ) : (
              <SettingsEmptyState label="Choose a capability pack to preview." />
            )}
            <SettingsActionList
              items={(data.stagedPacks ?? []).map((item) => ({
                id: item.evidenceEnvelopeId ?? item.packId,
                label: item.name,
                description: item.latestMaterialization
                  ? `${item.version} · ${item.stagedAssets.length} review-gated assets · last reviewed ${item.latestMaterialization.materializedAt}`
                  : `${item.version} · ${item.stagedAssets.length} review-gated assets · ${item.source}`,
                meta: item.latestMaterialization?.evidenceEnvelopeId ?? item.evidenceEnvelopeId ?? item.status,
                actionLabel: item.latestMaterialization ? "Re-record review" : "Record review",
                onClick: item.evidenceEnvelopeId ? () => void recordStagedPackMaterialization(item) : undefined,
              }))}
              emptyLabel="No staged capability pack evidence yet."
              maxHeight="min(24vh, 14rem)"
            />
            <SettingsActionList
              items={[
                {
                  id: "pack-materialization-evidence-only",
                  label: "Materialization receipt",
                  description:
                    "Recording review creates durable evidence only; it does not grant tools, enable skills, launch add-ons, or call MCP servers.",
                  meta: "evidence only",
                },
                {
                  id: "pack-materialization-existing-surfaces",
                  label: "Activation boundary",
                  description:
                    "Assets that need runtime configuration still move through Skills, Add-ons, MCP, Plugins, Tools, or policy settings.",
                  meta: "governed surfaces",
                },
              ]}
              maxHeight=""
            />
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Portable pack"
            subtitle="Local-file manifests are staged for review; skills and add-ons are not auto-enabled."
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
          >
            <SettingsFieldGrid>
              <SettingsField label="Manifest JSON" span={2}>
                <textarea
                  className="mc-next-settings-textarea mc-next-settings-code"
                  value={localPackText}
                  rows={12}
                  placeholder='{"packId":"local-pack","name":"Local pack","description":"Operator-reviewed local bundle","version":"1.0.0","trustTier":"community","tags":["local"],"assets":[],"policyDefaults":{"requireFirstUseApproval":true,"memoryWriteAuthority":"operator_controlled","redactionMode":"strict","autoRunEnabled":false},"provenance":{"source":"local_file","publisher":"Workspace"},"installWarnings":["Review before staging."]}'
                  onChange={(event) => {
                    setLocalPackText(event.target.value);
                    setLocalPackPreview({ loading: false, error: null, data: null });
                  }}
                />
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsButtonRow>
              <NativeButton
                variant="secondary"
                disabled={localPackPreview.loading || !localPackText.trim()}
                onClick={() => void previewLocalPack()}
              >
                <ShieldCheck size={16} />
                Preview local pack
              </NativeButton>
              <NativeButton
                variant="default"
                disabled={localPackPreview.loading || !localPackPreview.data}
                onClick={() => void stageLocalPack()}
              >
                <Plus size={16} />
                Stage local pack
              </NativeButton>
            </SettingsButtonRow>
            {localPackPreview.error ? <SettingsEmptyState label={`Preview failed: ${localPackPreview.error}`} /> : null}
            {localPackPreview.data ? (
              <>
                <NativeMetricGrid
                  items={[
                    {
                      label: "Pack",
                      value: localPackPreview.data.manifest?.name ?? "unknown",
                      meta: localPackPreview.data.manifest?.provenance?.source,
                    },
                    {
                      label: "Review",
                      value: localPackPreview.data.reviewRequired ? "required" : "not required",
                      meta: localPackPreview.data.policyChanges?.redactionMode,
                    },
                    {
                      label: "Assets",
                      value: String(localPackPreview.data.installPlan?.length ?? 0),
                      meta: `${localPackPreview.data.unsupportedAssets?.length ?? 0} unsupported`,
                    },
                  ]}
                />
                <SettingsActionList
                  items={(localPackPreview.data.installPlan ?? []).map((item) => ({
                    label: `${item.kind}: ${item.assetId}`,
                    description: item.reason,
                    meta: item.outcome,
                  }))}
                  emptyLabel="No staged assets in this portable pack."
                />
                <SettingsActionList
                  items={(localPackPreview.data.manifest?.installWarnings ?? []).map((warning, index) => ({
                    id: `${localPackPreview.data?.manifest?.packId}-local-warning-${index}`,
                    label: "Warning",
                    description: warning,
                    meta: "review",
                  }))}
                  emptyLabel="No warnings for this portable pack."
                />
              </>
            ) : null}
          </NativeCard>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}
