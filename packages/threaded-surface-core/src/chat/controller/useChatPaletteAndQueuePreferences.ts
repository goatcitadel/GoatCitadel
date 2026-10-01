import { useEffect, useMemo } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { detectComposerPaletteTrigger } from "../composer-palette";
import { useChatComposerPaletteController } from "../useChatComposerPaletteController";
import { captureOutboundRequestPrefsSnapshot } from "../useChatOutboundExecution";
import { useChatProviderRoutingController } from "../useChatProviderRoutingController";
import { useChatSessionData } from "../useChatSessionData";
import { useChatThreadController } from "../useChatThreadController";
import { useExternalSourceAttachments } from "../useExternalSourceAttachments";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatPresetCatalogState } from "./useChatPresetCatalogState";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  sessionData: Pick<
    ReturnType<typeof useChatSessionData>,
    "settings" | "projects" | "threadKnowledgeAttachments" | "commandCatalog" | "installedSkills" | "thread" | "prefs"
  >;
  draft: string;
  composerPaletteGlobalOpen: boolean;
  composerPaletteQuery: string;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession">;
  providerRouting: Pick<
    ReturnType<typeof useChatProviderRoutingController>,
    "commandSuggestions" | "providerOptions" | "setCommandIndex" | "selectedProviderId" | "selectedModel"
  >;
  presetCatalog: Pick<ReturnType<typeof useChatPresetCatalogState>, "activeAgents">;
  externalSourceAttachments: Pick<ReturnType<typeof useExternalSourceAttachments>, "supported">;
  selectedTurnId: string | null;
  typedRunVariablesEnabled: boolean;
  documentEditingEnabled: boolean;
  setComposerPaletteGlobalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPaletteQuery: React.Dispatch<React.SetStateAction<string>>;
  coordination: Pick<ReturnType<typeof useChatControllerCoordination>, "outboundRequestPrefsSnapshotRef">;
  oneShotContext: Pick<ReturnType<typeof useChatOneShotContext>, "fullWebAccess">;
};

/** Derives composer palette choices and publishes the current queue-time preference snapshot during render. */
export function useChatPaletteAndQueuePreferences({
  sessionData,
  draft,
  composerPaletteGlobalOpen,
  composerPaletteQuery,
  selection,
  workspaceId,
  threadController,
  providerRouting,
  presetCatalog,
  externalSourceAttachments,
  selectedTurnId,
  typedRunVariablesEnabled,
  documentEditingEnabled,
  setComposerPaletteGlobalOpen,
  setComposerPaletteQuery,
  coordination,
  oneShotContext,
}: Input) {
  const { setCommandIndex } = providerRouting;

  const composerPaletteEnabled = sessionData.settings?.features?.unifiedComposerPaletteV1Enabled === true;
  const composerPaletteTrigger = useMemo(() => detectComposerPaletteTrigger(draft), [draft]);
  const composerPaletteMode = composerPaletteGlobalOpen ? "all" : (composerPaletteTrigger?.mode ?? "all");
  const composerPaletteSearchQuery = composerPaletteGlobalOpen
    ? composerPaletteQuery
    : (composerPaletteTrigger?.query ?? "");
  const composerPaletteProjects = useMemo(() => sessionData.projects?.items ?? [], [sessionData.projects?.items]);
  const composerPaletteKnowledge = useMemo(
    () => sessionData.threadKnowledgeAttachments?.items ?? [],
    [sessionData.threadKnowledgeAttachments?.items],
  );
  const composerPalette = useChatComposerPaletteController({
    enabled: composerPaletteEnabled,
    active: composerPaletteGlobalOpen || composerPaletteTrigger !== null,
    sessionKey: selection.selectedSessionId ?? `new:${workspaceId}`,
    workspaceId: threadController.selectedSession?.workspaceId ?? workspaceId,
    mode: composerPaletteMode,
    query: composerPaletteSearchQuery,
    commandCatalog: sessionData.commandCatalog,
    inlineCommandSuggestions: providerRouting.commandSuggestions,
    providerOptions: providerRouting.providerOptions,
    agents: presetCatalog.activeAgents,
    installedSkills: sessionData.installedSkills,
    projects: composerPaletteProjects,
    knowledgeAttachments: composerPaletteKnowledge,
    externalSourcesAvailable: externalSourceAttachments.supported === true,
    workspaceExplorerAvailable: Boolean(
      threadController.selectedSession?.projectId &&
      (sessionData.thread?.turns.find((turn) => turn.turnId === selectedTurnId) ?? sessionData.thread?.turns.at(-1))
        ?.trace?.durable?.runId &&
      !(sessionData.thread?.turns.find((turn) => turn.turnId === selectedTurnId) ?? sessionData.thread?.turns.at(-1))
        ?.trace?.orchestration?.runId,
    ),
    typedRunVariablesEnabled,
    documentEditingEnabled,
    sessionId: selection.selectedSessionId ?? undefined,
  });
  const effectiveCommandSuggestions = composerPaletteEnabled
    ? composerPalette.items
    : providerRouting.commandSuggestions;
  useEffect(() => {
    setCommandIndex(0);
  }, [composerPaletteGlobalOpen, composerPaletteQuery, composerPaletteTrigger?.mode, setCommandIndex]);
  useEffect(() => {
    setComposerPaletteGlobalOpen(false);
    setComposerPaletteQuery("");
  }, [selection.selectedSessionId, setComposerPaletteGlobalOpen, setComposerPaletteQuery]);
  coordination.outboundRequestPrefsSnapshotRef.current = captureOutboundRequestPrefsSnapshot({
    prefs: sessionData.prefs,
    selectedProviderId: providerRouting.selectedProviderId,
    selectedModel: providerRouting.selectedModel,
    fullWebAccess: oneShotContext.fullWebAccess,
  });

  return { effectiveCommandSuggestions, composerPaletteEnabled, composerPalette };
}
