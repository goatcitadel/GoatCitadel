import type {
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatDelegationSuggestionRecord,
  ChatSpecialistCandidateSuggestionRecord,
} from "@goatcitadel/contracts";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadView";
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
  const {
    selectedSessionId,
    activeStreamRef,
    setPendingAttachments,
    setEditingTurnId,
    setPendingApproval,
    setPendingUserInput,
    setDelegationSuggestion,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    setSelectedTurnId,
    setLocalNotices,
    pushLocalNotice,
  } = input;
  const lastLoadedShellSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedSessionId) {
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      setSelectedTurnId(null);
      setLocalNotices([]);
      setPendingAttachments([]);
      setDelegationSuggestion(null);
      setCapabilitySuggestions([]);
      setSpecialistSuggestions([]);
      setPendingApproval(null);
      setPendingUserInput(null);
      lastLoadedShellSessionIdRef.current = null;
      return;
    }
    if (lastLoadedShellSessionIdRef.current !== selectedSessionId) {
      const hadActiveStream = activeStreamRef.current !== null;
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (hadActiveStream) {
        pushLocalNotice(
          "Stream interrupted - switched sessions. The previous turn may still be processing on the server.",
          "warning",
        );
      }
      setPendingAttachments([]);
      setSelectedTurnId(null);
      setEditingTurnId(null);
      setLocalNotices([]);
      setPendingApproval(null);
      setPendingUserInput(null);
      setDelegationSuggestion(null);
      setCapabilitySuggestions([]);
      setSpecialistSuggestions([]);
      lastLoadedShellSessionIdRef.current = selectedSessionId;
    }
  }, [
    activeStreamRef,
    pushLocalNotice,
    selectedSessionId,
    setCapabilitySuggestions,
    setDelegationSuggestion,
    setEditingTurnId,
    setLocalNotices,
    setPendingApproval,
    setPendingAttachments,
    setPendingUserInput,
    setSelectedTurnId,
    setSpecialistSuggestions,
  ]);

  return undefined;
}
