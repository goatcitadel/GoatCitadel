import { PageHeader } from "@goatcitadel/mission-control-shared/components/PageHeader";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { MissionThreadedConfirmations } from "../../MissionThreadedConfirmations";
import type {
  MissionThreadedControllerHostProps,
  MissionThreadedRenderSurfaceInput,
} from "../../MissionThreadedControllerHost.types";
import { isChatErrorAlreadyShownByTurn } from "../chat-error-copy";
import { ThreadedLoadingState } from "../ThreadedLoadingState";
import type { useChatChangePlanConfirmations } from "../useChatChangePlanConfirmations";
import type { useChatChangePlanOAuth } from "../useChatChangePlanOAuth";
import type { useChatChangePlanOwnerActions } from "../useChatChangePlanOwnerActions";
import type { useChatChangePlanState } from "../useChatChangePlanState";
import type { useChatComposerInteractions } from "../useChatComposerInteractions";
import type { useChatContextActions } from "../useChatContextActions";
import { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSessionControls } from "../useChatSessionControls";
import type { useChatSessionData } from "../useChatSessionData";
import type { useChatThreadController } from "../useChatThreadController";
import type { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";

type Input = {
  lockSurface: NonNullable<MissionThreadedControllerHostProps["lockSurface"]>;
  renderWhileLoading: boolean;
  error: string | null;
  hidePageHeader: NonNullable<MissionThreadedControllerHostProps["hidePageHeader"]>;
  approvalsCount: NonNullable<MissionThreadedControllerHostProps["approvalsCount"]>;
  workspaceName: NonNullable<MissionThreadedControllerHostProps["workspaceName"]>;
  selectedSessionId: string | null;
  visibleRunStateLabel: ReturnType<typeof useChatRunPresentation>["visibleRunStateLabel"];
  renderSurface: MissionThreadedControllerHostProps["renderSurface"];
  threadedSurfaceInput: MissionThreadedRenderSurfaceInput;
  forkConfirm: {
    turnId: string;
    turnCount: number;
    attachmentCount: number;
    artifactCount: number;
  } | null;
  forkPending: boolean;
  setForkConfirm: React.Dispatch<
    React.SetStateAction<{
      turnId: string;
      turnCount: number;
      attachmentCount: number;
      artifactCount: number;
    } | null>
  >;
  blockHistoricalMutation: () => boolean;
  handleStartNewThreadFromTurn: (turnId: string) => Promise<void>;
  surfaceState: Pick<
    ReturnType<typeof useMissionControlSurfaceState>,
    "messageMode" | "surfaceHeaderTitle" | "surfaceHeaderSubtitle" | "isCodeSurface"
  >;
  sessionData: Pick<
    ReturnType<typeof useChatSessionData>,
    "thread" | "loading" | "projects" | "sessions" | "isRefreshing"
  >;
  threadController: Pick<
    ReturnType<typeof useChatThreadController>,
    "missionSessions" | "externalSessions" | "selectedSession" | "workspaceMissionSessionCount"
  >;
  contextActions: Pick<
    ReturnType<typeof useChatContextActions>,
    | "capabilitySuggestionConfirm"
    | "capabilityConfirmationCopy"
    | "capabilitySuggestionPending"
    | "setCapabilitySuggestionConfirm"
  >;
  composerInteractions: Pick<
    ReturnType<typeof useChatComposerInteractions>,
    "handleConfirmCapabilitySuggestion" | "handleConfirmDeleteSession" | "handleConfirmArchiveWorkspace"
  >;
  changePlanState: Pick<
    ReturnType<typeof useChatChangePlanState>,
    | "activeChangePlan"
    | "linkedDefaultChangePlan"
    | "changePlanActionPending"
    | "changePlanActionError"
    | "changePlanOAuthFlow"
    | "setActiveChangePlan"
    | "setLinkedDefaultChangePlan"
    | "setChangePlanActionError"
  >;
  planConfirmations: Pick<
    ReturnType<typeof useChatChangePlanConfirmations>,
    "handleConfirmLinkedModelPlans" | "handleConfirmChangePlan"
  >;
  planActions: Pick<
    ReturnType<typeof useChatChangePlanOwnerActions>,
    | "handleSubmitChangePlanForm"
    | "handleSubmitChangePlanSecret"
    | "handleOpenChangePlanApproval"
    | "handleReviewChangePlanArtifacts"
  >;
  planOAuth: Pick<ReturnType<typeof useChatChangePlanOAuth>, "handleChangePlanOAuth" | "handleChangePlanNativePath">;
  sessionControls: Pick<
    ReturnType<typeof useChatSessionControls>,
    | "sessionDeleteConfirm"
    | "sessionControlPending"
    | "setSessionDeleteConfirm"
    | "archiveWorkspaceConfirmOpen"
    | "archiveWorkspacePending"
    | "setArchiveWorkspaceConfirmOpen"
  >;
};

/** Renders the controller frame; shells may own their initial discovery presentation. */
export function renderChatControllerFrame({
  lockSurface,
  renderWhileLoading,
  error,
  hidePageHeader,
  approvalsCount,
  workspaceName,
  selectedSessionId,
  visibleRunStateLabel,
  renderSurface,
  threadedSurfaceInput,
  forkConfirm,
  forkPending,
  setForkConfirm,
  blockHistoricalMutation,
  handleStartNewThreadFromTurn,
  surfaceState,
  sessionData,
  threadController,
  contextActions,
  composerInteractions,
  changePlanState,
  planConfirmations,
  planActions,
  planOAuth,
  sessionControls,
}: Input) {
  const rootClassName = `chat-v11 mode-${surfaceState.messageMode}${lockSurface ? " shell-owned-surface" : ""}`;
  const latestSelectedTurn =
    sessionData.thread?.turns.filter((turn) => turn.branch?.isSelectedPath).at(-1) ?? sessionData.thread?.turns.at(-1);
  const hostErrorAlreadyInThread = isChatErrorAlreadyShownByTurn({
    error,
    turnStatus: latestSelectedTurn?.trace?.status,
    assistantContent: latestSelectedTurn?.assistantMessage?.content,
  });
  if (sessionData.loading && !renderWhileLoading) {
    return (
      <section className={rootClassName}>
        {!lockSurface && !hidePageHeader ? (
          <PageHeader
            title={surfaceState.surfaceHeaderTitle}
            subtitle={surfaceState.surfaceHeaderSubtitle}
            className="page-header-command chat-v11-header"
          />
        ) : null}
        <ThreadedLoadingState
          approvalsCount={approvalsCount}
          mode={surfaceState.messageMode}
          projectCount={sessionData.projects ? sessionData.projects.items.length : null}
          sessionCount={
            sessionData.sessions
              ? threadController.missionSessions.length + threadController.externalSessions.length
              : null
          }
          workspaceName={workspaceName}
        />
      </section>
    );
  }

  return (
    <section className={rootClassName}>
      {!lockSurface && !hidePageHeader ? (
        <PageHeader
          title={surfaceState.surfaceHeaderTitle}
          subtitle={surfaceState.surfaceHeaderSubtitle}
          hint={
            surfaceState.isCodeSurface
              ? undefined
              : "Stay in the main thread by default. Open trace, memory, and approvals only when you need them."
          }
          className="page-header-command chat-v11-header"
          actions={
            <div className="chat-v11-page-actions">
              <StatusChip tone={selectedSessionId ? "live" : "muted"}>
                {selectedSessionId ? "Session selected" : "No session"}
              </StatusChip>
              {threadController.selectedSession ? (
                <StatusChip tone={threadController.selectedSession.scope === "external" ? "warning" : "success"}>
                  {threadController.selectedSession.scope === "external"
                    ? "External writeback (non-resumable)"
                    : "Mission session"}
                </StatusChip>
              ) : null}
              {threadController.selectedSession?.forkRelationships?.[0] ? (
                <StatusChip tone="muted">
                  {threadController.selectedSession.forkRelationships[0].direction === "forked_from"
                    ? "Forked conversation"
                    : "Has forks"}
                </StatusChip>
              ) : null}
              {!surfaceState.isCodeSurface && visibleRunStateLabel ? (
                <StatusChip tone="muted">{visibleRunStateLabel}</StatusChip>
              ) : null}
            </div>
          }
        />
      ) : null}
      {error && !hostErrorAlreadyInThread ? <p className="error">{error}</p> : null}
      {sessionData.isRefreshing ? <p className="status-banner">Refreshing chat context...</p> : null}
      {renderSurface(threadedSurfaceInput)}
      <MissionThreadedConfirmations
        forkConfirm={forkConfirm}
        forkPending={forkPending}
        setForkConfirm={setForkConfirm}
        blockHistoricalMutation={blockHistoricalMutation}
        handleStartNewThreadFromTurn={handleStartNewThreadFromTurn}
        capabilitySuggestionConfirm={Boolean(contextActions.capabilitySuggestionConfirm)}
        capabilityConfirmationCopy={contextActions.capabilityConfirmationCopy}
        capabilitySuggestionPending={contextActions.capabilitySuggestionPending}
        setCapabilitySuggestionConfirm={contextActions.setCapabilitySuggestionConfirm}
        handleConfirmCapabilitySuggestion={composerInteractions.handleConfirmCapabilitySuggestion}
        activeChangePlan={changePlanState.activeChangePlan}
        linkedDefaultChangePlan={changePlanState.linkedDefaultChangePlan}
        changePlanActionPending={changePlanState.changePlanActionPending}
        changePlanActionError={changePlanState.changePlanActionError}
        changePlanOAuthFlow={changePlanState.changePlanOAuthFlow}
        turnCount={sessionData.thread?.turns.length ?? 0}
        setActiveChangePlan={changePlanState.setActiveChangePlan}
        setLinkedDefaultChangePlan={changePlanState.setLinkedDefaultChangePlan}
        setChangePlanActionError={changePlanState.setChangePlanActionError}
        handleConfirmLinkedModelPlans={planConfirmations.handleConfirmLinkedModelPlans}
        handleConfirmChangePlan={planConfirmations.handleConfirmChangePlan}
        handleSubmitChangePlanForm={planActions.handleSubmitChangePlanForm}
        handleSubmitChangePlanSecret={planActions.handleSubmitChangePlanSecret}
        handleChangePlanOAuth={planOAuth.handleChangePlanOAuth}
        handleOpenChangePlanApproval={planActions.handleOpenChangePlanApproval}
        handleReviewChangePlanArtifacts={planActions.handleReviewChangePlanArtifacts}
        handleChangePlanNativePath={planOAuth.handleChangePlanNativePath}
        sessionDeleteConfirm={sessionControls.sessionDeleteConfirm}
        sessionControlPending={sessionControls.sessionControlPending}
        setSessionDeleteConfirm={sessionControls.setSessionDeleteConfirm}
        handleConfirmDeleteSession={composerInteractions.handleConfirmDeleteSession}
        archiveWorkspaceConfirmOpen={sessionControls.archiveWorkspaceConfirmOpen}
        workspaceMissionSessionCount={threadController.workspaceMissionSessionCount}
        archiveWorkspacePending={sessionControls.archiveWorkspacePending}
        setArchiveWorkspaceConfirmOpen={sessionControls.setArchiveWorkspaceConfirmOpen}
        handleConfirmArchiveWorkspace={composerInteractions.handleConfirmArchiveWorkspace}
      />
    </section>
  );
}
