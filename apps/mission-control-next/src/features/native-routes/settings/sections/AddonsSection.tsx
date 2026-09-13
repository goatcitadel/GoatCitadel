// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
  humanizeEnumToken,
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
  SettingsStack,
  SettingsFilterBar,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { PackExecutionPanel } from "./PackExecutionPanel";

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

export function AddonsSection(props: SettingsSectionProps) {
  const [view, setView] = useSessionViewState<"addons" | "packs">("addons:view", "addons");
  const [panel, setPanel] = useState<"addon" | "pack" | "portable" | null>(null);
  const [packsRequested, setPacksRequested] = useState(view === "packs");
  const leave = useDraftLeave();
  const load = useCallback(async () => {
    const [catalog, installed] = await Promise.all([
      nativeLoad("Add-on catalog", fetchAddonsCatalog(), { items: [] }),
      nativeLoad("Installed add-ons", fetchInstalledAddons(), { items: [] }),
    ]);
    return { issues: nativeLoadIssues([catalog, installed]), catalog: catalog.data.items, installed: installed.data.items };
  }, []);
  const loadPacks = useCallback(async () => {
    if (!packsRequested) return { issues: [], capabilityPacks: [] as CapabilityPackManifest[], stagedPacks: [] as CapabilityPackStagedRecord[] };
    const [packs, staged] = await Promise.all([
      nativeLoad("Capability packs", fetchCapabilityPacks(), { items: [] }),
      nativeLoad("Staged capability packs", fetchStagedCapabilityPacks(), { items: [] }),
    ]);
    return { issues: nativeLoadIssues([packs, staged]), capabilityPacks: packs.data.items, stagedPacks: staged.data.items };
  }, [packsRequested]);
  const { loading, error, data: addonData, reload: reloadAddons } = useAsyncLoad(load, [load]);
  const { loading: packsLoading, error: packsError, data: packData, reload: reloadPacks } = useAsyncLoad(loadPacks, [loadPacks]);
  const data = useMemo(() => addonData ? { ...addonData, capabilityPacks: packData?.capabilityPacks ?? [], stagedPacks: packData?.stagedPacks ?? [], issues: [...addonData.issues, ...(packData?.issues ?? [])] } : null, [addonData, packData]);
  const reload = async () => { await Promise.all([reloadAddons(), packsRequested ? reloadPacks() : Promise.resolve()]); };
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAddonId, setSelectedAddonId] = useSessionViewState("addons:selected", "");
  const selectionRef = useRef(selectedAddonId); selectionRef.current = selectedAddonId;
  const actionBusy = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [pendingUninstall, setPendingUninstall] = useState<{ addonId: string; label: string } | null>(null);
  const [uninstallPending, setUninstallPending] = useState(false);
  const [selectedPackId, setSelectedPackId] = useSessionViewState("packs:selected", "");
  const packSelectionRef = useRef(selectedPackId); packSelectionRef.current = selectedPackId;
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
  const localDraft = useSessionDraft("portable-pack:" + props.activeWorkspaceId + ":import", "", undefined, { label: "Portable pack", active: panel === "portable", onSave: () => stageLocalPack() });
  const { value: localPackText, setValue: setLocalPackText } = localDraft;
  const localSourceRef = useRef(localPackText); localSourceRef.current = localPackText;
  const previewGeneration = useRef(0);
  const [reviewedLocalText, setReviewedLocalText] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const stagingRef = useRef(false);
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
  const selectedAddon = data?.catalog?.find((item) => item.addonId === selectedAddonId) ?? null;
  const selectedPack =
    data?.capabilityPacks?.find((item) => item.packId === selectedPackId) ?? null;
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
    if (!selectedAddon || panel !== "addon") {
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
  }, [selectedAddon, panel]);


  useEffect(() => {
    if (!selectedPack || panel !== "pack") {
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
  }, [selectedPack, panel]);

  useEffect(() => {
    setPackExport({ loading: false, error: null, data: null });
  }, [selectedPackId]);

  const runAddonAction = async (operation: () => Promise<unknown>, successMessage: string) => {
    if (actionBusy.current) return;
    actionBusy.current = true; setActionPending(true);
    const addonId = selectedAddon?.addonId;
    try {
      await operation();
      setNotice({ tone: "success", message: successMessage });
      await reload();
      if (addonId && addonId === selectionRef.current) {
        const nextStatus = await fetchAddonStatus(addonId);
        if (addonId === selectionRef.current) setStatus({ loading: false, error: null, data: nextStatus });
      }
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    } finally { actionBusy.current = false; setActionPending(false); }
  };

  const handleUninstall = async () => {
    if (!pendingUninstall) {
      return;
    }
    setUninstallPending(true);
    try {
      await uninstallAddon(pendingUninstall.addonId);
      setNotice({ tone: "success", message: `${pendingUninstall.label} uninstalled.` });
      setPendingUninstall(null);
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    } finally {
      setUninstallPending(false);
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
    const generation = ++previewGeneration.current;
    const source = localPackText;
    setReviewedLocalText(null);
    setLocalPackPreview({ loading: true, error: null, data: null });
    try {
      const result = await fetchLocalCapabilityPackPreview(readLocalPackManifest());
      if (generation !== previewGeneration.current || source !== localSourceRef.current) return;
      setReviewedLocalText(source);
      setLocalPackPreview({ loading: false, error: null, data: result });
      setNotice({ tone: "success", message: `${result.manifest.name} preview ready.` });
    } catch (previewError) {
      if (generation !== previewGeneration.current || source !== localSourceRef.current) return;
      setLocalPackPreview({ loading: false, error: getErrorMessage(previewError), data: null });
      setNotice({ tone: "error", message: getErrorMessage(previewError) });
    }
  };

  const stageLocalPack = async (): Promise<boolean> => {
    if (stagingRef.current) return false;
    if (!localPackPreview.data || reviewedLocalText !== localPackText) { setNotice({tone:"warning",message:"Preview the current manifest before staging it."}); return false; }
    const submitted = localPackText;
    stagingRef.current = true; setStaging(true);
    try {
      const result = await installLocalCapabilityPack(readLocalPackManifest(), { actorId: "operator" });
      const saved = localDraft.acceptSaved(submitted, undefined, submitted);
      setNotice({ tone: "success", message: result.preview.manifest.name + " staged for review." });
      if (localSourceRef.current === submitted) setLocalPackPreview({loading:false,error:null,data:result.preview});
      await reload(); return saved;
    } catch (cause) { setNotice({tone:"error",message:getErrorMessage(cause)}); return false; }
    finally { stagingRef.current = false; setStaging(false); }
  };

  const exportSelectedPack = async () => {
    if (!selectedPack) {
      return;
    }
    setPackExport({ loading: true, error: null, data: null });
    try {
      const result = await exportCapabilityPack(selectedPack.packId);
      if (selectedPack.packId !== packSelectionRef.current) return;
      setPackExport({ loading: false, error: null, data: result });
      setNotice({ tone: "success", message: `${result.manifest.name} export projection ready.` });
    } catch (exportError) {
      if (selectedPack.packId !== packSelectionRef.current) return;
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

  useEffect(() => { previewGeneration.current += 1; setLocalPackPreview({loading:false,error:null,data:null}); setReviewedLocalText(null); setPanel(null); }, [props.activeWorkspaceId]);
  const closePanel = () => leave.request(() => setPanel(null), panel === "portable" ? [localDraft.key] : []);
  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsStack>
      <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <p className="mc-next-settings-experimental-note">Experimental local extensions · operator-reviewed installation</p>
      {panel === "portable" ? <FocusedDetail title="Portable pack" onClose={closePanel}>
            <SettingsFieldGrid>
              <SettingsField label="Manifest JSON" span={2}>
                <textarea
                  className="mc-next-settings-textarea mc-next-settings-code"
                  value={localPackText}
                  rows={12}
                  placeholder='{"packId":"local-pack","name":"Local pack","description":"Operator-reviewed local bundle","version":"1.0.0","trustTier":"community","tags":["local"],"assets":[],"policyDefaults":{"requireFirstUseApproval":true,"memoryWriteAuthority":"operator_controlled","redactionMode":"strict","autoRunEnabled":false},"provenance":{"source":"local_file","publisher":"Workspace"},"installWarnings":["Review before staging."]}'
                  onChange={(event) => {
                    previewGeneration.current += 1;
                    localSourceRef.current = event.target.value;
                    setReviewedLocalText(null);
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
                disabled={staging || localPackPreview.loading || !localPackPreview.data || reviewedLocalText !== localPackText}
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
                  ariaLabel="Portable pack install plan"
                  items={(localPackPreview.data.installPlan ?? []).map((item) => ({
                    label: `${item.kind}: ${item.assetId}`,
                    description: item.reason,
                    meta: item.outcome,
                  }))}
                  emptyLabel="No staged assets in this portable pack."
                />
                <SettingsActionList
                  ariaLabel="Portable pack warnings"
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
          </FocusedDetail> : panel === "pack" ? <FocusedDetail title={selectedPack?.name ?? "Capability pack unavailable"} onClose={closePanel}><SettingsStack><p>{selectedPack?.description}</p><p>{selectedPack?.trustTier} · {selectedPack?.version}</p>{selectedPack && packPreview.data ? (<PackExecutionPanel
                      key={`${selectedPack.packId}:${props.activeWorkspaceId}`}
                      manifest={selectedPack}
                      workspaceId={props.activeWorkspaceId}
                      navigate={props.navigate}
                      route={props.route}
                    />) : <p role="status">{packPreview.error ? "Pack preview unavailable: " + packPreview.error : "Loading pack preview..."}</p>}<NativeDisclosureCard id="pack-staging-and-export" title="Staging and portable manifest" subtitle="Review installation warnings, advisory policy defaults, staging evidence, and export.">

            {selectedPack ? (
              <>
                <p>{selectedPack.description}</p>
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
                      ariaLabel="Capability pack install plan"
                      items={(packPreview.data.installPlan ?? []).map((item) => ({
                        label: `${item.kind}: ${item.assetId}`,
                        description: item.reason,
                        meta: item.outcome,
                      }))}
                      emptyLabel="No installable assets in this pack."
                    />
                    <SettingsActionList
                      ariaLabel="Capability pack warnings"
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


          </NativeDisclosureCard></SettingsStack></FocusedDetail> : <>
        <SettingsButtonRow><NativeButton onClick={() => {setView("packs");setPacksRequested(true);setPanel(null);}}>Browse packs</NativeButton><NativeButton variant="secondary" onClick={() => {setPacksRequested(true);setPanel("portable");}}>Import pack{localDraft.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="secondary" onClick={() => void reload()}>Refresh</NativeButton></SettingsButtonRow>
        <SettingsFilterBar options={[{id:"addons",label:"Add-ons"},{id:"packs",label:"Capability packs"}]} value={view} onChange={next => {setView(next as "addons" | "packs");if(next === "packs")setPacksRequested(true);setPanel(null);}} />
        {view === "addons" && data ? <NativeCard title="Add-on catalog" subtitle="" stats={[{label:"Catalog",value:data.issues.some(issue=>issue.label === "Add-on catalog") ? "Unavailable" : (Array.isArray(data.catalog) ? String(data.catalog.length) : "Unavailable")},{label:"Installed",value:data.issues.some(issue=>issue.label === "Installed add-ons") ? "Unavailable" : (Array.isArray(data.installed) ? String(data.installed.length) : "Unavailable")}]}>
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
              onSelect={id => { setSelectedAddonId(id); setPanel("addon"); }}
              emptyLabel="No add-ons returned from the catalog."
              maxHeight="min(65vh, 42rem)"
            />
          </NativeCard> : view === "packs" ? <>
          {packsError ? <SettingsNotice notice={{tone:"error",message:packsError}} /> : null}
          {packsLoading ? <p role="status">Loading capability packs...</p> : <NativeCard title="Capability packs" subtitle="" stats={[{label:"Packs",value:!packData || packsLoading ? "Loading" : packData.issues.some(issue=>issue.label === "Capability packs") ? "Unavailable" : (Array.isArray(packData.capabilityPacks) ? String(packData.capabilityPacks.length) : "Unavailable")},{label:"Staged",value:!packData || packsLoading ? "Loading" : packData.issues.some(issue=>issue.label === "Staged capability packs") ? "Unavailable" : (Array.isArray(packData.stagedPacks) ? String(packData.stagedPacks.length) : "Unavailable")},{label:"Selected",value:selectedPack?.trustTier ?? "None selected"}]}><NativeSelectableList
              items={(data?.capabilityPacks ?? []).map((item) => ({
                id: item.packId,
                title: item.name,
                meta: item.trustTier,
                body: `${item.version} · ${item.assets.length} assets · ${item.tags.join(", ")}`,
              }))}
              selectedId={selectedPackId}
              onSelect={id => { setSelectedPackId(id); setPanel("pack"); }}
              emptyLabel="No bundled capability packs are available."
              maxHeight="min(30vh, 17rem)"
            /></NativeCard>}
          <NativeDisclosureCard id="pack-staged-evidence" title="Staged packs and review evidence"><SettingsActionList
              ariaLabel="Staged capability pack evidence"
              items={(data?.stagedPacks ?? []).map((item) => ({
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
              ariaLabel="Capability pack materialization boundary"
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
            /></NativeDisclosureCard>
        </> : null}
      </>}
      {productPosture ? <NativeDisclosureCard id="addon-product-posture" title="1.0 add-on posture" subtitle="Experimental local extensions with operator-reviewed install and launch controls." stats={productPosture.stats}>
              <SettingsActionList
                ariaLabel="Add-on readiness criteria"
                items={productPosture.criteria.map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.description,
                  actionLabel: item.meta,
                }))}
                maxHeight="min(42vh, 24rem)"
              />
            </NativeDisclosureCard> : null}
      </SettingsStack>
      <DetailInspector open={panel === "addon"} title={selectedAddon?.label ?? "Add-on unavailable"} onClose={closePanel}>
        {status.loading ? <p role="status">Loading add-on status...</p> : null}
        {status.error ? <SettingsNotice notice={{tone:"error",message:"Add-on status unavailable: " + status.error}} /> : null}

            {selectedAddon ? (
              <>
                <p>{selectedAddon.description}</p>
                <NativeMetricGrid
                  items={[
                    {
                      label: "Trust tier",
                      value: humanizeEnumToken(selectedAddon.trustTier),
                      meta: selectedAddon.owner,
                    },
                    {
                      label: "Runtime",
                      value: humanizeEnumToken(selectedAddonRuntimeStatus),
                      meta: humanizeEnumToken(selectedAddon.runtimeType),
                    },
                    {
                      label: "Lifecycle",
                      value: selectedAddonInstalled ? (selectedAddonEnabled ? "Enabled" : "Disabled") : "Not installed",
                      meta: selectedInstalledRecord?.updatedAt ?? "No installed record",
                    },
                    {
                      label: "Web entry",
                      value: humanizeEnumToken(selectedAddon.webEntryMode),
                      meta: selectedAddon.launchUrl ?? "No launch URL",
                    },
                  ]}
                />
                <SettingsButtonRow>
                  <NativeButton disabled={actionPending}
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
                  <NativeButton disabled={actionPending}
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
                    disabled={actionPending || !selectedAddonInstalled || selectedAddonEnabled}
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
                    disabled={actionPending || !selectedAddonInstalled || !selectedAddonEnabled}
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
                    disabled={actionPending || !selectedAddonInstalled || !selectedAddonEnabled}
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
                    disabled={actionPending || !selectedAddonCanStop}
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
                  <NativeButton disabled={actionPending}
                    variant="destructive"
                    onClick={() => setPendingUninstall({ addonId: selectedAddon.addonId, label: selectedAddon.label })}
                  >
                    <Trash2 size={16} />
                    Uninstall
                  </NativeButton>
                </SettingsButtonRow>
                <NativeDisclosureCard id="addon-diagnostics" title="Install commands and diagnostics"><dl><dt>Repository</dt><dd>{selectedAddon.repoUrl}</dd><dt>Installed path</dt><dd>{selectedInstalledRecord?.installedPath ?? "Unavailable"}</dd><dt>Install reference</dt><dd>{selectedInstalledRecord?.installRef ?? "Unavailable"}</dd></dl>
                <SettingsActionList
                  ariaLabel="Add-on install commands"
                  items={selectedAddon.installCommands.map((item) => ({
                    label: item.command,
                    description: item.note || "Install command",
                    meta: item.args?.join(" ") || "No args",
                  }))}
                />
                {status.data?.healthChecks?.length ? (
                  <SettingsActionList
                    ariaLabel="Add-on health checks"
                    items={status.data.healthChecks.map((item) => ({
                      label: item.key,
                      description: item.message,
                      meta: item.status,
                    }))}
                  />
                ) : null}</NativeDisclosureCard>
              </>
            ) : (
              <SettingsEmptyState label="Choose an add-on from the catalog." />
            )}

      </DetailInspector>
      {leave.dialog}
      <ConfirmModal
        open={pendingUninstall !== null}
        danger
        pending={uninstallPending}
        title="Uninstall add-on?"
        message={`Uninstall ${pendingUninstall?.label ?? "this add-on"}? Runtime slots and its installed record will be removed.`}
        confirmLabel="Uninstall"
        onCancel={() => setPendingUninstall(null)}
        onConfirm={() => void handleUninstall()}
      />
    </SettingsSectionShell>
  );
}
