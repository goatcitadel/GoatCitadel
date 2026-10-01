import { fetchAgents } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { useCallback, useEffect } from "react";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatPresetCatalogState } from "./useChatPresetCatalogState";

type Input = {
  setLocalNotices: React.Dispatch<React.SetStateAction<ChatThreadNotice[]>>;
  coordination: Pick<ReturnType<typeof useChatControllerCoordination>, "pushLocalNoticeRef">;
  presetCatalog: Pick<ReturnType<typeof useChatPresetCatalogState>, "setActiveAgents" | "setPresetProfiles">;
};

/** Publishes notices and loads the preset catalog at the existing lifecycle position. */
export function useChatNoticesAndPresetRefresh({ setLocalNotices, coordination, presetCatalog }: Input) {
  const { setActiveAgents } = presetCatalog;
  const { setPresetProfiles } = presetCatalog;

  const pushLocalNotice = useCallback(
    (content: string, tone: ChatThreadNotice["tone"] = "neutral") => {
      setLocalNotices((current) =>
        [
          {
            id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            content,
            tone,
            timestamp: new Date().toISOString(),
          },
          ...current,
        ].slice(0, 12),
      );
    },
    [setLocalNotices],
  );

  useEffect(() => {
    coordination.pushLocalNoticeRef.current = pushLocalNotice;
  }, [pushLocalNotice, coordination.pushLocalNoticeRef]);

  useEffect(() => {
    let cancelled = false;
    void fetchAgents("active", 500)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setActiveAgents(response.items);
        setPresetProfiles(
          response.items
            .filter((item) => item.presetDefaults?.presetLabel)
            .map((item) => ({
              agentId: item.agentId,
              label: item.presetDefaults?.presetLabel ?? item.name,
              summary: item.presetDefaults?.presetSummary,
              routeHint: item.presetDefaults?.routeHint,
              preferredProviderId: item.presetDefaults?.preferredProviderId,
              preferredModel: item.presetDefaults?.preferredModel,
              toolsPosture: item.presetDefaults?.toolsPosture,
              knowledgeAttachmentIds: item.presetDefaults?.knowledgeAttachmentIds,
              promptFraming: item.presetDefaults?.promptFraming,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setActiveAgents([]);
          setPresetProfiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setActiveAgents, setPresetProfiles]);

  return { pushLocalNotice };
}
