import { ChatExternalBindingPanel } from "./ChatExternalBindingPanel";
import { ChatSessionManagementPanel } from "./ChatSessionManagementPanel";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";

export function ChatDockSessionSection(
  props: Pick<
    ChatContextDockPanelsProps,
    | "selectedSession"
    | "renameTitle"
    | "onRenameTitleChange"
    | "folderName"
    | "onFolderNameChange"
    | "tagsValue"
    | "onTagsValueChange"
    | "sending"
    | "sessionControlPending"
    | "selectedSessionProjectValue"
    | "projectOptions"
    | "onRenameSession"
    | "onSaveOrganization"
    | "onTogglePinSession"
    | "onToggleArchiveSession"
    | "onDeleteSession"
    | "onAssignProject"
    | "onExportSnapshot"
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
    folderName,
    onFolderNameChange,
    tagsValue,
    onTagsValueChange,
    sending,
    sessionControlPending,
    selectedSessionProjectValue,
    projectOptions,
    onRenameSession,
    onSaveOrganization,
    onTogglePinSession,
    onToggleArchiveSession,
    onDeleteSession,
    onAssignProject,
    onExportSnapshot,
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
        folderName={folderName}
        onFolderNameChange={onFolderNameChange}
        tagsValue={tagsValue}
        onTagsValueChange={onTagsValueChange}
        sending={sending}
        sessionControlPending={sessionControlPending}
        pinned={Boolean(selectedSession.pinned)}
        archived={selectedSession.lifecycleStatus === "archived"}
        selectedSessionProjectValue={selectedSessionProjectValue}
        projectOptions={projectOptions}
        onRename={() => void onRenameSession()}
        onSaveOrganization={() => void onSaveOrganization()}
        onTogglePin={() => void onTogglePinSession()}
        onToggleArchive={() => void onToggleArchiveSession()}
        onDelete={onDeleteSession}
        onAssignProject={(value) => void onAssignProject(value)}
        onExportSnapshot={onExportSnapshot}
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
