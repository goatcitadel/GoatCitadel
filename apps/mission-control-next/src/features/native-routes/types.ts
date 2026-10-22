import type { AppRoute } from "@next/app/route-model";

export interface NativeRoutePagesProps {
  route: AppRoute;
  activeCitadelId?: string;
  activeCitadelName?: string;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  /** Undefined when the host has no count; shown as Unknown, never as 0. */
  pendingApprovals?: number;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveCitadelId?: (citadelId: string) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}
