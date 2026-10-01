import type { ChatWorkspaceSnapshotRequest } from "@goatcitadel/contracts";
import { useCallback, useRef, useState } from "react";

/** Owns the one-shot Council and workspace snapshot arming consumed by outbound execution. */
export function useChatOneShotContext() {
  const [fullWebAccess, setFullWebAccess] = useState(true);
  const [modelCouncilEnabled, setModelCouncilEnabled] = useState(false);
  const modelCouncilEnabledRef = useRef(false);
  const consumeModelCouncilArming = useCallback(() => {
    const enabled = modelCouncilEnabledRef.current;
    modelCouncilEnabledRef.current = false;
    setModelCouncilEnabled(false);
    return enabled ? ({ enabled: true } as const) : undefined;
  }, []);
  const [workspaceSnapshotRequest, setWorkspaceSnapshotRequest] = useState<ChatWorkspaceSnapshotRequest>();
  const workspaceSnapshotRequestRef = useRef<ChatWorkspaceSnapshotRequest | undefined>(undefined);
  const consumeWorkspaceSnapshotRequest = useCallback(() => {
    const request = workspaceSnapshotRequestRef.current;
    workspaceSnapshotRequestRef.current = undefined;
    setWorkspaceSnapshotRequest(undefined);
    return request;
  }, []);
  const restoreWorkspaceSnapshotRequest = useCallback((request: ChatWorkspaceSnapshotRequest | undefined) => {
    if (!request || workspaceSnapshotRequestRef.current) return;
    workspaceSnapshotRequestRef.current = request;
    setWorkspaceSnapshotRequest(request);
  }, []);

  return {
    consumeModelCouncilArming,
    consumeWorkspaceSnapshotRequest,
    fullWebAccess,
    workspaceSnapshotRequest,
    restoreWorkspaceSnapshotRequest,
    modelCouncilEnabled,
    modelCouncilEnabledRef,
    setModelCouncilEnabled,
    workspaceSnapshotRequestRef,
    setWorkspaceSnapshotRequest,
    setFullWebAccess,
  };
}
