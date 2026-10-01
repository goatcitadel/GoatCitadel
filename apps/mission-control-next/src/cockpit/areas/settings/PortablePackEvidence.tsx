import { useState } from "react";
import type { CapabilityPackPreview } from "@goatcitadel/contracts";
import type { PortablePacksOwner } from "../../../features/native-routes/settings/sections/use-portable-packs";
import { Button } from "../../ui/Button";

const human = (value: string) => value.replaceAll("_", " ");
export function PortablePackPreview({ preview }: { preview: CapabilityPackPreview }) {
  const [limit, setLimit] = useState(30),
    { manifest } = preview;
  return (
    <section aria-label="Pack owner preview" className="space-y-3">
      <header>
        <h4 className="break-words text-base font-semibold text-fg">{manifest.name}</h4>
        <p className="mt-1 break-words text-sm text-fg-secondary">{manifest.description}</p>
      </header>
      <dl className="grid grid-cols-2 gap-3 text-sm text-fg-secondary">
        <div>
          <dt>Version</dt>
          <dd>{manifest.version}</dd>
        </div>
        <div>
          <dt>Publisher</dt>
          <dd className="break-words">{manifest.provenance.publisher}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{human(manifest.provenance.source)}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>{preview.reviewRequired ? "Required" : "Not required by preview"}</dd>
        </div>
      </dl>
      <p className="text-xs text-fg-muted">
        Advisory policy labels: first-use approval{" "}
        {preview.policyChanges.requireFirstUseApproval ? "required" : "not requested"}; memory{" "}
        {human(preview.policyChanges.memoryWriteAuthority)}; redaction {preview.policyChanges.redactionMode}; auto-run{" "}
        {preview.policyChanges.autoRunEnabled ? "requested" : "off"}. These labels do not change policy.
      </p>
      <ul aria-label="Preview assets" className="space-y-2">
        {preview.installPlan.slice(0, limit).map((item) => (
          <li key={item.assetId} className="rounded-md border border-line p-3 text-sm text-fg-secondary">
            <p className="break-words font-medium text-fg">
              {manifest.assets.find((asset) => asset.id === item.assetId)?.label ?? item.assetId}
            </p>
            <p>
              {human(item.kind)} · {human(item.outcome)}
            </p>
            <p className="mt-1 break-words">{item.reason}</p>
          </li>
        ))}
      </ul>
      {preview.installPlan.length > limit ? (
        <Button size="sm" onClick={() => setLimit((value) => value + 30)}>
          Show more preview assets
        </Button>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm text-fg-secondary">Warnings and declared identity</summary>
        <ul className="mt-2 space-y-2 text-sm text-status-waiting">
          {manifest.installWarnings.slice(0, 50).map((warning, index) => (
            <li key={index} className="break-words">
              {warning}
            </li>
          ))}
        </ul>
        <code className="mt-2 block break-all font-mono text-xs text-fg-muted">{manifest.packId}</code>
        <code className="mt-1 block break-all font-mono text-xs text-fg-muted">
          {manifest.provenance.contentHash ?? "No declared content hash"}
        </code>
      </details>
    </section>
  );
}

export function PortablePackStagedEvidence({ owner }: { owner: PortablePacksOwner }) {
  const [limit, setLimit] = useState(20);
  const items = owner.data?.staged ?? [];
  return (
    <section aria-label="Staged pack evidence" className="space-y-3">
      <h4 className="text-sm font-semibold text-fg">Recent staging evidence</h4>
      <p className="text-xs text-fg-muted">
        Bounded owner sample from the latest 100 installation evidence envelopes. This is not a complete pack history or
        a readiness count.
      </p>
      <ul className="space-y-2">
        {items.slice(0, limit).map((item, index) => (
          <li
            key={item.evidenceEnvelopeId ?? `unbound-${index}`}
            className="space-y-2 rounded-md border border-line p-3 text-sm text-fg-secondary"
          >
            <p className="break-words font-semibold text-fg">{item.name}</p>
            <p>
              {item.version} · Staged {item.stagedAt} · {item.stagedAssets.length} assets
            </p>
            <p>
              {item.latestMaterialization
                ? `Review evidence recorded ${item.latestMaterialization.materializedAt}; callable state unchanged.`
                : "Staged for review; no activation is established."}
            </p>
            <details>
              <summary className="cursor-pointer">Evidence identity</summary>
              <code className="mt-1 block break-all font-mono text-xs">{item.evidenceEnvelopeId ?? "Unavailable"}</code>
            </details>
            <Button
              size="sm"
              disabled={owner.locked || !item.evidenceEnvelopeId || !item.stagedAssets.length}
              onClick={() => owner.requestRecord(item)}
            >
              Review evidence for {item.name}
            </Button>
          </li>
        ))}
      </ul>
      {items.length > limit ? (
        <Button size="sm" onClick={() => setLimit((value) => value + 20)}>
          Show more staged records
        </Button>
      ) : null}
      {owner.data && !items.length ? (
        <p className="text-sm text-fg-muted">No staged records returned in this sample.</p>
      ) : null}
    </section>
  );
}
