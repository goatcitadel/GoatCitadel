import type {
  ChatMessageRecord,
  ChatMode,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSpecialistCandidateRecord,
  ChatThreadResponse,
  LearnedMemoryItemRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  ProactivePolicy,
  ProactiveRunRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import type { MutableRefObject } from "react";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";
import { useChatDelegationPolicyActions } from "./useChatDelegationPolicyActions";
import { useChatMemoryRefreshActions } from "./useChatMemoryRefreshActions";
import { useChatSpecialistCapabilityActions } from "./useChatSpecialistCapabilityActions";

export function useChatContextActions(input: {
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  selectedTurnId: string | null;
  thread: ChatThreadResponse | null;
  draft: string;
  messages: ChatMessageRecord[];
  prefs: ChatSessionPrefsRecord | null;
  selectedProviderId?: string;
  selectedModel?: string;
  surfaceMode: ChatMode;
  fullWebAccess?: boolean;
  sending: boolean;
  streamEnabled: boolean;
  codeModeNeedsProjectBinding: boolean;
  loadSidebar: () => Promise<void>;
  ensureSession: () => Promise<ChatSessionRecord>;
  setError: (value: string | null) => void;
  setSending: (value: boolean) => void;
  setPrefs: React.Dispatch<React.SetStateAction<ChatSessionPrefsRecord | null>>;
  setProactiveStatus: React.Dispatch<React.SetStateAction<ProactivePolicy | null>>;
  setProactiveRuns: React.Dispatch<React.SetStateAction<ProactiveRunRecord[]>>;
  learnedMemory: LearnedMemoryItemRecord[];
  setLearnedMemory: React.Dispatch<React.SetStateAction<LearnedMemoryItemRecord[]>>;
  specialistCandidates: ChatSpecialistCandidateRecord[];
  setSpecialistCandidates: React.Dispatch<React.SetStateAction<ChatSpecialistCandidateRecord[]>>;
  setInstalledSkills: React.Dispatch<React.SetStateAction<SkillListItem[]>>;
  setMcpServers: React.Dispatch<React.SetStateAction<McpServerRecord[]>>;
  setMcpTemplates: React.Dispatch<React.SetStateAction<Array<McpServerTemplateRecord & { installed: boolean }>>>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  lastLocalPrefMutationAtRef: MutableRefObject<number>;
  executeOutboundItemRef: MutableRefObject<(item: OutboundQueueItem) => Promise<void>>;
  tryBeginOutboundExecutionRef: MutableRefObject<() => boolean>;
  setQueuedOutbound: React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>;
}) {
  const delegationPolicyActions = useChatDelegationPolicyActions(input);
  const memoryRefreshActions = useChatMemoryRefreshActions({
    selectedSession: input.selectedSession,
    sending: input.sending,
    setSending: input.setSending,
    setError: input.setError,
    setLearnedMemory: input.setLearnedMemory,
  });
  const specialistCapabilityActions = useChatSpecialistCapabilityActions({
    selectedSessionId: input.selectedSessionId,
    selectedSession: input.selectedSession,
    selectedTurnId: input.selectedTurnId,
    sending: input.sending,
    setError: input.setError,
    setSending: input.setSending,
    setSpecialistCandidates: input.setSpecialistCandidates,
    setInstalledSkills: input.setInstalledSkills,
    setMcpServers: input.setMcpServers,
    setMcpTemplates: input.setMcpTemplates,
    pushLocalNotice: input.pushLocalNotice,
    executeOutboundItemRef: input.executeOutboundItemRef,
    tryBeginOutboundExecutionRef: input.tryBeginOutboundExecutionRef,
    setQueuedOutbound: input.setQueuedOutbound,
  });

  return {
    ...delegationPolicyActions,
    ...memoryRefreshActions,
    ...specialistCapabilityActions,
  };
}
