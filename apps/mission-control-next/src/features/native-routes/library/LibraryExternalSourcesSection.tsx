import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ExternalSourceCatalogItem,
  ExternalSourceDetailResponse,
  ExternalSourceImportApplyResponse,
  ExternalSourceImportDetailResponse,
  ExternalSourceImportPlanResponse,
  ExternalSourceKind,
  ExternalSourceListResponse,
  ExternalSourcePage,
  WorkspacePathFlavor,
} from "@goatcitadel/contracts";
import {
  applyExternalSourceImport,
  createExternalSourceImportPlan,
  fetchExternalSourceCatalogPage,
  fetchExternalSourceDetail,
  fetchExternalSourceImportDetail,
  fetchExternalSources,
  isExternalSourceCapabilityAbsent,
  registerExternalSource,
  scanExternalSource,
} from "@goatcitadel/mission-control-shared/api/external-sources";
import { NativeCard } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { formatDateTime, useAsyncLoad } from "../shared/native-helpers";
import { LibraryField, LibraryFieldGrid, LibraryMetricGrid, LibrarySectionShell } from "../shared/library-primitives";

const SOURCE_KINDS: Array<{ value: ExternalSourceKind; label: string }> = [
  { value: "codex_sessions", label: "Codex sessions" },
  { value: "codex_memory", label: "Codex memory" },
  { value: "claude_sessions", label: "Claude sessions" },
  { value: "claude_memory", label: "Claude memory" },
];
const PATH_FLAVORS: WorkspacePathFlavor[] = ["windows_native", "windows_forward", "msys", "wsl"];
const HASH_PREVIEW_CHARS = 12;

function shortHash(value: string): string {
  return `${value.slice(0, HASH_PREVIEW_CHARS)}…`;
}

function describeActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

interface RegisterDraft {
  kind: ExternalSourceKind;
  label: string;
  canonicalRootPath: string;
  pathBridgeSnapshotId: string;
  pathBridgeSnapshotSha256: string;
  inputFlavor: WorkspacePathFlavor;
  targetFlavor: WorkspacePathFlavor;
  distro: string;
  requireGitIdentity: boolean;
  gitIdentitySha256: string;
  acceptedProducerVersions: string;
  expectedWorkspaceRevision: string;
}

const EMPTY_REGISTER_DRAFT: RegisterDraft = {
  kind: "codex_sessions",
  label: "",
  canonicalRootPath: "",
  pathBridgeSnapshotId: "",
  pathBridgeSnapshotSha256: "",
  inputFlavor: "windows_native",
  targetFlavor: "windows_native",
  distro: "",
  requireGitIdentity: false,
  gitIdentitySha256: "",
  acceptedProducerVersions: "",
  expectedWorkspaceRevision: "1",
};

/**
 * HX-407 C3 Library surface: registration, scanning, catalog inspection, dry
 * run (import plans), apply (imports), and content-free provenance. Everything
 * runs through the typed shared client, so no request can smuggle a hash and
 * no unvalidated response is trusted. While the Gateway keeps the routes dark
 * (proof gate / pre-C4 composition) the list read 404s and the section renders
 * one informational card — the same benign-absence mapping as
 * CitadelBlueprintRoutePage's 404 branch.
 */
