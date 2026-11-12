import { revokeSessionControl } from "@goatcitadel/mission-control-shared/api/session-control-operator";
import { useSessionControlStatus } from "@goatcitadel/mission-control-shared/hooks/useSessionControlStatus";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deriveSessionControlBannerViewModel, type SessionControlBannerActionPending } from "../session-control-banner";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    "selectedSessionId" | "selectedSessionIntentRef" | "selectedSessionRevisionRef"
  >;
  coordination: Pick<ReturnType<typeof useChatControllerCoordination>, "sessionControlSendLockedRef">;
  refreshChatSessionAggregate: (sessionId: string) => Promise<void>;
};

/** Keeps external session control fail closed and exposes explicit revoke/takeover actions. */
export function useChatExternalSessionControl({ selection, coordination, refreshChatSessionAggregate }: Input) {
  // HX-411 governed external session control (operator visibility half). The
  // banner + Ops panel read this content-free projection; the derived send lock
  // fails ordinary operator Chat send closed while an external client owns the
  // generation. Operator reads, approvals, revoke, and emergency takeover stay
  // available; the control secret is never fetched or surfaced here.
  const { selectedSessionId, selectedSessionIntentRef, selectedSessionRevisionRef } = selection;
  const selectionRevision = selectedSessionRevisionRef.current;
  const sessionControlStatus = useSessionControlStatus(selectedSessionId);
  const reloadSessionControl = sessionControlStatus.reload;
  const sessionControlBannerModel = useMemo(
    () => deriveSessionControlBannerViewModel(sessionControlStatus.data),
    [sessionControlStatus.data],
  );
  const sessionControlSendLocked = sessionControlBannerModel.sendLocked;
  useEffect(() => {
    coordination.sessionControlSendLockedRef.current = sessionControlSendLocked;
  }, [sessionControlSendLocked, coordination.sessionControlSendLockedRef]);
  const [action, setAction] = useState<{
    revision: number;
    pending?: SessionControlBannerActionPending;
    error?: string;
  }>();
  const currentAction = action?.revision === selectionRevision ? action : undefined;
  const runSessionControlRevoke = useCallback(
    async (mode: SessionControlBannerActionPending) => {
      const current = () =>
        selectedSessionIntentRef.current === selectedSessionId &&
        selectedSessionRevisionRef.current === selectionRevision;
      if (!selectedSessionId || !sessionControlBannerModel.externalControlActive || !current()) return;

      setAction({ revision: selectionRevision, pending: mode });
      try {
        await revokeSessionControl(selectedSessionId, {
          target: "current_controller",
          expectedGeneration: sessionControlBannerModel.generation,
          mode,
        });
        if (!current()) return;
        await reloadSessionControl();
        if (!current()) return;
        await refreshChatSessionAggregate(selectedSessionId);
        if (current()) setAction(undefined);
      } catch {
        if (current())
          setAction({
            revision: selectionRevision,
            error: "The control action was rejected. The session state may have changed — reload and retry.",
          });
      }
    },
    [
      refreshChatSessionAggregate,
      reloadSessionControl,
      selectedSessionId,
      selectedSessionIntentRef,
      selectedSessionRevisionRef,
      selectionRevision,
      sessionControlBannerModel.externalControlActive,
      sessionControlBannerModel.generation,
    ],
  );
  const handleSessionControlRevoke = useCallback(() => {
    void runSessionControlRevoke("revoke");
  }, [runSessionControlRevoke]);
  const handleSessionControlEmergencyTakeover = useCallback(() => {
    void runSessionControlRevoke("emergency_takeover");
  }, [runSessionControlRevoke]);

  return {
    sessionControlSendLocked,
    sessionControlBannerModel,
    handleSessionControlRevoke,
    handleSessionControlEmergencyTakeover,
    sessionControlActionPending: currentAction?.pending ?? null,
    sessionControlActionError: currentAction?.error ?? null,
    sessionControlStatus,
  };
}
