import type { ExternalSourceImportDetailResponse } from "@goatcitadel/contracts";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Callout } from "../../ui/Callout";
import { TimeText } from "../../ui/TimeText";
import { formatBytes, plural } from "@goatcitadel/mission-control-shared/content/format";
import { importDispositionLabel } from "./library-vocabulary";

export function LibraryImportProvenance({
  detail,
  workspaceId,
}: {
  detail: ExternalSourceImportDetailResponse;
  workspaceId: string;
}) {
  if (detail.intent.workspaceId !== workspaceId || detail.plan.workspaceId !== workspaceId)
    return (
      <Callout announce={false} tone="warning">
        Import provenance is not available in this workspace.
      </Callout>
    );
  return (
    <section className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere" aria-label="Import provenance">
      <h3 className="font-semibold">Import provenance</h3>
      <p>
        Saved import result:{" "}
        {detail.settlement ? importDispositionLabel(detail.settlement.disposition) : "Not recorded"}.{" "}
        {plural(detail.items.length, "immutable item record")}.
      </p>
      <p>
        <TimeText prefix="Accepted" value={detail.intent.admittedAt} absolute />
        {detail.settlement ? (
          <>
            {" "}
            · <TimeText prefix="Settled" value={detail.settlement.settledAt} absolute />
          </>
        ) : null}
      </p>
      <TechnicalDetails label="Import technical provenance">
        <p>Import: {detail.intent.importId}</p>
        <p>Plan: {detail.plan.planId}</p>
        <p className="break-all">Plan SHA-256: {detail.intent.planSha256}</p>
        <p className="break-all">Result SHA-256: {detail.settlement?.resultSha256 ?? "Not recorded"}</p>
        <p>Admitted: {detail.intent.admittedAt}</p>
        <p>Settled: {detail.settlement?.settledAt ?? "Not recorded"}</p>
      </TechnicalDetails>
      <ul className="grid min-w-0 grid-cols-1 divide-y divide-line-subtle">
        {detail.items.map((item, index) => (
          <li key={item.itemId} className="min-w-0 py-3">
            <h4>Imported item {index + 1}</h4>
            <p>{formatBytes(item.normalizedByteCount)} normalized · Managed immutable artifact</p>
            <TechnicalDetails label={`Imported item ${index + 1} provenance`}>
              <p>Item: {item.itemId}</p>
              <p className="break-all">Raw SHA-256: {item.rawSha256}</p>
              <p className="break-all">Normalized SHA-256: {item.normalizedArtifactSha256}</p>
              <p className="break-words">Artifact: {item.artifactRelativeKey}</p>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
      <p>
        Attach an eligible item read-only from Chat. Chat checks separately whether this conversation and you may use
        it. Saving a lasting Knowledge copy needs its own approval.
      </p>
      <NativeOwnerLink scope={workspaceId} href="/chat">
        Open Chat to attach imported source
      </NativeOwnerLink>
    </section>
  );
}
