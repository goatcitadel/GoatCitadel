import { useCallback, useState } from "react";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { fetchChatProjects, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export type ProjectRevisionConflict = {
  projectId: string;
  message: string;
  preserveDraft: boolean;
};

export function useProjectRevisionConflict(input: {
  activeCitadelId?: string;
  activeWorkspaceId: string;
  isMounted: () => boolean;
  onProjectsRefreshed: (projects: ChatProjectRecord[]) => void;
}) {
  const { activeCitadelId, activeWorkspaceId, isMounted, onProjectsRefreshed } = input;
  const [revisionConflict, setRevisionConflict] = useState<ProjectRevisionConflict | null>(null);

  const handleRevisionConflict = useCallback(
    async (error: unknown, projectId: string, preserveDraft: boolean, actionLabel: string): Promise<boolean> => {
      if (!isApiRequestError(error) || error.status !== 409) {
        return false;
      }
      let refreshedProjects: ChatProjectRecord[] | null = null;
      try {
        const response = await fetchChatProjects("all", 300, activeWorkspaceId, activeCitadelId);
        if (!isMounted()) {
          return true;
        }
        refreshedProjects = response.items;
      } catch {
        if (!isMounted()) {
          return true;
        }
      }
      setRevisionConflict({
        projectId,
        preserveDraft,
        message: refreshedProjects
          ? `This project changed elsewhere. The current revision was reloaded${preserveDraft ? " and your draft was preserved" : ""}. Review it, then ${actionLabel} again to retry.`
          : `This project changed elsewhere${preserveDraft ? "; your draft is still preserved" : ""}. The current revision could not be reloaded, so refresh before retrying.`,
      });
      if (refreshedProjects) {
        onProjectsRefreshed(refreshedProjects);
      }
      return true;
    },
    [activeCitadelId, activeWorkspaceId, isMounted, onProjectsRefreshed],
  );

  return {
    revisionConflict,
    clearRevisionConflict: useCallback(() => setRevisionConflict(null), []),
    handleRevisionConflict,
  };
}
