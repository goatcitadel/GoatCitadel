import { GeneratedArtifactViewer } from "../../components/chat/GeneratedArtifactViewer";
import { MissionControlContextDock } from "./MissionControlContextDock";
import { ChatDockMemorySection } from "./ChatDockMemorySection";
import { ChatDockRunTraceSection } from "./ChatDockRunTraceSection";
import { ChatDockSessionSection } from "./ChatDockSessionSection";
import { ChatDockSuggestionsSection } from "./ChatDockSuggestionsSection";
import { ChatDockSurfaceSection } from "./ChatDockSurfaceSection";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";

export function ChatContextDockPanels(props: ChatContextDockPanelsProps) {
  const {
    mode,
    dockOpen,
    dockSectionStyle,
    isCodeSurface,
    activeGeneratedArtifact,
    selectedTurn,
    showTracePanel,
    showSuggestionsPanel,
    showLearnedMemoryPanel,
  } = props;

  return (
    <MissionControlContextDock mode={mode} open={dockOpen}>
      <div className="mission-dock-section" style={dockSectionStyle("surface")}>
        <ChatDockSurfaceSection {...props} />
      </div>

      {!isCodeSurface && activeGeneratedArtifact ? (
        <div className="mission-dock-section" style={dockSectionStyle("artifact")}>
          <section className="mission-dock-panel">
            <div className="chat-dock-section-head">
              <div>
                <p className="chat-dock-section-kicker">Generated output</p>
                <h4>Artifact viewer</h4>
              </div>
              {props.onCloseGeneratedArtifact ? (
                <button type="button" className="gc-button" onClick={props.onCloseGeneratedArtifact}>
                  Close
                </button>
              ) : null}
            </div>
            <GeneratedArtifactViewer artifact={activeGeneratedArtifact} />
          </section>
        </div>
      ) : null}

      {showTracePanel && selectedTurn ? (
        <div className="mission-dock-section" style={dockSectionStyle("trace")}>
          <ChatDockRunTraceSection
            isChatSurface={props.isChatSurface}
            isCoworkSurface={props.isCoworkSurface}
            selectedTurn={selectedTurn}
            coworkViewModel={props.coworkViewModel ?? null}
            routePreflight={props.routePreflight ?? null}
            providerLabelById={props.providerLabelById}
          />
        </div>
      ) : null}

      {!isCodeSurface && showSuggestionsPanel ? (
        <div className="mission-dock-section" style={dockSectionStyle("suggestions")}>
          <ChatDockSuggestionsSection
            isChatSurface={props.isChatSurface}
            isCoworkSurface={props.isCoworkSurface}
            sending={props.sending}
            selectedSessionId={props.selectedSessionId}
            proactiveRuns={props.proactiveRuns}
            proactiveSuggestionCount={props.proactiveSuggestionCount}
            capabilitySuggestions={props.capabilitySuggestions}
            specialistSuggestions={props.specialistSuggestions}
            specialistCandidates={props.specialistCandidates}
            delegationSuggestion={props.delegationSuggestion}
            onCapabilitySuggestionAction={props.onCapabilitySuggestionAction}
            onCreateSpecialistDraft={props.onCreateSpecialistDraft}
            onActivateCatalogSpecialist={props.onActivateCatalogSpecialist}
            onSpecialistCandidatePatch={props.onSpecialistCandidatePatch}
            onAcceptDelegation={props.onAcceptDelegation}
          />
        </div>
      ) : null}

      {!isCodeSurface && showLearnedMemoryPanel ? (
        <div className="mission-dock-section" style={dockSectionStyle("memory")}>
          <ChatDockMemorySection
            learnedMemory={props.learnedMemory}
            secondaryLoading={props.secondaryLoading}
            sending={props.sending}
            selectedSessionId={props.selectedSessionId}
            onRebuildLearnedMemory={props.onRebuildLearnedMemory}
            onUpdateMemoryStatus={props.onUpdateMemoryStatus}
          />
        </div>
      ) : null}

      <div className="mission-dock-section" style={dockSectionStyle("session")}>
        <ChatDockSessionSection
          selectedSession={props.selectedSession}
          renameTitle={props.renameTitle}
          onRenameTitleChange={props.onRenameTitleChange}
          folderName={props.folderName}
          onFolderNameChange={props.onFolderNameChange}
          tagsValue={props.tagsValue}
          onTagsValueChange={props.onTagsValueChange}
          sending={props.sending}
          sessionControlPending={props.sessionControlPending}
          selectedSessionProjectValue={props.selectedSessionProjectValue}
          projectOptions={props.projectOptions}
          onRenameSession={props.onRenameSession}
          onSaveOrganization={props.onSaveOrganization}
          onTogglePinSession={props.onTogglePinSession}
          onToggleArchiveSession={props.onToggleArchiveSession}
          onDeleteSession={props.onDeleteSession}
          onAssignProject={props.onAssignProject}
          onExportSnapshot={props.onExportSnapshot}
          binding={props.binding}
          integrationConnectionId={props.integrationConnectionId}
          onIntegrationConnectionIdChange={props.onIntegrationConnectionIdChange}
          integrationTarget={props.integrationTarget}
          onIntegrationTargetChange={props.onIntegrationTargetChange}
          onSaveExternalBinding={props.onSaveExternalBinding}
        />
      </div>
    </MissionControlContextDock>
  );
}
