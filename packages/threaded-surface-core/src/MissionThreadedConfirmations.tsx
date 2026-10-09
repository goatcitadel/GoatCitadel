import type { ComponentProps } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
} from "./chat/chat-page-pure-helpers";
import { changePlanContextNote } from "./chat/change-plan-controller-helpers";
import type { ChatChangePlanState } from "./chat/useChatChangePlanState";
import type { useChatSessionControls } from "./chat/useChatSessionControls";

type DialogProps = ComponentProps<typeof ChatChangePlanActionDialog>;
type SessionControls = ReturnType<typeof useChatSessionControls>;
type Input = Pick<
  ChatChangePlanState,
  | "activeChangePlan"
  | "linkedDefaultChangePlan"
  | "changePlanActionPending"
  | "changePlanActionError"
  | "changePlanOAuthFlow"
  | "setActiveChangePlan"
  | "setLinkedDefaultChangePlan"
  | "setChangePlanActionError"
> &
  Pick<
    SessionControls,
    | "sessionDeleteConfirm"
    | "sessionControlPending"
    | "setSessionDeleteConfirm"
    | "archiveWorkspaceConfirmOpen"
    | "archiveWorkspacePending"
    | "setArchiveWorkspaceConfirmOpen"
  > & {
    forkConfirm: { turnId: string; turnCount: number; attachmentCount: number; artifactCount: number } | null;
    forkPending: boolean;
    setForkConfirm: (value: null) => void;
    blockHistoricalMutation: () => boolean;
    handleStartNewThreadFromTurn: (turnId: string) => Promise<void>;
    capabilitySuggestionConfirm: boolean;
    capabilityConfirmationCopy: ReturnType<typeof getCapabilitySuggestionConfirmationCopy> | null;
    capabilitySuggestionPending: boolean;
    setCapabilitySuggestionConfirm: (value: null) => void;
    handleConfirmCapabilitySuggestion: () => void | Promise<void>;
    turnCount: number;
    handleConfirmLinkedModelPlans: (plan: ChangePlanRecord, linked: ChangePlanRecord) => Promise<void>;
    handleConfirmChangePlan: DialogProps["onConfirm"];
    handleSubmitChangePlanForm: DialogProps["onSubmitPublicForm"];
    handleSubmitChangePlanSecret: DialogProps["onSubmitSecureInput"];
    handleChangePlanOAuth: DialogProps["onContinueOAuth"];
    handleOpenChangePlanApproval: DialogProps["onOpenApproval"];
    handleReviewChangePlanArtifacts: DialogProps["onReviewArtifacts"];
    handleChangePlanNativePath: DialogProps["onOpenNativePathPicker"];
    workspaceMissionSessionCount: number;
    handleConfirmDeleteSession: () => void | Promise<void>;
    handleConfirmArchiveWorkspace: () => void | Promise<void>;
  };

