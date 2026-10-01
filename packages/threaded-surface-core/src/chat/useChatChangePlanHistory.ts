import { useEffect } from "react";
import { connectEventStream, fetchChangePlans } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatChangePlanState } from "./useChatChangePlanState";

export function useChatChangePlanHistory({
  workspaceId,
  selectedSessionId,
  setChatChangePlanSnapshot,
  setActiveChangePlan,
}: Pick<ChatChangePlanState, "setChatChangePlanSnapshot" | "setActiveChangePlan"> & {
  workspaceId: string;
  selectedSessionId: string | null;
}) {
  useEffect(() => {
    let cancelled = false;
    const sessionId = selectedSessionId;
    setChatChangePlanSnapshot({ ownerSessionId: sessionId, items: [] });
    if (!sessionId) {
      return () => {
        cancelled = true;
      };
    }
    void fetchChangePlans({ workspaceId, sessionId }, { limit: 12 })
      .then((response) => {
        if (!cancelled) setChatChangePlanSnapshot({ ownerSessionId: sessionId, items: response.items });
      })
      .catch(() => {
        if (!cancelled) setChatChangePlanSnapshot({ ownerSessionId: sessionId, items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, setChatChangePlanSnapshot, workspaceId]);

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    let cancelled = false;
    const sessionId = selectedSessionId;
    const disconnect = connectEventStream((event) => {
      if (event.source !== "evolution_control_plane" || !event.eventType.startsWith("change_plan.")) return;
      const eventWorkspaceId = event.links?.workspaceId;
      const eventSessionId = event.links?.sessionId;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) return;
      if (eventSessionId && eventSessionId !== sessionId) return;
      void fetchChangePlans({ workspaceId, sessionId }, { limit: 12 })
        .then((response) => {
          if (cancelled) return;
          setChatChangePlanSnapshot({ ownerSessionId: sessionId, items: response.items });
          setActiveChangePlan((current) => {
            if (!current) return null;
            return response.items.find((item) => item.planId === current.planId) ?? current;
          });
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [selectedSessionId, setActiveChangePlan, setChatChangePlanSnapshot, workspaceId]);
}
