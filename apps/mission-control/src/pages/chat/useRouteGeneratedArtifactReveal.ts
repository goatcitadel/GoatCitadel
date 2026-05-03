import { useEffect } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "../../api/client";

export function useRouteGeneratedArtifactReveal(input: {
  routeArtifactId: string | null;
  workspaceId: string;
  revealGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord) => Promise<void> | void;
  setActiveGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord | null) => void;
}): void {
  useEffect(() => {
    if (!input.routeArtifactId) {
      input.setActiveGeneratedArtifact(null);
      return;
    }
    let cancelled = false;
    void fetchChatGeneratedArtifact(input.routeArtifactId, input.workspaceId)
      .then((response) => {
        if (!cancelled) {
          void input.revealGeneratedArtifact(response.item);
        }
      })
      .catch(() => {
        if (!cancelled) {
          input.setActiveGeneratedArtifact(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [input.revealGeneratedArtifact, input.routeArtifactId, input.setActiveGeneratedArtifact, input.workspaceId]);
}
