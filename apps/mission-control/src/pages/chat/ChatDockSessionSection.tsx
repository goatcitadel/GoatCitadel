import { ChatExternalBindingPanel } from "./ChatExternalBindingPanel";
import { ChatSessionManagementPanel } from "./ChatSessionManagementPanel";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";

export function ChatDockSessionSection(
  props: Pick<
    ChatContextDockPanelsProps,
    | "selectedSession"
    | "renameTitle"
    | "onRenameTitleChange"
    | "sending"
    | "sessionControlPending"
    | "selectedSessionProjectValue"
    | "projectOptions"
    | "onRenameSession"
    | "onTogglePinSession"
    | "onToggleArchiveSession"
    | "onDeleteSession"
    | "onAssignProject"
    | "binding"
    | "integrationConnectionId"
    | "onIntegrationConnectionIdChange"
    | "integrationTarget"
    | "onIntegrationTargetChange"
    | "onSaveExternalBinding"
  >,
) {
  const {
    selectedSession,
    renameTitle,
    onRenameTitleChange,
    sending,
    sessionControlPending,
    selectedSessionProjectValue,
    projectOptions,
    onRenameSession,
    onTogglePinSession,
    onToggleArchiveSession,
    onDeleteSession,
    onAssignProject,
    binding,
    integrationConnectionId,
    onIntegrationConnectionIdChange,
    integrationTarget,
    onIntegrationTargetChange,
    onSaveExternalBinding,
  } = props;

  return (
    <>
      <ChatSessionManagementPanel
        renameTitle={renameTitle}
        onRenameTitleChange={onRenameTitleChange}
        sending={sending}
        sessionControlPending={sessionControlPending}
        pinned={Boolean(selectedSession.pinned)}
        archived={selectedSession.lifecycleStatus === "archived"}
        selectedSessionProjectValue={selectedSessionProjectValue}
        projectOptions={projectOptions}
        onRename={() => void onRenameSession()}
        onTogglePin={() => void onTogglePinSession()}
        onToggleArchive={() => void onToggleArchiveSession()}
        onDelete={onDeleteSession}
        onAssignProject={(value) => void onAssignProject(value)}
      />
      {selectedSession.scope === "external" ? (
        <ChatExternalBindingPanel
          writable={Boolean(binding && binding.writable)}
          integrationConnectionId={integrationConnectionId}
          onIntegrationConnectionIdChange={onIntegrationConnectionIdChange}
          integrationTarget={integrationTarget}
          onIntegrationTargetChange={onIntegrationTargetChange}
          sending={sending}
          pending={sessionControlPending === "binding"}
          controlsDisabled={Boolean(sessionControlPending)}
          onSaveBinding={() => void onSaveExternalBinding()}
        />
      ) : null}
    </>
  );
}
