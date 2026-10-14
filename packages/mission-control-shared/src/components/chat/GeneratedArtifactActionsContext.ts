import { createContext, type ReactNode } from "react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";

/**
 * Host-supplied actions rendered under an artifact (the cockpit shell provides render and
 * critique controls). Hosts that provide nothing get the viewer unchanged.
 */
export const GeneratedArtifactActionsContext = createContext<
  ((artifact: ChatGeneratedArtifactRecord) => ReactNode) | null
>(null);
