import { useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { DraftLeaveDialog } from "../../library/DraftLeaveDialog";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { FocusedDetail } from "../../shared/FocusedDetail";
import {
  SettingsButtonRow,
  SettingsField,
  SettingsLoadWarnings,
  SettingsStack,
  type SettingsSectionProps,
} from "../SettingsShared";
import { usePortablePacks } from "./use-portable-packs";
import type { CapabilityPackPreview } from "@goatcitadel/contracts";
import { PackExecutionPanel } from "./PackExecutionPanel";

export function PortablePacksSection(props: SettingsSectionProps) {
  const owner = usePortablePacks(props.activeWorkspaceId),
    [limit, setLimit] = useState(30),
    [stagedLimit, setStagedLimit] = useState(20);
  const { review } = owner;
  return (
    <SettingsStack>
      <p>
        Capability pack staging and review record installation evidence only. Policy defaults are advisory. No
        capability is installed, enabled, connected or invoked by staging.
      </p>
      <SettingsButtonRow>
        <NativeButton disabled={owner.loading} onClick={() => void owner.reload()}>
          Refresh packs
        </NativeButton>
        <NativeButton onClick={() => owner.open({ kind: "portable" })}>
          Import pack{owner.draft.isDirty ? " · Unsaved" : ""}
        </NativeButton>
      </SettingsButtonRow>
      {owner.loading ? <p role="status">Reading pack evidence…</p> : null}
      {owner.error ? <p role="alert">{owner.error}</p> : null}
      <SettingsLoadWarnings issues={owner.data?.issues ?? []} onRetry={owner.reload} />
      {owner.notice ? <p role="status">{owner.notice}</p> : null}
      {owner.attempt.message ? <p role="alert">{owner.attempt.message}</p> : null}
      {owner.view ? (
        <FocusedDetail
          title={owner.view.kind === "portable" ? "Portable pack" : (owner.preview?.manifest.name ?? "Capability pack")}
          onClose={() => owner.open(null)}
        >
          <SettingsStack>
            {owner.view.kind === "portable" ? (
              <>
                <p>
                  Preview a local_file manifest before staging. Do not include credentials or private endpoint values.
                  Input remains in this app-session draft; local hashes are declared metadata, not independently
                  verified bytes.
                </p>
                <SettingsField label="Manifest file">
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void owner.importFile(file);
                    }}
                  />
                </SettingsField>
                <SettingsField label="Manifest JSON">
                  <textarea
                    className="mc-next-settings-textarea mc-next-settings-code"
                    rows={8}
                    value={owner.draft.value}
                    maxLength={owner.inputLimit}
                    onChange={(event) => owner.setSource(event.target.value)}
                  />
                </SettingsField>
                <NativeButton
                  disabled={owner.previewBusy || !owner.draft.value.trim()}
                  onClick={() => void owner.previewLocal()}
                >
                  Preview local pack
                </NativeButton>
              </>
            ) : null}
            {owner.previewBusy ? <p role="status">Reading Gateway preview…</p> : null}
            {owner.preview ? (
              <>
                <ClassicPackPreview preview={owner.preview} />
                <SettingsButtonRow>
                  <NativeButton disabled={owner.locked} onClick={owner.requestStage}>
                    Review pack staging
                  </NativeButton>
                  <NativeButton disabled={owner.exportBusy} onClick={() => void owner.exportPreview()}>
                    Export manifest
                  </NativeButton>
                </SettingsButtonRow>
                {owner.preview.manifest.provenance.source === "bundled" ? (
                  <PackExecutionPanel
                    manifest={owner.preview.manifest}
                    workspaceId={props.activeWorkspaceId}
                    navigate={props.navigate}
                    route={props.route}
                  />
                ) : (
                  <p>Portable manifests are staging-only. This does not establish a verified execution binding.</p>
                )}
              </>
            ) : null}
            {owner.exported ? (
              <NativeDisclosureCard id="pack-export-projection" title="Read-only export">
                <p>{owner.exported.manifest.name}: no mutation.</p>
                <pre className="mc-next-settings-code">{JSON.stringify(owner.exported, null, 2)}</pre>
              </NativeDisclosureCard>
            ) : null}
          </SettingsStack>
        </FocusedDetail>
      ) : (
        <NativeCard title="Capability packs" subtitle="Bundled catalog">
          <NativeSelectableList
            items={(owner.data?.packs ?? [])
              .slice(0, limit)
              .map((pack) => ({
                id: pack.packId,
                title: pack.name,
                meta: pack.trustTier,
                body: `${pack.version} · ${pack.assets.length} assets`,
              }))}
            onSelect={(id) => owner.open({ kind: "catalog", packId: id })}
            emptyLabel="No bundled packs returned."
          />
          {(owner.data?.packs.length ?? 0) > limit ? (
            <NativeButton onClick={() => setLimit((value) => value + 30)}>Show more packs</NativeButton>
          ) : null}
        </NativeCard>
      )}
      <NativeDisclosureCard
        id="pack-staged-evidence"
        title="Recent staged evidence"
        subtitle="A bounded sample from the latest 100 installation evidence envelopes; not a complete history or readiness count."
      >
        {(owner.data?.staged ?? []).slice(0, stagedLimit).map((item, index) => (
          <div key={item.evidenceEnvelopeId ?? `unbound-${index}`}>
            <p>
              <strong>{item.name}</strong> · {item.version} · {item.stagedAt}
            </p>
            <p>
              {item.latestMaterialization
                ? "Review evidence recorded; callable state unchanged."
                : "Staged for review; no activation established."}
            </p>
            <NativeButton
              disabled={owner.locked || !item.evidenceEnvelopeId || !item.stagedAssets.length}
              onClick={() => owner.requestRecord(item)}
            >
              Review evidence for {item.name}
            </NativeButton>
          </div>
        ))}
        {(owner.data?.staged.length ?? 0) > stagedLimit ? (
          <NativeButton onClick={() => setStagedLimit((value) => value + 20)}>Show more staged records</NativeButton>
        ) : null}
      </NativeDisclosureCard>
      <ConfirmModal
        open={Boolean(review)}
        title={review?.kind === "record" ? "Record pack review evidence" : "Stage reviewed pack"}
        message={
          review?.kind === "record"
            ? `Record review for every asset in ${review.staged.name}, evidence ${review.staged.evidenceEnvelopeId}. Unsupported assets stay blocked. Callable state and runtime policy are unchanged.`
            : `Stage ${review?.preview.manifest.name ?? "this pack"}. The exact owner preview is re-read before this non-CAS append-only evidence request; its receipt and saved evidence are checked afterward. No capabilities are activated.`
        }
        confirmLabel={review?.kind === "record" ? "Record reviewed evidence" : "Stage reviewed pack"}
        cancelLabel="Cancel pack review"
        pending={owner.attempt.phase === "pending"}
        confirmDisabled={owner.locked}
        onConfirm={() => void owner.confirm()}
        onCancel={owner.cancelReview}
      />
      <DraftLeaveDialog {...owner.leave.dialogProps} />
    </SettingsStack>
  );
}

