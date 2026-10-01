import { useId } from "react";
import { Check, Download, Upload, X } from "lucide-react";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { useCitadelBlueprint } from "./use-citadel-blueprint";
import { buildBlueprintProofItems, downloadBlueprint } from "./citadel-blueprint-artifact";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import "./citadel-confirmation.css";

export function CitadelBlueprintRoutePage({ route, activeCitadelId = "default", activeCitadelName = "this Citadel" }: NativeRoutePagesProps) {
  const importId = useId();
  const control = useCitadelBlueprint(activeCitadelId);
  const { exportState, importState, view, setView, confirmImport, setConfirmImport, reviewedTarget, validatedText,
    importText, blueprintDraft, leave, canApply, validate, applyImport, loadExportForImport, exportNotice } = control;
  const exportProofItems = buildBlueprintProofItems(exportState.json, activeCitadelId);
  const downloadExport = () => {
    if (!exportState.json) return;
    downloadBlueprint(exportState.json, activeCitadelId);
    control.setExportNotice("Blueprint downloaded as a secret-free JSON file.");
  };
  return (
    <NativePageFrame
      icon={Download}
      area="library"
      kicker={routeKicker(route)}
      title="Blueprint"
      description={`Export ${activeCitadelName} as a portable, secret-free Blueprint, or import one. Imports are validated and secret-scanned before they apply.`}
      loading={exportState.loading}
      error={exportState.error}
    >
      <div className="mc-next-settings-button-row" role="group" aria-label="Blueprint view">{(["export", "import"] as const).map((item) => <NativeButton key={item} variant="ghost" aria-pressed={view === item} onClick={() => leave.request(() => setView(item), [blueprintDraft.key])}>{item === "export" ? "Export" : `Import${blueprintDraft.isDirty ? " · Unsaved" : ""}`}</NativeButton>)}</div>
      <NativeGrid className="mc-next-calm-directory">
        {view === "export" ? <NativeCard title="Export" subtitle="The current Citadel as a Blueprint. Secrets are never included.">
          {exportState.staged && exportState.json ? (
            <>
              <NativeList items={exportProofItems} emptyLabel="No export proof available." density="compact" />
              <div className="mc-next-blueprint-actions">
                <NativeButton variant="default" onClick={downloadExport}>
                  <Download size={16} />
                  Download blueprint
                </NativeButton>
                <NativeButton variant="outline" onClick={loadExportForImport}>
                  <Upload size={16} />
                  Load export for import
                </NativeButton>
              </div>
              {exportNotice ? <NoticeBanner tone="success" message={exportNotice} /> : null}
              <details className="mc-next-inline-disclosure"><summary>Export preview</summary><pre className="mc-next-blueprint-json" aria-label="Exported Blueprint">
                {exportState.json}
              </pre></details>
            </>
          ) : (
            <EmptyState size="compact" title={`${activeCitadelName} needs a Charter before export.`} />
          )}
        </NativeCard> : null}

        {view === "import" ? <NativeCard
          title="Import"
          subtitle="Paste a Blueprint, validate it, then apply. Validation runs a schema check and a secret scan."
        >
          <label className="mc-next-mason-field" htmlFor={importId}>
            <span>Blueprint JSON</span>
            <textarea
              id={importId}
              className="mc-next-settings-textarea"
              value={importText}
              rows={6}
              disabled={control.locked || importState.busy}
              placeholder='{ "schemaVersion": "goatcitadel.blueprint.v1", ... }'
              onChange={(event) => control.changeText(event.target.value)}
            />
          </label>
          <div className="mc-next-blueprint-actions">
            <NativeButton variant="default" disabled={control.locked || importText.trim().length === 0 || importState.busy} onClick={() => void validate()}>
              <Check size={16} />
              Validate
            </NativeButton>
            <NativeButton variant="outline" disabled={!canApply} onClick={() => setConfirmImport(true)}>
              <Upload size={16} />
              {importState.busy ? "Importing…" : "Review import"}
            </NativeButton>
          </div>

          {importState.error ? <NoticeBanner tone="error" message={importState.error} /> : null}
          {importState.done ? <p className="mc-next-blueprint-ok">Blueprint imported.</p> : null}
          {reviewedTarget && validatedText === importText ? <NativeList items={[
            { title: "Current Charter", body: reviewedTarget.charter?.purpose ?? "No Charter yet" },
            { title: "Current Chambers", body: reviewedTarget.chambers.map((chamber) => `${chamber.name} (${chamber.sensitivity}${chamber.sealed ? ", sealed" : ""})`).join(" · ") || "None" },
            { title: "Import effect", body: "Replaces the Charter, clears its default Chamber selection, and adds the Blueprint's Chambers. Existing Chambers are retained." },
          ]} emptyLabel="No target review available." density="compact" /> : null}
          {reviewedTarget?.record?.lifecycleStatus === "archived" ? <NoticeBanner tone="warning" message="Restore this Citadel, then validate again before importing." /> : null}
          {importState.validation ? (
            importState.validation.ok ? (
              <p className="mc-next-blueprint-ok">
                <Check size={16} aria-hidden="true" />
                Blueprint valid — review its changes before importing.
              </p>
            ) : (
              <div className="mc-next-blueprint-errors">
                <p>
                  <X size={16} aria-hidden="true" />
                  Cannot import:
                </p>
                <NativeList
                  items={importState.validation.errors.map((message) => ({ title: message }))}
                  emptyLabel="Invalid."
                  density="compact"
                />
              </div>
            )
          ) : null}
        </NativeCard> : null}
      </NativeGrid>
      {control.attempt.message ? <NoticeBanner tone={control.attempt.phase === "uncertain" ? "error" : "info"} message={control.attempt.message} /> : null}
      {leave.dialog}
      <ConfirmModal className="mc-next-citadel-confirmation" open={confirmImport} title="Apply this Blueprint?" message={`Replace the Charter, clear its default Chamber selection, and add the Blueprint's Chambers in ${activeCitadelName}? Existing Chambers are retained. External connections and grants require their existing setup and approval steps.`} confirmLabel={importState.busy ? "Importing…" : "Apply Blueprint"} pending={importState.busy} disableDismiss={importState.busy} cancelDisabled={importState.busy} onCancel={() => setConfirmImport(false)} onConfirm={() => void applyImport()} />
    </NativePageFrame>
  );
}

export { buildBlueprintProofItems, downloadBlueprint } from "./citadel-blueprint-artifact";
