import { useState } from "react";
import type { CapabilityPackManifest } from "@goatcitadel/contracts";
import { usePackExecution } from "../../../features/native-routes/settings/sections/use-pack-execution";
import {
  PACK_SETUP_WARNING,
  packChildItem,
  packInboxUrl,
} from "../../../features/native-routes/settings/sections/pack-plan-presentation";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { PackPlanControls } from "./PackPlanControls";

export function PortablePackSetup({
  manifest,
  workspaceId,
  onInspect,
}: {
  manifest: CapabilityPackManifest;
  workspaceId: string;
  onInspect: (url: string) => void;
}) {
  const owner = usePackExecution(manifest, workspaceId),
    [limit, setLimit] = useState(30);
  const selected = owner.draft.value;
  return (
    <section aria-label="Governed pack setup" className="space-y-3 border-t border-line pt-4">
      <h4 className="font-display text-base font-semibold text-fg">Governed setup</h4>
      <p className="text-sm text-fg-secondary">{PACK_SETUP_WARNING}</p>
      <p className="text-xs text-fg-muted">
        Choose up to 32 bound assets. These apply to this workspace plan; some configured resources are shared across
        the installation.
      </p>
      {owner.draft.hasRemoteChanges ? (
        <p role="alert" className="text-sm text-status-waiting">
          The manifest changed while this selection was retained.{" "}
          <Button onClick={owner.draft.discard}>Use current manifest</Button>
        </p>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg">Setup assets</legend>
        {manifest.assets.slice(0, limit).map((asset) => (
          <label key={asset.id} className="flex min-h-9 items-start gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              className="mt-1 accent-accent"
              checked={selected.includes(asset.id)}
              disabled={
                !asset.binding ||
                owner.attempt.phase !== "idle" ||
                owner.draft.hasRemoteChanges ||
                (!selected.includes(asset.id) && selected.length >= 32)
              }
              onChange={(event) =>
                owner.setSelected(
                  event.target.checked ? [...selected, asset.id] : selected.filter((id) => id !== asset.id),
                )
              }
            />
            <span className="min-w-0 break-words">
              {asset.label.slice(0, 240)} ·{" "}
              {asset.binding ? asset.binding.owner.replaceAll("_", " ") : "execution unavailable"}
            </span>
          </label>
        ))}
      </fieldset>
      {manifest.assets.length > limit ? (
        <Button onClick={() => setLimit((value) => value + 30)}>Show more setup assets</Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!owner.ready} onClick={owner.reviewSetup}>
          Review setup plan
        </Button>
        <Button disabled={owner.loading || owner.attempt.phase === "pending"} onClick={() => void owner.refresh()}>
          Refresh setup records
        </Button>
      </div>
      {owner.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading setup records…
        </p>
      ) : null}
      {owner.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {owner.error}
        </p>
      ) : null}
      {owner.attempt.message ? (
        <p role="alert" className="text-sm text-status-waiting">
          {owner.attempt.message}
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">
        Partial history: at most 20 matching plans from the latest 200 workspace records, with up to 64 explicitly
        linked children. Refresh only reads; owner verification is a separate reviewed action.
      </p>
      {owner.parents.map((plan) => (
        <PackPlanControls
          key={plan.planId}
          plan={plan}
          workspaceId={workspaceId}
          onUpdated={() => void owner.refresh()}
          onInspect={onInspect}
        />
      ))}
      {owner.children.length ? (
        <section aria-label="Linked setup owners" className="space-y-3">
          <h5 className="text-sm font-semibold text-fg">Linked setup owners</h5>
          {owner.children.map((child) => {
            const item = packChildItem(child);
            return (
              <article key={child.planId} className="space-y-2 rounded-md border border-line p-3">
                <h6 className="text-sm font-semibold text-fg">{child.title.slice(0, 240)}</h6>
                <p className="text-sm text-fg-secondary">
                  {child.status.replaceAll("_", " ")} · {child.summary.slice(0, 2000)}
                </p>
                <code className="block break-all font-mono text-xs text-fg-muted">{child.planId}</code>
                {item ? (
                  <Button onClick={() => onInspect(packInboxUrl(item, workspaceId))}>Inspect linked owner</Button>
                ) : (
                  <p className="text-sm text-status-waiting">Exact owner handoff is unavailable.</p>
                )}
              </article>
            );
          })}
          <p className="text-xs text-fg-muted">
            Inbox rechecks the scoped canonical item. Completed or unavailable items may no longer appear. Specialized
            approvals, artifact review and runtime input stay with those owners.
          </p>
        </section>
      ) : null}
      <Dialog
        open={Boolean(owner.review)}
        title="Create reviewed setup plan"
        description={PACK_SETUP_WARNING}
        onOpenChange={(open) => {
          if (!open) owner.cancelReview();
        }}
      >
        {owner.review ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              {owner.review.manifest.name} · {owner.review.selected.length} selected assets
            </p>
            <ul className="list-inside list-disc text-sm text-fg-secondary">
              {owner.review.selected.map((id) => (
                <li key={id}>{owner.review!.manifest.assets.find((asset) => asset.id === id)?.label}</li>
              ))}
            </ul>
            <code className="block break-all font-mono text-xs text-fg-muted">
              {owner.review.manifest.provenance.contentHash}
            </code>
            <p className="text-xs text-fg-muted">
              The bundled definition is re-read before requesting this workspace plan. Review its separate owner
              confirmation before any setup executes.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={owner.attempt.phase !== "idle"} onClick={() => void owner.confirmSetup()}>
                Create reviewed setup plan
              </Button>
              <Button onClick={owner.cancelReview}>Cancel setup review</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
