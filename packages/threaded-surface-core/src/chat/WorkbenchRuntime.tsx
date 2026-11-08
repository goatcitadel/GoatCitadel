import { memo, useEffect } from "react";
import { useChatWorkbench } from "./useChatWorkbench.js";

export type WorkbenchSnapshot = ReturnType<typeof useChatWorkbench>;

interface WorkbenchRuntimeProps {
  sessionId: string;
  workspaceId?: string;
  isCurrentOwner: () => boolean;
  publish: (snapshot: WorkbenchSnapshot) => void;
}

export const WorkbenchRuntime = memo(function WorkbenchRuntime({
  sessionId,
  workspaceId,
  isCurrentOwner,
  publish,
}: WorkbenchRuntimeProps) {
  const snapshot = useChatWorkbench({ sessionId, workspaceId, enabled: true, isCurrentOwner });
  useEffect(() => {
    if (isCurrentOwner()) publish(snapshot);
  }, [isCurrentOwner, publish, snapshot]);
  return null;
});