function ClassicPackPreview({ preview }: { preview: CapabilityPackPreview }) {
  const [limit, setLimit] = useState(30),
    { manifest } = preview;
  return (
    <NativeCard title={manifest.name} subtitle={`${manifest.version} · ${manifest.trustTier}`}>
      <p>{manifest.description}</p>
      <p>Publisher: {manifest.provenance.publisher}</p>
      <p>
        Advisory defaults: first-use approval{" "}
        {preview.policyChanges.requireFirstUseApproval ? "required" : "not requested"}; memory{" "}
        {preview.policyChanges.memoryWriteAuthority.replaceAll("_", " ")}; redaction{" "}
        {preview.policyChanges.redactionMode}. These labels do not change policy.
      </p>
      <ul>
        {preview.installPlan.slice(0, limit).map((asset) => (
          <li key={asset.assetId}>
            <strong>{manifest.assets.find((item) => item.id === asset.assetId)?.label ?? asset.assetId}</strong> ·{" "}
            {asset.outcome.replaceAll("_", " ")}
            <p>{asset.reason}</p>
          </li>
        ))}
      </ul>
      {preview.installPlan.length > limit ? (
        <NativeButton onClick={() => setLimit((value) => value + 30)}>Show more preview assets</NativeButton>
      ) : null}
      <NativeDisclosureCard id="pack-warnings-identity" title="Warnings and declared identity">
        <ul>
          {manifest.installWarnings.slice(0, 50).map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
        <code>{manifest.packId}</code>
        <p>
          <code>{manifest.provenance.contentHash ?? "No declared hash"}</code>
        </p>
      </NativeDisclosureCard>
    </NativeCard>
  );
}
