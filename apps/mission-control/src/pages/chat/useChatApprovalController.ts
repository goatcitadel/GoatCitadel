import type {
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatDelegationSuggestionRecord,
  ChatSpecialistCandidateSuggestionRecord,
} from "@goatcitadel/contracts";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";
import {
  abortActiveChatStream,
  type ActiveChatStreamState,
  type PendingApprovalState,
  type PendingUserInputState,
} from "./useChatOutboundExecution";

export function useChatApprovalController(input: {
  selectedSessionId: string | null;
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
  setPendingAttachments: Dispatch<SetStateAction<ChatAttachmentRecord[]>>;
  setEditingTurnId: (value: string | null) => void;
  setPendingApproval: (value: PendingApprovalState | null) => void;
  setPendingUserInput: (value: PendingUserInputState | null) => void;
  setDelegationSuggestion: (value: ChatDelegationSuggestionRecord | null) => void;
  setCapabilitySuggestions: (value: ChatCapabilityUpgradeSuggestion[]) => void;
  setSpecialistSuggestions: (value: ChatSpecialistCandidateSuggestionRecord[]) => void;
  setSelectedTurnId: Dispatch<SetStateAction<string | null>>;
  setLocalNotices: Dispatch<SetStateAction<ChatThreadNotice[]>>;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
}) {
  const lastLoadedShellSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!input.selectedSessionId) {
      abortActiveChatStream(input.activeStreamRef.current);
      input.activeStreamRef.current = null;
      input.setSelectedTurnId(null);
      input.setLocalNotices([]);
      input.setPendingAttachments([]);
      input.setDelegationSuggestion(null);
      input.setCapabilitySuggestions([]);
      input.setSpecialistSuggestions([]);
      input.setPendingApproval(null);
      input.setPendingUserInput(null);
      lastLoadedShellSessionIdRef.current = null;
      return;
    }
    if (lastLoadedShellSessionIdRef.current !== input.selectedSessionId) {
      const hadActiveStream = input.activeStreamRef.current !== null;
      abortActiveChatStream(input.activeStreamRef.current);
      input.activeStreamRef.current = null;
      if (hadActiveStream) {
        input.pushLocalNotice(
          "Stream interrupted - switched sessions. The previous turn may still be processing on the server.",
          "warning",
        );
      }
      input.setPendingAttachments([]);
      input.setSelectedTurnId(null);
      input.setEditingTurnId(null);
      input.setLocalNotices([]);
      input.setPendingApproval(null);
      input.setPendingUserInput(null);
      input.setDelegationSuggestion(null);
      input.setCapabilitySuggestions([]);
      input.setSpecialistSuggestions([]);
      lastLoadedShellSessionIdRef.current = input.selectedSessionId;
    }
  }, [
    input.activeStreamRef,
    input.pushLocalNotice,
    input.selectedSessionId,
    input.setCapabilitySuggestions,
    input.setDelegationSuggestion,
    input.setEditingTurnId,
    input.setLocalNotices,
    input.setPendingApproval,
    input.setPendingUserInput,
    input.setPendingAttachments,
    input.setSelectedTurnId,
    input.setSpecialistSuggestions,
  ]);

  return undefined;
}
