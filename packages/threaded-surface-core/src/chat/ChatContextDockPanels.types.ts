import type {
  ChatCapabilityUpgradeSuggestion,
  ChatDelegationSuggestionRecord,
  ChatGeneratedArtifactRecord,
  ChatRoutedContextRef,
  DocumentPatchProposalRecord,
  NoteRecord,
  ChatModePresetRecord,
  ChatOrchestrationSummary,
  ChatSessionBindingRecord,
  ChatSessionPrefsRecord,
  ChatSessionPrefsPatch,
  ChatSessionRecord,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatThreadTurnRecord,
  RoutingPreflightResult,
  LearnedMemoryItemRecord,
  ProactivePolicy,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import type { CoworkTaskItem } from "@goatcitadel/mission-control-shared/components/cowork-types";
import type { CoworkRunViewModel } from "@goatcitadel/mission-control-shared/components/cowork-view-model";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import type { ChatProactivePolicyPatch } from "./useChatDelegationPolicyActions";
import type { MissionControlDockSectionId } from "./useMissionControlSurfaceState";
import type { ChatVisualStreamMode } from "./chat-streaming-preview";
import type { WorkTrustDescriptor } from "./work-trust";
import type { ChatCapabilityProfileInspection } from "./useChatCapabilityProfileInspection";

export interface ChatContextDockPanelsProps {
  mode: "chat" | "cowork" | "code";
  dockOpen: boolean;
  dockSectionStyle: (sectionId: MissionControlDockSectionId) => { order: number };
  isChatSurface: boolean;
  isCoworkSurface: boolean;
  isCodeSurface: boolean;
  activeModePreset: ChatModePresetRecord;
  planningMode: "off" | "advisory";
  effectiveToolAutonomy: ChatSessionPrefsRecord["toolAutonomy"] | undefined;
  codeModeNeedsProjectBinding: boolean;
  selectedSession: ChatSessionRecord;
  selectedProject?: { name: string } | null;
  selectedProjectBindingCandidateId?: string;
  selectedProjectBindingCandidateName?: string;
  sending: boolean;
  sessionControlPending:
    | "rename"
    | "organization"
    | "pin"
    | "archive"
    | "delete"
    | "project"
    | "binding"
    | "code_source"
    | null;
  providerOptions: ChatModelProviderOption[];
  selectedProviderId?: string;
  selectedModel?: string;
  streamEnabled: boolean;
  visualStreamMode: ChatVisualStreamMode;
  onStreamEnabledChange: (checked: boolean) => void;
  onVisualStreamModeChange: (mode: ChatVisualStreamMode) => void;
  prefs: ChatSessionPrefsRecord | null;
  preferenceConflictDraft: ChatSessionPrefsPatch | null;
  onRetryPreferenceConflictDraft: () => Promise<void>;
  onDiscardPreferenceConflictDraft: () => void;
  selectedSessionId: string | null;
  showTracePanel: boolean;
  selectedTurn: ChatThreadTurnRecord | null;
  capabilityProfileInspection: ChatCapabilityProfileInspection;
  activeGeneratedArtifact?: ChatGeneratedArtifactRecord | null;
  documents?: {
    enabled: boolean;
    loading: boolean;
    notes: NoteRecord[];
    artifacts: ChatGeneratedArtifactRecord[];
    proposals: DocumentPatchProposalRecord[];
    includedRefs: ChatRoutedContextRef[];
    onRefresh: () => Promise<void>;
    onToggleInclude: (ref: ChatRoutedContextRef) => void;
    onSaveNote: (note: NoteRecord, body: string) => Promise<NoteRecord>;
    onSaveArtifact: (artifact: ChatGeneratedArtifactRecord, content: string) => Promise<ChatGeneratedArtifactRecord>;
    onCreateProposal: (input: {
      targetKind: "personal_note" | "generated_artifact";
      targetId: string;
      baseRevision?: number;
      baseContentHash?: string;
      proposedContent: string;
      turnId?: string;
    }) => Promise<DocumentPatchProposalRecord>;
    onApplyProposal: (proposalId: string) => Promise<DocumentPatchProposalRecord>;
    onRejectProposal: (proposalId: string) => Promise<DocumentPatchProposalRecord>;
  };
  routePreflight?: RoutingPreflightResult | null;
  trust?: WorkTrustDescriptor;
  providerLabelById?: Map<string, string>;
  showSuggestionsPanel: boolean;
  showLearnedMemoryPanel: boolean;
  latestOrchestration: ChatOrchestrationSummary | null | undefined;
  coworkItems: CoworkTaskItem[];
  coworkViewModel?: CoworkRunViewModel | null;
  proactiveStatus: ProactivePolicy | null;
  proactivePolicyDraft: ChatProactivePolicyPatch | null;
  proactivePolicyConflict: boolean;
  proactiveRuns: ProactiveRunRecord[];
  proactiveSuggestionCount: number;
  capabilitySuggestions: ChatCapabilityUpgradeSuggestion[];
  specialistSuggestions: ChatSpecialistCandidateSuggestionRecord[];
  specialistCandidates: ChatSpecialistCandidateRecord[];
  delegationSuggestion: ChatDelegationSuggestionRecord | null;
  learnedMemory: LearnedMemoryItemRecord[];
  secondaryLoading: boolean;
  binding: ChatSessionBindingRecord | null;
  integrationConnectionId: string;
  integrationTarget: string;
  selectedSessionProjectValue: string;
  projectOptions: Array<{ value: string; label: string }>;
  loadModelsForProvider: (providerId: string, options?: { force?: boolean }) => Promise<string[]>;
  getCachedModels: (providerId: string) => string[];
  resolveProviderModelSelection: (input: {
    provider: ChatModelProviderOption | undefined;
    loadedModels: string[];
    selectedModel: string | undefined;
  }) => { model?: string };
  onPrefPatch: (patch: ChatSessionPrefsPatch) => Promise<void>;
  onSuggestDelegation: () => Promise<void>;
  onTriggerProactive: () => Promise<void>;
  onProactivePolicyPatch: (patch: ChatProactivePolicyPatch) => Promise<void>;
  onRunCodeDelegation: (presetKey: "implement" | "review" | "test" | "ship") => Promise<void>;
  onCapabilitySuggestionAction: (suggestion: ChatCapabilityUpgradeSuggestion) => void;
  onCreateSpecialistDraft: (suggestion: ChatSpecialistCandidateSuggestionRecord) => Promise<void>;
  onActivateCatalogSpecialist: (suggestion: ChatSpecialistCandidateSuggestionRecord) => Promise<void>;
  onSpecialistCandidatePatch: (
    candidateId: string,
    patch: ChatSpecialistCandidatePatchInput,
    notice: string,
  ) => Promise<void>;
  onAcceptDelegation: () => Promise<void>;
  onRebuildLearnedMemory: () => Promise<void>;
  onUpdateMemoryStatus: (itemId: string, status: "active" | "superseded" | "conflict" | "disabled") => Promise<void>;
  onCloseGeneratedArtifact?: () => void;
  onRenameTitleChange: (value: string) => void;
  renameTitle: string;
  folderName: string;
  onFolderNameChange: (value: string) => void;
  tagsValue: string;
  onTagsValueChange: (value: string) => void;
  onRenameSession: () => Promise<void>;
  onSaveOrganization: () => Promise<void>;
  onTogglePinSession: () => Promise<void>;
  onToggleArchiveSession: () => Promise<void>;
  onDeleteSession: () => void;
  onAssignProject: (value: string) => Promise<void>;
  onExportSnapshot: () => void;
  onExportRunBundle?: () => void;
  onIntegrationConnectionIdChange: (value: string) => void;
  onIntegrationTargetChange: (value: string) => void;
  onSaveExternalBinding: () => Promise<void>;
}
