import { useEffect } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/client";

export function useRouteGeneratedArtifactReveal(input: {
  routeArtifactId: string | null;
  workspaceId: string;
  revealGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord) => Promise<void> | void;
  setActiveGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord | null) => void;
}): void {
  const { revealGeneratedArtifact, routeArtifactId, setActiveGeneratedArtifact, workspaceId } = input;
  useEffect(() => {
    if (!routeArtifactId) {
      setActiveGeneratedArtifact(null);
      return;
    }
    let cancelled = false;
    void fetchChatGeneratedArtifact(routeArtifactId, workspaceId)
      .then((response) => {
        if (!cancelled) {
          void revealGeneratedArtifact(response.item);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveGeneratedArtifact(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [revealGeneratedArtifact, routeArtifactId, setActiveGeneratedArtifact, workspaceId]);
}
