import type { AppRoute } from "@next/app/route-model";

export interface NativeRoutePagesProps {
  route: AppRoute;
  activeCitadelId?: string;
  activeCitadelName?: string;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  pendingApprovals: number;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveCitadelId?: (citadelId: string) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}
