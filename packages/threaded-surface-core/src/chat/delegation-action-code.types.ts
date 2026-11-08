import type { ChatDelegateRequest, ChatDelegateResponse, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ActiveChatDelegationRun, ChatProactivePolicyPatch, UseChatDelegationPolicyActionsInput } from "./useChatDelegationPolicyActions";

export interface ActiveExplorerObservation {
  controller: AbortController;
  generation: number;
  sessionId: string;
  parentRunId: string;
  stepIds: Set<string>;
  handoffRequested: boolean;
}

export interface DelegationActionOwner {
  input: UseChatDelegationPolicyActionsInput;
  delegationSuggestion: import("@goatcitadel/contracts").ChatDelegationSuggestionRecord | null;
  activeDelegationRun: ActiveChatDelegationRun | null;
  selectedTurn: ChatThreadTurnRecord | null;
  activeWorkflowTurn: ChatThreadTurnRecord | null;
  selectedTurnHasDelegation: boolean;
  setActiveDelegationRun: Dispatch<SetStateAction<ActiveChatDelegationRun | null>>;
  setDelegationSuggestion: Dispatch<SetStateAction<DelegationActionOwner["delegationSuggestion"]>>;
  setProactivePolicyDraft: Dispatch<SetStateAction<ChatProactivePolicyPatch | null>>;
  setProactivePolicyConflict: Dispatch<SetStateAction<boolean>>;
  directDelegationGenerationRef: MutableRefObject<number>;
  activeExplorerObservationRef: MutableRefObject<ActiveExplorerObservation | null>;
  explorerAttentionGenerationRef: MutableRefObject<number>;
  isCurrent(): boolean;
}
export interface DelegationActions {
  handleRunQuickResearch(): Promise<void>;
  handleProactivePolicyPatch(patch: ChatProactivePolicyPatch): Promise<void>;
  handleTriggerProactive(): Promise<void>;
  handleSuggestDelegation(): Promise<void>;
  handleAcceptDelegation(): Promise<void>;
  handleRunCodeDelegation(preset: "implement" | "review" | "test" | "ship"): Promise<void>;
  handleExploreWorkspace(): Promise<void>;
  runDelegationAction(sessionId: string, request: ChatDelegateRequest, label: string): Promise<ChatDelegateResponse>;
}
