import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChatMode, ChatSessionPrefsPatch } from "@goatcitadel/contracts";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import type { useChatSessionControls } from "./useChatSessionControls";
import type { useChatSessionData } from "./useChatSessionData";
import type { useChatPreferenceMutations } from "./useChatPreferenceMutations";

export interface ChatPresetProfile {
  agentId: string;
  label: string;
  summary?: string;
  routeHint?: ChatMode;
  preferredProviderId?: string;
  preferredModel?: string;
  toolsPosture?: "safe_auto" | "manual";
  knowledgeAttachmentIds?: string[];
  promptFraming?: string;
}
type Input = {
  presetProfiles: ChatPresetProfile[];
  selectedPresetId: string;
  ensureSession: ReturnType<typeof useChatSessionControls>["ensureSession"];
  requestThreadModelPatch: (patch: ChatSessionPrefsPatch) => void;
  applyPrefPatchToSession: ReturnType<typeof useChatPreferenceMutations>["applyPrefPatchToSession"];
  setDraft: Dispatch<SetStateAction<string>>;
  threadKnowledgeAttachments: ReturnType<typeof useChatSessionData>["threadKnowledgeAttachments"];
  setPresetApplyWarning: Dispatch<SetStateAction<string | null>>;
  messageMode: ChatMode;
  handleNavigateSurface: (surface: ChatMode) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
  setUiError: (value: string | null) => void;
};

export function useChatPresetActions({
  presetProfiles,
  selectedPresetId,
  ensureSession,
  requestThreadModelPatch,
  applyPrefPatchToSession,
  setDraft,
  threadKnowledgeAttachments,
  setPresetApplyWarning,
  messageMode,
  handleNavigateSurface,
  pushLocalNotice,
  setUiError,
}: Input) {
  const handleApplyPresetById = useCallback(
    async (agentId: string) => {
      try {
        const preset = presetProfiles.find((item) => item.agentId === agentId);
        if (!preset) {
          return;
        }
        const session = await ensureSession();
        const modelPatch: ChatSessionPrefsPatch = {
          providerId: preset.preferredProviderId,
          model: preset.preferredModel,
        };
        if (modelPatch.providerId !== undefined || modelPatch.model !== undefined) {
          requestThreadModelPatch(modelPatch);
        }
        const patch: ChatSessionPrefsPatch = {
          toolAutonomy: preset.toolsPosture,
        };
        const hasPatch = Object.values(patch).some((value) => value !== undefined);
        if (hasPatch) {
          await applyPrefPatchToSession(session.sessionId, patch, {
            syncLocalState: true,
          });
        }
        if (preset.promptFraming) {
          setDraft((current) =>
            current.trim() ? `${preset.promptFraming}\n\n${current.trim()}` : (preset.promptFraming ?? ""),
          );
        }
        const missingKnowledgeAttachmentIds = (preset.knowledgeAttachmentIds ?? []).filter(
          (attachmentId) =>
            !(threadKnowledgeAttachments?.items ?? []).some((item) => item.attachmentId === attachmentId),
        );
        if (missingKnowledgeAttachmentIds.length > 0) {
          const warning =
            missingKnowledgeAttachmentIds.length === 1
              ? `Skipped 1 unavailable knowledge default.`
              : `Skipped ${missingKnowledgeAttachmentIds.length} unavailable knowledge defaults.`;
          setPresetApplyWarning(warning);
          pushLocalNotice(warning, "warning");
        } else {
          setPresetApplyWarning(null);
        }
        if (preset.routeHint && preset.routeHint !== messageMode) {
          handleNavigateSurface(preset.routeHint);
        }
        pushLocalNotice(`Applied ${preset.label}.`, "success");
      } catch (err) {
        setUiError((err as Error).message);
      }
    },
    [
      presetProfiles,
      ensureSession,
      messageMode,
      pushLocalNotice,
      requestThreadModelPatch,
      applyPrefPatchToSession,
      setDraft,
      threadKnowledgeAttachments?.items,
      setPresetApplyWarning,
      handleNavigateSurface,
      setUiError,
    ],
  );
  const handleApplyPreset = useCallback(
    () => handleApplyPresetById(selectedPresetId),
    [handleApplyPresetById, selectedPresetId],
  );
  return { handleApplyPresetById, handleApplyPreset };
}
