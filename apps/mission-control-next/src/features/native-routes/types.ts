import type { AppRoute } from "@next/app/route-model";

export interface NativeRoutePagesProps {
  route: AppRoute;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  pendingApprovals: number;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}
