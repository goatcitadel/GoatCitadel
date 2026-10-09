import type { ExternalSourceImportDetailResponse } from "@goatcitadel/contracts";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Callout } from "../../ui/Callout";

export function LibraryImportProvenance({ detail, workspaceId }: { detail: ExternalSourceImportDetailResponse; workspaceId: string }) {
  if (detail.intent.workspaceId !== workspaceId || detail.plan.workspaceId !== workspaceId) return <Callout tone="warning">Import provenance is not available in this workspace.</Callout>;
  return <section className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere" aria-label="Import provenance"><h3 className="font-semibold">Import provenance</h3><p>Canonical import settlement: {detail.settlement?.disposition ?? "Not recorded"}. {detail.items.length} immutable item records.</p><p>Admitted {new Date(detail.intent.admittedAt).toLocaleString()}{detail.settlement ? ` · Settled ${new Date(detail.settlement.settledAt).toLocaleString()}` : ""}</p>
    <TechnicalDetails label="Import technical provenance"><p>Import: {detail.intent.importId}</p><p>Plan: {detail.plan.planId}</p><p className="break-all">Plan SHA-256: {detail.intent.planSha256}</p><p className="break-all">Result SHA-256: {detail.settlement?.resultSha256 ?? "Not recorded"}</p><p>Admitted: {detail.intent.admittedAt}</p><p>Settled: {detail.settlement?.settledAt ?? "Not recorded"}</p></TechnicalDetails>
    <ul className="grid min-w-0 grid-cols-1 gap-2">{detail.items.map((item, index) => <li key={item.itemId} className="min-w-0 rounded-md border border-line p-3"><h4>Imported item {index + 1}</h4><p>{item.normalizedByteCount.toLocaleString()} normalized bytes · Managed immutable artifact</p><TechnicalDetails label={`Imported item ${index + 1} provenance`}><p>Item: {item.itemId}</p><p className="break-all">Raw SHA-256: {item.rawSha256}</p><p className="break-all">Normalized SHA-256: {item.normalizedArtifactSha256}</p><p className="break-words">Artifact: {item.artifactRelativeKey}</p></TechnicalDetails></li>)}</ul>
    <p>Attach an eligible item read-only from Chat. Context admission is checked separately for the current conversation and caller. A durable Knowledge copy requires its own approval and settled effect.</p><NativeOwnerLink scope={workspaceId} href="/chat?shell=cockpit">Open Chat to attach imported source</NativeOwnerLink>
  </section>;
}
