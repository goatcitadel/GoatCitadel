import type { AgentProfileRecord, ChatMode } from "@goatcitadel/contracts";
import { useState } from "react";

/** Owns the operator preset catalog and current selection. */
export function useChatPresetCatalogState() {
  const [presetProfiles, setPresetProfiles] = useState<
    Array<{
      agentId: string;
      label: string;
      summary?: string;
      routeHint?: ChatMode;
      preferredProviderId?: string;
      preferredModel?: string;
      toolsPosture?: "safe_auto" | "manual";
      knowledgeAttachmentIds?: string[];
      promptFraming?: string;
    }>
  >([]);
  const [activeAgents, setActiveAgents] = useState<AgentProfileRecord[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");

  return { setActiveAgents, setPresetProfiles, activeAgents, presetProfiles, selectedPresetId, setSelectedPresetId };
}