export function MissionThreadedConfirmations({
  forkConfirm,
  forkPending,
  setForkConfirm,
  blockHistoricalMutation,
  handleStartNewThreadFromTurn,
  capabilitySuggestionConfirm,
  capabilityConfirmationCopy,
  capabilitySuggestionPending,
  setCapabilitySuggestionConfirm,
  handleConfirmCapabilitySuggestion,
  activeChangePlan,
  linkedDefaultChangePlan,
  changePlanActionPending,
  changePlanActionError,
  changePlanOAuthFlow,
  turnCount,
  setActiveChangePlan,
  setLinkedDefaultChangePlan,
  setChangePlanActionError,
  handleConfirmLinkedModelPlans,
  handleConfirmChangePlan,
  handleSubmitChangePlanForm,
  handleSubmitChangePlanSecret,
  handleChangePlanOAuth,
  handleOpenChangePlanApproval,
  handleReviewChangePlanArtifacts,
  handleChangePlanNativePath,
  sessionDeleteConfirm,
  sessionControlPending,
  setSessionDeleteConfirm,
  handleConfirmDeleteSession,
  archiveWorkspaceConfirmOpen,
  workspaceMissionSessionCount,
  archiveWorkspacePending,
  setArchiveWorkspaceConfirmOpen,
  handleConfirmArchiveWorkspace,
}: Input) {
  return (
    <>
      <ConfirmModal
        open={Boolean(forkConfirm)}
        title="Start a new conversation from this message?"
        message={
          forkConfirm
            ? `Create an independent chat containing ${forkConfirm.turnCount} message exchange${forkConfirm.turnCount === 1 ? "" : "s"}, ${forkConfirm.attachmentCount} attachment${forkConfirm.attachmentCount === 1 ? "" : "s"}, and ${forkConfirm.artifactCount} artifact${forkConfirm.artifactCount === 1 ? "" : "s"}. Original execution evidence is retained as read-only provenance, not replayed.`
            : ""
        }
        confirmLabel={forkPending ? "Creating conversation..." : "Create conversation"}
        pending={forkPending}
        cancelDisabled={forkPending}
        disableDismiss={forkPending}
        onCancel={() => setForkConfirm(null)}
        onConfirm={async () => {
          if (forkConfirm && !blockHistoricalMutation()) await handleStartNewThreadFromTurn(forkConfirm.turnId);
        }}
      />
      <ConfirmModal
        open={Boolean(capabilitySuggestionConfirm)}
        title={capabilityConfirmationCopy?.title ?? "Confirm capability action"}
        message={capabilityConfirmationCopy?.message ?? ""}
        confirmLabel={
          capabilitySuggestionPending ? "Applying..." : (capabilityConfirmationCopy?.confirmLabel ?? "Confirm")
        }
        danger={capabilityConfirmationCopy?.danger ?? false}
        pending={capabilitySuggestionPending}
        cancelDisabled={capabilitySuggestionPending}
        disableDismiss={capabilitySuggestionPending}
        onCancel={() => setCapabilitySuggestionConfirm(null)}
        onConfirm={async () => {
          if (!blockHistoricalMutation()) await handleConfirmCapabilitySuggestion();
        }}
      />
      <ChatChangePlanActionDialog
        plan={activeChangePlan}
        linkedPlan={linkedDefaultChangePlan}
        pending={changePlanActionPending}
        error={changePlanActionError}
        contextNote={changePlanContextNote(activeChangePlan, turnCount, changePlanOAuthFlow)}
        onClose={() => {
          if (!changePlanActionPending) {
            setActiveChangePlan(null);
            setLinkedDefaultChangePlan(null);
            setChangePlanActionError(null);
          }
        }}
        onConfirm={async (plan) => {
          if (blockHistoricalMutation()) return;
          if (linkedDefaultChangePlan) {
            await handleConfirmLinkedModelPlans(plan, linkedDefaultChangePlan);
          } else {
            await handleConfirmChangePlan(plan);
          }
        }}
        onSubmitPublicForm={handleSubmitChangePlanForm}
        onSubmitSecureInput={handleSubmitChangePlanSecret}
        onContinueOAuth={handleChangePlanOAuth}
        onOpenApproval={handleOpenChangePlanApproval}
        onReviewArtifacts={handleReviewChangePlanArtifacts}
        onOpenNativePathPicker={handleChangePlanNativePath}
      />
      <ConfirmModal
        open={Boolean(sessionDeleteConfirm)}
        title="Delete conversation permanently"
        message={sessionDeleteConfirm ? getDeleteSessionConfirmationMessage(sessionDeleteConfirm.label) : ""}
        confirmLabel={sessionControlPending === "delete" ? "Deleting..." : "Delete permanently"}
        danger
        pending={sessionControlPending === "delete"}
        cancelDisabled={sessionControlPending === "delete"}
        disableDismiss={sessionControlPending === "delete"}
        onCancel={() => setSessionDeleteConfirm(null)}
        onConfirm={async () => {
          if (!blockHistoricalMutation()) await handleConfirmDeleteSession();
        }}
      />
      <ConfirmModal
        open={archiveWorkspaceConfirmOpen}
        title="Archive Workspace Mission Chats"
        message={`Archive ${workspaceMissionSessionCount} active mission chats in this workspace? Archived chats leave the default history rail but stay recoverable from the Archived view. External and integration-bound chats are not affected.`}
        confirmLabel={archiveWorkspacePending ? "Archiving..." : "Archive mission chats"}
        danger
        pending={archiveWorkspacePending}
        cancelDisabled={archiveWorkspacePending}
        disableDismiss={archiveWorkspacePending}
        onCancel={() => setArchiveWorkspaceConfirmOpen(false)}
        onConfirm={async () => {
          if (!blockHistoricalMutation()) await handleConfirmArchiveWorkspace();
        }}
      />
    </>
  );
}
