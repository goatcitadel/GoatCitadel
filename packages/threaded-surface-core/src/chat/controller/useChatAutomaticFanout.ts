import { useMemo } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { useChatSessionData } from "../useChatSessionData";
import { useChatThreadController } from "../useChatThreadController";
import { useChatActivationGrants } from "./useChatActivationGrants";

type Input = {
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "settings" | "projects">;
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession">;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  activationGrants: Pick<ReturnType<typeof useChatActivationGrants>, "autonomousActivationGrants">;
};

/** Derives advisory fanout evidence from existing grants, agents and scoped session state. */
export function useChatAutomaticFanout({ sessionData, threadController, workspaceId, activationGrants }: Input) {
  const automaticFanout = useMemo(() => {
    if (sessionData.settings?.features?.durableChatFanoutV1Enabled !== true) {
      return {
        enabled: false,
        unavailableReason: "Automatic fan-out is not enabled for this runtime. Ask remains the safe default.",
      };
    }
    const projectId = threadController.selectedSession?.projectId?.trim();
    if (!projectId) {
      return {
        enabled: false,
        unavailableReason: "Bind this Chat session to an active project before enabling automatic fan-out.",
      };
    }
    const project = sessionData.projects?.items?.find((candidate) => candidate.projectId === projectId);
    if (!project || project.lifecycleStatus !== "active" || (project.workspaceId ?? "default") !== workspaceId) {
      return {
        enabled: false,
        projectId,
        unavailableReason: "The bound project is missing, archived, or belongs to a different workspace.",
      };
    }
    const now = Date.now();
    const candidateGrants = activationGrants.autonomousActivationGrants.filter(
      (candidate) =>
        candidate.status === "active" &&
        candidate.workspaceId === workspaceId &&
        candidate.projectId === projectId &&
        candidate.activationKinds.includes("subagent_fanout") &&
        Number.isFinite(Date.parse(candidate.expiresAt)) &&
        Date.parse(candidate.expiresAt) > now,
    );
    const grant = candidateGrants.find(
      (candidate) =>
        candidate.activationKinds.length === 1 &&
        candidate.activationKinds[0] === "subagent_fanout" &&
        candidate.surfaces.length === 1 &&
        candidate.surfaces[0] === "chat" &&
        candidate.maxRiskLevel === "caution" &&
        Number.isInteger(candidate.maxActivations) &&
        (candidate.maxActivations ?? 0) >= 1 &&
        typeof candidate.budgetUsd === "number" &&
        Number.isFinite(candidate.budgetUsd) &&
        candidate.budgetUsd >= 0.25,
    );
    if (!grant) {
      return {
        enabled: false,
        projectId,
        unavailableReason: candidateGrants.length
          ? "The active project grant no longer meets the dedicated Chat fan-out safety limits. Ask remains active until it is replaced."
          : "Ask remains active. Auto when useful requires an active, expiring automatic fan-out grant for this exact project.",
      };
    }
    if (grant.maxActivations !== undefined && grant.usedActivations >= grant.maxActivations) {
      return {
        enabled: false,
        projectId,
        grant,
        unavailableReason: "The project grant has no child-activation quota remaining. Ask remains active.",
      };
    }
    if (grant.budgetUsd !== undefined && (grant.usedBudgetUsd ?? 0) >= grant.budgetUsd) {
      return {
        enabled: false,
        projectId,
        grant,
        unavailableReason: "The project grant has no budget remaining. Ask remains active.",
      };
    }
    return { enabled: true, projectId, grant };
  }, [
    activationGrants.autonomousActivationGrants,
    sessionData.projects?.items,
    threadController.selectedSession?.projectId,
    sessionData.settings?.features?.durableChatFanoutV1Enabled,
    workspaceId,
  ]);

  return { automaticFanout };
}
