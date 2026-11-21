import { lazy, Suspense } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { AreaErrorBoundary } from "./AreaErrorBoundary";

const ArtifactRenderActions = lazy(async () => ({
  default: (await import("./ArtifactRenderActions")).ArtifactRenderActions,
}));

export function renderCockpitArtifactActions(artifact: ChatGeneratedArtifactRecord) {
  if (
    artifact.kind !== "html" ||
    artifact.publicProjection?.contentRedacted ||
    artifact.publicProjection?.artifactRedacted
  ) {
    return null;
  }
  const identity = `${artifact.artifactId}:${artifact.contentHash ?? artifact.version}`;
  return (
    <AreaErrorBoundary label="Artifact render actions" resetKey={identity}>
      <Suspense fallback={<p aria-busy="true">Loading artifact actions…</p>}>
        <ArtifactRenderActions key={identity} artifact={artifact} />
      </Suspense>
    </AreaErrorBoundary>
  );
}
