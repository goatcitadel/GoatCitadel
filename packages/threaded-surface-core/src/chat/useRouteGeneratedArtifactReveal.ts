import { useEffect, useRef } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/client";

export function useRouteGeneratedArtifactReveal(input: {
  activeArtifactId?: string;
  onError?: (message: string) => void;
  routeArtifactId: string | null;
  workspaceId: string;
  revealGeneratedArtifact: (
    artifact: ChatGeneratedArtifactRecord,
  ) => Promise<void> | void;
  setActiveGeneratedArtifact: (
    artifact: ChatGeneratedArtifactRecord | null,
  ) => void;
}): void {
  const { routeArtifactId, workspaceId } = input;
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!routeArtifactId) {
      latest.current.setActiveGeneratedArtifact(null);
      return;
    }
    if (latest.current.activeArtifactId === routeArtifactId) return;
    let cancelled = false;
    void fetchChatGeneratedArtifact(routeArtifactId, workspaceId)
      .then(async (response) => {
        if (cancelled) return;
        if (response.item.artifactId !== routeArtifactId)
          throw new Error("The returned artifact does not match this link.");
        await latest.current.revealGeneratedArtifact(response.item);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          latest.current.setActiveGeneratedArtifact(null);
          latest.current.onError?.(
            error instanceof Error
              ? error.message
              : "Artifact evidence is unavailable.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [routeArtifactId, workspaceId]);
}
