import { useState } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { usePortablePacks } from "../../../features/native-routes/settings/sections/use-portable-packs";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";
import { Sheet } from "../../ui/Sheet";
import { PortablePackPreview, PortablePackStagedEvidence } from "./PortablePackEvidence";
import { PortablePackSetup } from "./PortablePackSetup";
import { useCockpitRoute } from "../../app/use-cockpit-route";

const inputClass =
  "mt-1 block w-full rounded-md border border-line-control bg-canvas px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent";
// Text boxes keep 16px text on phones so iOS does not zoom on focus; desktop keeps the dense mono size.
const textareaClass =
  "mt-1 block w-full rounded-md border border-line-control bg-canvas px-3 py-2 font-mono text-md text-fg focus-visible:outline-2 focus-visible:outline-accent sm:text-xs";
export function PortablePacksSettings() {
  const { activeWorkspaceId } = useUiPreferences();
  return <PortablePacksContent key={activeWorkspaceId} workspaceId={activeWorkspaceId ?? ""} />;
}
function PortablePacksContent({ workspaceId }: { workspaceId: string }) {
  const { navigate } = useCockpitRoute();
  const owner = usePortablePacks(workspaceId);
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(30);
  const items = (owner.data?.packs ?? []).filter((item) =>
    `${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pending = owner.attempt.phase === "pending";
  return (
    <section
      aria-label="Portable capability packs"
      id="portable-capability-packs"
      className="space-y-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <header>
        <h3 className="text-base font-semibold text-fg">Capability packs</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Inspect bundled packs or preview a portable manifest. Staging and recording review add installation records
          only; they do not install, enable, connect or invoke capabilities.
        </p>
        <p className="mt-2 text-xs text-fg-muted">
          Policy defaults are advisory labels. Portable content hashes are declared metadata, not independently verified
          bytes. GoatCitadel policy and its usual checks still apply.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button disabled={owner.loading || pending} onClick={() => void owner.reload()}>
          Refresh packs
        </Button>
        <Button onClick={() => owner.open({ kind: "portable" })}>
          Import portable pack{owner.draft.isDirty ? " · Unsaved" : ""}
        </Button>
      </div>
      {owner.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading packs…
        </p>
      ) : null}
      {owner.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {owner.error}
        </p>
      ) : null}
      {owner.data?.issues.map((issue) => (
        <p role="alert" key={issue.label} className="text-sm text-status-failed">
          {issue.message}
        </p>
      ))}
      {owner.notice ? (
        <p role="status" className="break-words text-sm text-fg-secondary">
          {owner.notice}
        </p>
      ) : null}
      {owner.attempt.message ? (
        <p role="alert" className="text-sm text-status-waiting">
          {owner.attempt.message}
        </p>
      ) : null}
      <label className="block text-sm text-fg-secondary">
        Find capability pack
        <input
          type="search"
          value={query}
          className={inputClass}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(30);
          }}
        />
      </label>
      <ul className="divide-y divide-line-subtle">
        {items.slice(0, limit).map((pack) => (
          <li key={pack.packId} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h4 className="break-words text-sm font-semibold text-fg">{pack.name}</h4>
                <p className="mt-1 break-words text-sm text-fg-secondary">{pack.description}</p>
                <p className="mt-1 text-xs text-fg-muted">
                  {pack.version} · {pack.assets.length} assets · {pack.trustTier}
                </p>
              </div>
              <Button size="sm" onClick={() => owner.open({ kind: "catalog", packId: pack.packId })}>
                Inspect {pack.name}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!owner.loading && owner.data && !items.length ? (
        <p className="text-sm text-fg-muted">No matching bundled packs returned.</p>
      ) : null}
      {items.length > limit ? <Button onClick={() => setLimit((value) => value + 30)}>Show more packs</Button> : null}
      <PortablePackStagedEvidence owner={owner} />
      <Sheet
        open={Boolean(owner.view)}
        sideOnDesktop
        title={
          owner.view?.kind === "portable"
            ? "Import portable pack"
            : (owner.preview?.manifest.name ?? "Inspect capability pack")
        }
        onOpenChange={(open) => {
          if (!open) owner.open(null);
        }}
      >
        <div className="space-y-4">
          {owner.view?.kind === "portable" ? (
            <>
              <p className="text-sm text-fg-secondary">
                Choose a local_file manifest for GoatCitadel to validate. Previewing is read-only. Do not include
                credentials or private endpoint values in portable metadata.
              </p>
              <label className="block text-sm text-fg-secondary">
                Manifest file
                <input
                  type="file"
                  accept=".json,application/json"
                  className={inputClass}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void owner.importFile(file);
                  }}
                />
              </label>
              <details>
                <summary className="cursor-pointer text-sm text-fg-secondary">
                  Advanced: paste or inspect manifest JSON
                </summary>
                <label className="mt-2 block text-sm text-fg-secondary">
                  Portable manifest JSON
                  <textarea
                    maxLength={owner.inputLimit}
                    rows={8}
                    className={textareaClass}
                    value={owner.draft.value}
                    onChange={(event) => owner.setSource(event.target.value)}
                  />
                </label>
              </details>
              <p className="text-xs text-fg-muted">
                {owner.draft.value.length.toLocaleString()} characters in this app-session draft.
              </p>
              <Button
                disabled={owner.previewBusy || !owner.draft.value.trim()}
                onClick={() => void owner.previewLocal()}
              >
                Preview portable manifest
              </Button>
            </>
          ) : null}
          {owner.previewBusy ? (
            <p role="status" className="text-sm text-fg-muted">
              Reading the preview…
            </p>
          ) : null}
          {owner.notice ? (
            <p role="status" className="text-sm text-fg-secondary">
              {owner.notice}
            </p>
          ) : null}
          {owner.attempt.message ? (
            <p role="alert" className="text-sm text-status-waiting">
              {owner.attempt.message}
            </p>
          ) : null}
          {owner.preview ? (
            <>
              <PortablePackPreview preview={owner.preview} />
              <div className="flex flex-wrap gap-2">
                <Button disabled={owner.locked || owner.previewBusy} onClick={owner.requestStage}>
                  Review pack staging
                </Button>
                <Button disabled={owner.exportBusy} onClick={() => void owner.exportPreview()}>
                  Prepare read-only export
                </Button>
              </div>
              {owner.preview.manifest.provenance.source === "bundled" ? (
                <PortablePackSetup
                  key={owner.preview.manifest.packId}
                  manifest={owner.preview.manifest}
                  workspaceId={workspaceId}
                  onInspect={(url) => owner.leave.request(() => navigate(url))}
                />
              ) : (
                <p className="text-sm text-fg-muted">
                  Local portable manifests are for inspection and records only. Setup uses the bundled definitions.
                </p>
              )}
            </>
          ) : null}
          {owner.exported ? (
            <section aria-label="Read-only pack export" className="space-y-2 text-sm text-fg-secondary">
              <p>{owner.exported.manifest.name} export prepared. No mutation occurred.</p>
              <details>
                <summary className="cursor-pointer">Export JSON</summary>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-canvas p-3 font-mono text-xs">
                  {JSON.stringify(owner.exported, null, 2)}
                </pre>
              </details>
            </section>
          ) : null}
          <Button onClick={() => owner.open(null)}>Close pack inspection</Button>
        </div>
      </Sheet>
      <Dialog
        open={Boolean(owner.review)}
        title={owner.review?.kind === "record" ? "Record pack review" : "Stage reviewed pack"}
        description="This adds an installation record only. Capability availability, tools and runtime policy are unchanged."
        onOpenChange={(open) => {
          if (!open && !pending) owner.cancelReview();
        }}
      >
        {owner.review ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              {owner.review.kind === "stage" ? owner.review.preview.manifest.name : owner.review.staged.name}
            </p>
            <p className="text-sm text-fg-secondary">
              {owner.review.kind === "stage"
                ? "The preview is read again before staging, but changes made in the meantime are not blocked. The saved result is checked afterward."
                : "Record review for every asset in this staged record. Unsupported assets stay blocked; turning capabilities on still needs its own review."}
            </p>
            <code className="block break-all font-mono text-xs text-fg-muted">
              {owner.review.kind === "stage"
                ? owner.review.preview.manifest.packId
                : owner.review.staged.evidenceEnvelopeId}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button disabled={owner.locked} onClick={() => void owner.confirm()}>
                {owner.review.kind === "stage" ? "Stage reviewed pack" : "Record pack review"}
              </Button>
              <Button disabled={pending} onClick={owner.cancelReview}>
                Cancel pack review
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
      <UnsavedChangesDialog {...owner.leave.dialogProps} warning="Saving requires explicit pack review." />
    </section>
  );
}
