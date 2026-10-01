import { revokeSessionControl } from "@goatcitadel/mission-control-shared/api/session-control-operator";
import { useSessionControlStatus } from "@goatcitadel/mission-control-shared/hooks/useSessionControlStatus";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deriveSessionControlBannerViewModel, type SessionControlBannerActionPending } from "../session-control-banner";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
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
  const sessionControlStatus = useSessionControlStatus(selection.selectedSessionId);
  const reloadSessionControl = sessionControlStatus.reload;
  const sessionControlBannerModel = useMemo(
    () => deriveSessionControlBannerViewModel(sessionControlStatus.data),
    [sessionControlStatus.data],
  );
  const sessionControlSendLocked = sessionControlBannerModel.sendLocked;
  useEffect(() => {
    coordination.sessionControlSendLockedRef.current = sessionControlSendLocked;
  }, [sessionControlSendLocked, coordination.sessionControlSendLockedRef]);
  const [sessionControlActionPending, setSessionControlActionPending] =
    useState<SessionControlBannerActionPending | null>(null);
  const [sessionControlActionError, setSessionControlActionError] = useState<string | null>(null);
  const runSessionControlRevoke = useCallback(
    (mode: SessionControlBannerActionPending) => {
      if (!selection.selectedSessionId || !sessionControlBannerModel.externalControlActive) {
        return;
      }
      const targetSessionId = selection.selectedSessionId;
      setSessionControlActionPending(mode);
      setSessionControlActionError(null);
      void revokeSessionControl(targetSessionId, {
        target: "current_controller",
        expectedGeneration: sessionControlBannerModel.generation,
        mode,
      })
        .then(async () => {
          await reloadSessionControl();
          await refreshChatSessionAggregate(targetSessionId);
        })
        .catch(() => {
          setSessionControlActionError(
            "The control action was rejected. The session state may have changed — reload and retry.",
          );
        })
        .finally(() => {
          setSessionControlActionPending(null);
        });
    },
    [
      refreshChatSessionAggregate,
      reloadSessionControl,
      selection.selectedSessionId,
      sessionControlBannerModel.externalControlActive,
      sessionControlBannerModel.generation,
    ],
  );
  const handleSessionControlRevoke = useCallback(() => runSessionControlRevoke("revoke"), [runSessionControlRevoke]);
  const handleSessionControlEmergencyTakeover = useCallback(
    () => runSessionControlRevoke("emergency_takeover"),
    [runSessionControlRevoke],
  );

  return {
    sessionControlSendLocked,
    sessionControlBannerModel,
    handleSessionControlRevoke,
    handleSessionControlEmergencyTakeover,
    sessionControlActionPending,
    sessionControlActionError,
    sessionControlStatus,
  };
}
