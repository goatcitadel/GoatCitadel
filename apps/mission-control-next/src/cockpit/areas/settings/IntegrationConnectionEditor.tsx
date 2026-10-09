import { useState } from "react";
import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { IntegrationFormFields, integrationInputClass } from "./IntegrationFormFields";

export function IntegrationConnectionEditor({ owner: s }: { owner: IntegrationSettingsOwner }) {
  const creating = s.panel === "create";
  const [enabled, setEnabled] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const signature = JSON.stringify([
    s.activeWorkspaceId,
    s.panel,
    s.createCatalogId,
    s.selectedConnection?.revision,
    s.createDraft.value,
    s.detailDraft.value,
    s.showCreateJson,
    s.showDetailJson,
    enabled,
  ]);
  const blocked =
    s.saving ||
    (creating
      ? s.createMutation.locked || !s.createCatalogId
      : s.connectionMutation.locked || s.detailDraft.hasRemoteChanges || s.review.required || !s.selectedConnection);
  const json = creating ? s.showCreateJson : s.showDetailJson;
  return (
    <section
      aria-label={creating ? "New integration connection" : "Edit integration connection"}
      className="space-y-4 rounded-md border border-line p-4"
    >
      <h3 className="font-semibold">
        {creating ? "Add integration" : `Edit ${s.selectedConnection?.label ?? "connection"}`}
      </h3>
      {!creating && (s.detailDraft.hasRemoteChanges || s.review.required) ? (
        <section aria-label="Changed integration review" className="space-y-2 text-sm">
          <p role="alert">The saved connection changed. Your draft is retained.</p>
          {s.review.error ? <p role="alert">{s.review.error}</p> : null}
          <Button onClick={() => void s.review.refresh()}>Reload connection review</Button>
          <Button
            disabled={s.review.loading || Boolean(s.review.error) || s.review.missing}
            onClick={() => {
              s.detailDraft.rebaseToCurrent();
              s.review.accept();
            }}
          >
            Use current connection review
          </Button>
          <p className="break-all">Current revision: {s.selectedConnection?.revision ?? "Unavailable"}</p>
        </section>
      ) : null}
      {creating ? (
        <label className="block text-sm">
          Integration catalog
          <select
            aria-label="Integration catalog"
            className={integrationInputClass}
            disabled={s.saving}
            value={s.createCatalogId}
            onChange={(e) => s.createCatalogGuard.requestTransition(e.target.value)}
          >
            {s.createableCatalog.map((item) => (
              <option key={item.catalogId} value={item.catalogId}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="block text-sm">
        Connection label
        <input
          aria-label="Integration connection label"
          className={integrationInputClass}
          value={creating ? s.createLabel : s.detailForm.label}
          disabled={s.saving}
          onChange={(e) =>
            creating
              ? s.setCreateLabel(e.target.value)
              : s.setDetailForm((current) => ({ ...current, label: e.target.value }))
          }
        />
      </label>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          disabled={s.saving}
          checked={creating ? enabled : s.detailForm.enabled}
          onChange={(e) =>
            creating
              ? setEnabled(e.target.checked)
              : s.setDetailForm((current) => ({ ...current, enabled: e.target.checked }))
          }
        />
        Integration connection enabled
      </label>
      {!creating ? (
        <label className="block text-sm">
          Saved status
          <select
            aria-label="Integration saved status"
            className={integrationInputClass}
            disabled={s.saving}
            value={s.detailForm.status}
            onChange={(e) => s.setDetailForm((current) => ({ ...current, status: e.target.value }))}
          >
            {["connected", "disconnected", "paused", "error"].map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
          <span className="text-xs text-fg-muted">
            This edits saved metadata. It does not prove external connectivity.
          </span>
        </label>
      ) : null}
      {json ? (
        <label className="block text-sm">
          Advanced configuration JSON
          <textarea
            aria-label="Advanced integration configuration JSON"
            className={`${integrationInputClass} font-mono`}
            rows={8}
            readOnly
            disabled={s.saving}
            value={creating ? s.createConfig : s.detailForm.configText}
          />
          <span className="text-xs text-fg-muted">Inspection only. Use the supported typed fields; credential input belongs to its secure setup owner.</span>
        </label>
      ) : (
        <IntegrationFormFields
          schema={creating ? s.createSchema : s.detailSchema}
          value={creating ? s.createGuidedConfig : s.detailGuidedConfig}
          onChange={creating ? s.setCreateGuidedConfig : s.setDetailGuidedConfig}
          disabled={s.saving}
        />
      )}
      <p className="text-xs text-fg-muted">
        Configuration belongs to this Gateway installation. Redacted saved credentials are preserved by the Gateway;
        they are never shown in the review.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={s.saving} onClick={creating ? s.toggleCreateJson : s.toggleDetailJson}>
          {json ? "Use guided fields" : "Inspect public configuration"}
        </Button>
        <Button variant="primary" disabled={Boolean(blocked)} onClick={() => setReview(signature)}>
          {creating ? "Review new connection" : "Review connection changes"}
        </Button>
        <Button onClick={s.closePanel}>Close editor</Button>
      </div>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title={creating ? "Create this integration connection?" : "Apply integration connection changes?"}
        description="This saves Gateway configuration and requests runtime synchronization. It does not run an advertised operator action or test external connectivity."
      >
        <p className="break-words text-sm">
          {creating ? s.createLabel || s.selectedCatalog?.label : s.detailForm.label} ·{" "}
          {creating ? (enabled ? "Enabled" : "Disabled") : s.detailForm.enabled ? "Enabled" : "Disabled"}
        </p>
        <p className="mt-2 break-all text-xs text-fg-muted">
          {creating
            ? `Catalog: ${s.createCatalogId}. Creation has no resource revision precondition.`
            : `Reviewed saved revision: ${s.detailDraft.baseRevision}. The Gateway enforces this exact revision.`}
        </p>
        {review !== signature ? <p role="alert">The reviewed input changed. Close and review again.</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={Boolean(blocked) || review !== signature}
            onClick={() => {
              setReview(null);
              void (creating ? s.handleCreate(enabled) : s.handleSave());
            }}
          >
            Apply reviewed connection
          </Button>
          <Button onClick={() => setReview(null)}>Keep current connection</Button>
        </div>
      </Dialog>
    </section>
  );
}
