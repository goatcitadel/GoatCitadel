import type { ChatMode } from "@goatcitadel/contracts";
import {
  MissionThreadedControllerHost,
  type MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { ThreadedSurfacePage } from "./ThreadedSurfacePage";

export function ThreadedSurfaceRoute({
  surface,
  workspaceId,
  workspaceName,
  approvalsCount,
  lockSurface,
  onOpenCowork,
  onOpenCode,
  onOpenTasks,
  onOpenApprovals,
  onNavigateSurface,
}: {
  surface: ChatMode;
  workspaceId: string;
  workspaceName: string;
  approvalsCount: number;
  lockSurface?: boolean;
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: () => void;
  onNavigateSurface?: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
}) {
  return (
    <MissionThreadedControllerHost
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      approvalsCount={approvalsCount}
      surface={surface}
      lockSurface={lockSurface}
      onOpenCowork={onOpenCowork}
      onOpenCode={onOpenCode}
      onOpenTasks={onOpenTasks}
      onOpenApprovals={onOpenApprovals}
      onNavigateSurface={onNavigateSurface}
      renderSurface={(input: MissionThreadedRenderSurfaceInput) => (
        <ThreadedSurfacePage surface={surface} input={input} />
      )}
    />
  );
}