export function LibraryExternalSourcesSection({ workspaceId }: { workspaceId: string }) {
  const formInstanceId = useId();
  const mountedRef = useRef(true);
  const activeWorkspaceRef = useRef(workspaceId);
  const actionRequestRef = useRef(0);
  activeWorkspaceRef.current = workspaceId;
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExternalSourceDetailResponse | null>(null);
  const [catalog, setCatalog] = useState<ExternalSourcePage | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<readonly string[]>([]);
  const [plan, setPlan] = useState<ExternalSourceImportPlanResponse | null>(null);
  const [importDetail, setImportDetail] = useState<ExternalSourceImportDetailResponse | null>(null);
  const [importLookupId, setImportLookupId] = useState("");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerDraft, setRegisterDraft] = useState<RegisterDraft>(EMPTY_REGISTER_DRAFT);

  const list = useAsyncLoad<{ supported: boolean; sources: ExternalSourceListResponse | null }>(async () => {
    try {
      return { supported: true, sources: await fetchExternalSources(workspaceId) };
    } catch (error) {
      if (isExternalSourceCapabilityAbsent(error)) {
        // Production-dark posture: absence is a state, never an error.
        return { supported: false, sources: null };
      }
      throw error;
    }
  }, [workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    actionRequestRef.current += 1;
    setBusyKey(null);
    setSelectedSourceId(null);
    setDetail(null);
    setCatalog(null);
    setSelectedItemIds([]);
    setPlan(null);
    setImportDetail(null);
    setImportLookupId("");
    setRegisterOpen(false);
    setRegisterDraft(EMPTY_REGISTER_DRAFT);
    setActionError(null);
    setActionNotice(null);
  }, [workspaceId]);

  const runAction = useCallback(
    async (key: string, operation: (isCurrent: () => boolean) => Promise<string | null>) => {
      if (!mountedRef.current || activeWorkspaceRef.current !== workspaceId) {
        return;
      }
      const requestId = actionRequestRef.current + 1;
      actionRequestRef.current = requestId;
      const isCurrent = () =>
        mountedRef.current && activeWorkspaceRef.current === workspaceId && actionRequestRef.current === requestId;
      setBusyKey(key);
      setActionError(null);
      setActionNotice(null);
      try {
        const notice = await operation(isCurrent);
        if (isCurrent() && notice) {
          setActionNotice(notice);
        }
      } catch (error) {
        if (isCurrent()) {
          setActionError(describeActionError(error));
        }
      } finally {
        if (isCurrent()) {
          setBusyKey(null);
        }
      }
    },
    [workspaceId],
  );

  const loadCatalogPage = useCallback(
    async (sourceId: string, scanId: string, isCurrent: () => boolean, cursor?: string) => {
      const page = await fetchExternalSourceCatalogPage(sourceId, {
        workspaceId,
        scanId,
        ...(cursor ? { cursor } : {}),
        limit: 50,
      });
      if (!isCurrent()) {
        return;
      }
      setCatalog((current) =>
        cursor && current && current.scanId === page.scanId
          ? { ...page, items: [...current.items, ...page.items] }
          : page,
      );
    },
    [workspaceId],
  );

  const loadSelectedSource = useCallback(
    async (sourceId: string, isCurrent: () => boolean) => {
      const nextDetail = await fetchExternalSourceDetail(workspaceId, sourceId);
      if (!isCurrent()) {
        return;
      }
      setDetail(nextDetail);
      if (nextDetail.latestScan && nextDetail.latestScan.status === "sealed" && nextDetail.latestScan.itemCount > 0) {
        await loadCatalogPage(sourceId, nextDetail.latestScan.scanId, isCurrent);
      }
    },
    [loadCatalogPage, workspaceId],
  );

  const handleSelectSource = useCallback(
    (sourceId: string) => {
      setSelectedSourceId(sourceId);
      setDetail(null);
      setCatalog(null);
      setSelectedItemIds([]);
      setPlan(null);
      setImportDetail(null);
      void runAction(`detail:${sourceId}`, async (isCurrent) => {
        await loadSelectedSource(sourceId, isCurrent);
        return null;
      });
    },
    [loadSelectedSource, runAction],
  );

  const handleScan = useCallback(() => {
    if (!detail) {
      return;
    }
    const sourceId = detail.source.sourceId;
    void runAction("scan", async (isCurrent) => {
      const scan = await scanExternalSource(sourceId, {
        workspaceId,
        expectedRevision: detail.source.revision,
      });
      if (!isCurrent()) {
        return null;
      }
      const nextDetail = await fetchExternalSourceDetail(workspaceId, sourceId);
      if (!isCurrent()) {
        return null;
      }
      setDetail(nextDetail);
      setSelectedItemIds([]);
      setPlan(null);
      if (scan.status === "sealed" && scan.itemCount > 0) {
        await loadCatalogPage(sourceId, scan.scanId, isCurrent);
      } else {
        setCatalog(null);
      }
      return scan.status === "sealed"
        ? `Scan sealed: ${scan.supportedItemCount} supported of ${scan.itemCount} items.`
        : `Scan blocked: ${scan.blockerCodes.join(", ") || "no blocker code"}.`;
    });
  }, [detail, loadCatalogPage, runAction, workspaceId]);

  const handleToggleItem = useCallback(
    (item: ExternalSourceCatalogItem) => {
      if (item.disposition !== "supported") {
        return;
      }
      setPlan(null);
      setSelectedItemIds((current) =>
        current.includes(item.itemId) ? current.filter((id) => id !== item.itemId) : [...current, item.itemId],
      );
    },
    [setSelectedItemIds],
  );

  const handleDryRun = useCallback(() => {
    if (!detail || !catalog || selectedItemIds.length === 0) {
      return;
    }
    void runAction("plan", async (isCurrent) => {
      const planned = await createExternalSourceImportPlan({
        workspaceId,
        sourceId: detail.source.sourceId,
        scanId: catalog.scanId,
        selectedItemIds: [...selectedItemIds],
        expectedRevision: detail.source.revision,
      });
      if (!isCurrent()) {
        return null;
      }
      setPlan(planned);
      setImportDetail(null);
      return planned.plan.blockerCodes.length > 0
        ? `Dry run completed with blockers: ${planned.plan.blockerCodes.join(", ")}.`
        : "Dry run sealed. Review the exact hashes, then apply.";
    });
  }, [catalog, detail, runAction, selectedItemIds, workspaceId]);

  const handleApply = useCallback(() => {
    if (!plan) {
      return;
    }
    void runAction("apply", async (isCurrent) => {
      const applied: ExternalSourceImportApplyResponse = await applyExternalSourceImport({
        workspaceId,
        planId: plan.plan.planId,
        expectedPlanSha256: plan.plan.planSha256,
        idempotencyKey: plan.idempotencyKey,
      });
      if (!isCurrent()) {
        return null;
      }
      setImportDetail(applied);
      setPlan(null);
      setSelectedItemIds([]);
      return applied.applyDisposition === "replayed"
        ? "Apply replayed the canonical earlier import."
        : `Import ${applied.settlement?.disposition ?? "admitted"}: ${applied.items.length} item(s).`;
    });
  }, [plan, runAction, workspaceId]);

  const handleImportLookup = useCallback(() => {
    const importId = importLookupId.trim();
    if (!importId) {
      return;
    }
    void runAction("import-lookup", async (isCurrent) => {
      const nextImportDetail = await fetchExternalSourceImportDetail(workspaceId, importId);
      if (isCurrent()) {
        setImportDetail(nextImportDetail);
      }
      return null;
    });
  }, [importLookupId, runAction, workspaceId]);

  const handleRegister = useCallback(() => {
    void runAction("register", async (isCurrent) => {
      const expectedWorkspaceRevision = Number.parseInt(registerDraft.expectedWorkspaceRevision, 10);
      const producerVersions = registerDraft.acceptedProducerVersions
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const created = await registerExternalSource({
        workspaceId,
        expectedWorkspaceRevision,
        kind: registerDraft.kind,
        label: registerDraft.label.trim(),
        canonicalRootPath: registerDraft.canonicalRootPath.trim(),
        pathBridgeSnapshotId: registerDraft.pathBridgeSnapshotId.trim(),
        pathBridgeSnapshotSha256: registerDraft.pathBridgeSnapshotSha256.trim().toLowerCase(),
        inputFlavor: registerDraft.inputFlavor,
        targetFlavor: registerDraft.targetFlavor,
        ...(registerDraft.distro.trim() ? { distro: registerDraft.distro.trim() } : {}),
        requireGitIdentity: registerDraft.requireGitIdentity,
        ...(registerDraft.requireGitIdentity && registerDraft.gitIdentitySha256.trim()
          ? { gitIdentitySha256: registerDraft.gitIdentitySha256.trim().toLowerCase() }
          : {}),
        acceptedProducerVersions: producerVersions,
      });
      if (!isCurrent()) {
        return null;
      }
      setRegisterOpen(false);
      setRegisterDraft(EMPTY_REGISTER_DRAFT);
      await list.reload();
      if (!isCurrent()) {
        return null;
      }
      setSelectedSourceId(created.source.sourceId);
      setDetail(null);
      setCatalog(null);
      setSelectedItemIds([]);
      setPlan(null);
      setImportDetail(null);
      await loadSelectedSource(created.source.sourceId, isCurrent);
      return `Registered ${created.source.label}. No scan ran; seal one explicitly.`;
    });
  }, [list, loadSelectedSource, registerDraft, runAction, workspaceId]);

  const supported = list.data?.supported ?? true;
  const sources = list.data?.sources?.items ?? [];
  const busy = busyKey !== null;

  return (
    <LibrarySectionShell loading={list.loading} error={list.error} onRetry={() => void list.reload()}>
      {!supported ? (
        <NativeCard
          title="External sources"
          subtitle="Governed read-only imports of Codex and Claude session or memory roots."
        >
          <EmptyState
            size="compact"
            title="The external-source runtime is not composed in this build."
            description="Registration, scanning, and imports activate when the HX-407 runtime is promoted. Nothing is degraded elsewhere."
          />
        </NativeCard>
      ) : (
        <div className="mc-next-settings-stack">
          {actionError ? <NoticeBanner tone="error" message={actionError} /> : null}
          {actionNotice ? <NoticeBanner tone="info" message={actionNotice} /> : null}
          <NativeCard
            title="External sources"
            subtitle="Registered read-only roots for governed Codex/Claude imports. Registration implies no scan."
            stats={[{ label: "Sources", value: String(sources.length) }]}
            actions={
              <NativeButton
                variant="outline"
                onClick={() => setRegisterOpen((current) => !current)}
                aria-expanded={registerOpen}
              >
                {registerOpen ? "Close registration" : "Register source"}
              </NativeButton>
            }
          >
            {registerOpen ? (
              <RegisterSourceForm
                draft={registerDraft}
                busy={busy}
                formInstanceId={formInstanceId}
                onChange={setRegisterDraft}
                onSubmit={handleRegister}
              />
            ) : null}
            {sources.length === 0 ? (
              <EmptyState
                size="compact"
                title="No external sources are registered."
                description="Register one exact root grant to begin a governed read-only import."
              />
            ) : (
              <ul role="list" className="mc-next-ext-source-list">
                {sources.map((source) => (
                  <li key={source.sourceId}>
                    <button
                      type="button"
                      className={`mc-next-ext-source-row${selectedSourceId === source.sourceId ? " is-selected" : ""}`}
                      onClick={() => handleSelectSource(source.sourceId)}
                      aria-pressed={selectedSourceId === source.sourceId}
                      aria-label={`Inspect external source ${source.label}`}
                    >
                      <strong>{source.label}</strong>
                      <span>
                        {source.kind} · rev {source.revision} · {source.adapterId}
                      </span>
                      <span className="mc-next-ext-source-row-chips">
                        <StatusChip
                          tone={
                            source.status === "active"
                              ? "success"
                              : source.status === "disabled"
                                ? "warning"
                                : "critical"
                          }
                        >
                          {source.status}
                        </StatusChip>
                        {source.latestScan ? (
                          <StatusChip tone={source.latestScan.status === "sealed" ? "muted" : "warning"}>
                            {`Scan ${source.latestScan.status} · ${source.latestScan.supportedItemCount}/${source.latestScan.itemCount}`}
                          </StatusChip>
                        ) : (
                          <StatusChip tone="muted">Never scanned</StatusChip>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </NativeCard>

          {detail ? (
            <NativeCard
              title={detail.source.label}
              subtitle="Operator-only source detail: the exact registered root, adapter binding, and sealed scan health."
              stats={[
                { label: "Revision", value: String(detail.source.revision) },
                { label: "Status", value: detail.source.status },
              ]}
              actions={
                <NativeButton
                  variant="default"
                  onClick={handleScan}
                  disabled={busy || detail.source.status !== "active"}
                  aria-label={`Run a sealed catalog scan of ${detail.source.label}`}
                >
                  {busyKey === "scan" ? "Scanning…" : "Run scan"}
                </NativeButton>
              }
            >
              <LibraryMetricGrid
                items={[
                  { label: "Root", value: detail.source.kind, meta: detail.source.canonicalRootPath },
                  {
                    label: "Adapter",
                    value: detail.source.adapterId,
                    meta: `Accepted producers: ${detail.source.adapterPolicy.acceptedProducerVersions.join(", ") || "none"}`,
                  },
                  {
                    label: "Latest scan",
                    value: detail.latestScan ? detail.latestScan.status : "never",
                    meta: detail.latestScan
                      ? `${detail.latestScan.supportedItemCount} supported / ${detail.latestScan.quarantinedItemCount} quarantined · ${formatDateTime(detail.latestScan.completedAt)}`
                      : "Run a scan to seal an immutable catalog.",
                  },
                ]}
              />
              {catalog ? (
                <CatalogTable
                  catalog={catalog}
                  selectedItemIds={selectedItemIds}
                  busy={busy}
                  onToggleItem={handleToggleItem}
                  onLoadMore={
                    catalog.nextCursor
                      ? () =>
                          void runAction("catalog-more", async (isCurrent) => {
                            await loadCatalogPage(catalog.sourceId, catalog.scanId, isCurrent, catalog.nextCursor);
                            return null;
                          })
                      : null
                  }
                />
              ) : (
                <EmptyState
                  size="compact"
                  title="No sealed catalog page is loaded."
                  description="Seal a scan to inspect its immutable items."
                />
              )}
              <div className="mc-next-settings-button-row">
                <NativeButton
                  variant="outline"
                  onClick={handleDryRun}
                  disabled={busy || selectedItemIds.length === 0}
                  aria-label="Create a dry-run import plan for the selected items"
                >
                  {busyKey === "plan" ? "Planning…" : `Dry run (${selectedItemIds.length} selected)`}
                </NativeButton>
                <NativeButton
                  variant="default"
                  onClick={handleApply}
                  disabled={busy || !plan || plan.plan.blockerCodes.length > 0}
                  aria-label="Apply the sealed import plan exactly"
                >
                  {busyKey === "apply" ? "Applying…" : "Apply import"}
                </NativeButton>
              </div>
              {plan ? (
                <LibraryMetricGrid
                  items={[
                    {
                      label: "Plan",
                      value: shortHash(plan.plan.planSha256),
                      meta: `${plan.plan.selectedItemIds.length} item(s) · ${plan.plan.normalizedByteCount} normalized bytes`,
                    },
                    {
                      label: "Raw set",
                      value: shortHash(plan.plan.rawSetSha256),
                      meta: `${plan.plan.rawByteCount} raw bytes · ${plan.plan.messageCount} messages`,
                    },
                    {
                      label: "Blockers",
                      value: String(plan.plan.blockerCodes.length),
                      meta: plan.plan.blockerCodes.join(", ") || "None — apply is available.",
                    },
                  ]}
                />
              ) : null}
            </NativeCard>
          ) : null}

          <NativeCard
            title="Import provenance"
            subtitle="Content-free settlement and per-item provenance for one applied import."
          >
            <LibraryFieldGrid>
              <LibraryField label="Import id">
                <input
                  className="mc-next-settings-input"
                  value={importLookupId}
                  onChange={(event) => setImportLookupId(event.target.value)}
                  placeholder="external-import-…"
                />
              </LibraryField>
            </LibraryFieldGrid>
            <div className="mc-next-settings-button-row">
              <NativeButton
                variant="outline"
                onClick={handleImportLookup}
                disabled={busy || !importLookupId.trim()}
                aria-label="Inspect import provenance"
              >
                {busyKey === "import-lookup" ? "Loading…" : "Inspect import"}
              </NativeButton>
            </div>
            {importDetail ? <ImportProvenance detail={importDetail} /> : null}
          </NativeCard>
        </div>
      )}
    </LibrarySectionShell>
  );
}

function RegisterSourceForm({
  draft,
  busy,
  formInstanceId,
  onChange,
  onSubmit,
}: {
  draft: RegisterDraft;
  busy: boolean;
  formInstanceId: string;
  onChange: (next: RegisterDraft) => void;
  onSubmit: () => void;
}) {
  const wslSelected = draft.inputFlavor === "wsl" || draft.targetFlavor === "wsl";
  const ready =
    draft.label.trim() !== "" &&
    draft.canonicalRootPath.trim() !== "" &&
    draft.pathBridgeSnapshotId.trim() !== "" &&
    draft.pathBridgeSnapshotSha256.trim() !== "" &&
    (!wslSelected || draft.distro.trim() !== "") &&
    (!draft.requireGitIdentity || draft.gitIdentitySha256.trim() !== "");
  const setField = <K extends keyof RegisterDraft>(key: K, value: RegisterDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <fieldset className="mc-next-ext-source-register" disabled={busy}>
      <legend>Register an exact read root</legend>
      <LibraryFieldGrid>
        <LibraryField label="Kind">
          <select
            className="mc-next-settings-input"
            value={draft.kind}
            onChange={(event) => setField("kind", event.target.value as ExternalSourceKind)}
          >
            {SOURCE_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </LibraryField>
        <LibraryField label="Label">
          <input
            className="mc-next-settings-input"
            value={draft.label}
            onChange={(event) => setField("label", event.target.value)}
          />
        </LibraryField>
        <LibraryField label="Canonical root path" span={2}>
          <input
            className="mc-next-settings-input"
            value={draft.canonicalRootPath}
            onChange={(event) => setField("canonicalRootPath", event.target.value)}
            placeholder="Exact verified root; symlinks are never followed"
          />
        </LibraryField>
        <LibraryField label="Path-bridge snapshot id">
          <input
            className="mc-next-settings-input"
            value={draft.pathBridgeSnapshotId}
            onChange={(event) => setField("pathBridgeSnapshotId", event.target.value)}
          />
        </LibraryField>
        <LibraryField label="Path-bridge snapshot sha256">
          <input
            className="mc-next-settings-input"
            value={draft.pathBridgeSnapshotSha256}
            onChange={(event) => setField("pathBridgeSnapshotSha256", event.target.value)}
          />
        </LibraryField>
        <LibraryField label="Input flavor">
          <select
            className="mc-next-settings-input"
            value={draft.inputFlavor}
            onChange={(event) => setField("inputFlavor", event.target.value as WorkspacePathFlavor)}
          >
            {PATH_FLAVORS.map((flavor) => (
              <option key={flavor} value={flavor}>
                {flavor}
              </option>
            ))}
          </select>
        </LibraryField>
        <LibraryField label="Target flavor">
          <select
            className="mc-next-settings-input"
            value={draft.targetFlavor}
            onChange={(event) => setField("targetFlavor", event.target.value as WorkspacePathFlavor)}
          >
            {PATH_FLAVORS.map((flavor) => (
              <option key={flavor} value={flavor}>
                {flavor}
              </option>
            ))}
          </select>
        </LibraryField>
        {wslSelected ? (
          <LibraryField label="WSL distro">
            <input
              className="mc-next-settings-input"
              value={draft.distro}
              onChange={(event) => setField("distro", event.target.value)}
            />
          </LibraryField>
        ) : null}
        <LibraryField label="Accepted producer versions" span={2}>
          <input
            className="mc-next-settings-input"
            value={draft.acceptedProducerVersions}
            onChange={(event) => setField("acceptedProducerVersions", event.target.value)}
            placeholder="Comma-separated; unlisted producers stay unsupported"
          />
        </LibraryField>
        <LibraryField label="Expected workspace revision">
          <input
            className="mc-next-settings-input"
            inputMode="numeric"
            value={draft.expectedWorkspaceRevision}
            onChange={(event) => setField("expectedWorkspaceRevision", event.target.value)}
          />
        </LibraryField>
      </LibraryFieldGrid>
      <label className="mc-next-ext-source-checkbox" htmlFor={`${formInstanceId}-git`}>
        <input
          id={`${formInstanceId}-git`}
          type="checkbox"
          checked={draft.requireGitIdentity}
          onChange={(event) => setField("requireGitIdentity", event.target.checked)}
        />
        Require a verified Git identity for this root
      </label>
      {draft.requireGitIdentity ? (
        <LibraryFieldGrid>
          <LibraryField label="Git identity sha256" span={2}>
            <input
              className="mc-next-settings-input"
              value={draft.gitIdentitySha256}
              onChange={(event) => setField("gitIdentitySha256", event.target.value)}
            />
          </LibraryField>
        </LibraryFieldGrid>
      ) : null}
      <div className="mc-next-settings-button-row">
        <NativeButton variant="default" onClick={onSubmit} disabled={busy || !ready} aria-label="Register the source">
          Register source
        </NativeButton>
      </div>
    </fieldset>
  );
}

function CatalogTable({
  catalog,
  selectedItemIds,
  busy,
  onToggleItem,
  onLoadMore,
}: {
  catalog: ExternalSourcePage;
  selectedItemIds: readonly string[];
  busy: boolean;
  onToggleItem: (item: ExternalSourceCatalogItem) => void;
  onLoadMore: (() => void) | null;
}) {
  return (
    <div className="mc-next-ext-source-catalog">
      <h4>Sealed catalog ({catalog.items.length} loaded)</h4>
      <ul role="list" className="mc-next-ext-source-list">
        {catalog.items.map((item) => {
          const selectable = item.disposition === "supported";
          const selected = selectedItemIds.includes(item.itemId);
          return (
            <li key={item.itemId} className="mc-next-ext-source-item">
              <label className="mc-next-ext-source-checkbox">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={busy || !selectable}
                  onChange={() => onToggleItem(item)}
                  aria-label={`Select ${item.normalizedRelativePath} for import`}
                />
                <span className="mc-next-ext-source-item-path">{item.normalizedRelativePath}</span>
              </label>
              <span className="mc-next-ext-source-item-meta">
                {item.messageCount} messages · raw {shortHash(item.rawSha256)} ·{" "}
                {item.producerVersion ?? "unknown producer"}
              </span>
              <StatusChip
                tone={selectable ? "success" : item.disposition === "unsupported_variant" ? "warning" : "critical"}
                title={item.reasonCodes.join(", ") || undefined}
              >
                {item.disposition}
              </StatusChip>
            </li>
          );
        })}
      </ul>
      {onLoadMore ? (
        <NativeButton variant="ghost" onClick={onLoadMore} disabled={busy} aria-label="Load more catalog items">
          Load more items
        </NativeButton>
      ) : null}
    </div>
  );
}

function ImportProvenance({ detail }: { detail: ExternalSourceImportDetailResponse }) {
  return (
    <div className="mc-next-ext-source-provenance">
      <LibraryMetricGrid
        items={[
          {
            label: "Import",
            value: detail.intent.importId,
            meta: `Plan ${shortHash(detail.intent.planSha256)} · admitted ${formatDateTime(detail.intent.admittedAt)}`,
          },
          {
            label: "Settlement",
            value: detail.settlement?.disposition ?? "pending",
            meta: detail.settlement
              ? `Result ${shortHash(detail.settlement.resultSha256)} · ${formatDateTime(detail.settlement.settledAt)}`
              : "No terminal settlement is recorded yet.",
          },
          {
            label: "Items",
            value: String(detail.items.length),
            meta: `${detail.plan.normalizedByteCount} normalized bytes`,
          },
        ]}
      />
      <ul role="list" className="mc-next-ext-source-list">
        {detail.items.map((item) => (
          <li key={item.itemId} className="mc-next-ext-source-item">
            <span className="mc-next-ext-source-item-path">{item.itemId}</span>
            <span className="mc-next-ext-source-item-meta">
              raw {shortHash(item.rawSha256)} · normalized {shortHash(item.normalizedArtifactSha256)} ·{" "}
              {item.normalizedByteCount} bytes
            </span>
            <StatusChip tone="muted" title={item.artifactRelativeKey}>
              managed artifact
            </StatusChip>
          </li>
        ))}
      </ul>
      <p className="mc-next-ext-source-footnote">
        Attach these items to a Chat session read-only from the Chat composer. A durable knowledge copy is a separate
        governed approval; nothing here mutates knowledge or memory directly.
      </p>
    </div>
  );
}
