import type { InitialOutboundSessionCreation } from "../useChatSessionControls";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { useRef } from "react";
import { captureOutboundRequestPrefsSnapshot, type ActiveChatStreamState } from "../useChatOutboundExecution";
import { type OutboundQueueItem, type OutboundRequestPrefsSnapshot } from "../useChatSurfaceOrchestration";

/** Creates stable cross-owner refs. Owners publish into them at their original render and effect boundaries. */
export function useChatControllerCoordination() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastLocalPrefMutationAtRef = useRef(0);
  const prefMutationSequenceRef = useRef(0);
  const lastPublishedWorkTrustSummaryRef = useRef<string | null>(null);
  const lastCapabilitySuggestionSyncKeyRef = useRef<string | null>(null);
  const lastSpecialistSuggestionSyncKeyRef = useRef<string | null>(null);
  const executeOutboundItemRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const tryBeginOutboundExecutionRef = useRef<() => boolean>(() => false);
  const queuedOutboundSetterRef = useRef<React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>>(() => []);
  const outboundRequestPrefsSnapshotRef = useRef<OutboundRequestPrefsSnapshot>(
    captureOutboundRequestPrefsSnapshot({ prefs: null }),
  );
  const pushLocalNoticeRef = useRef<(message: string, tone?: ChatThreadNotice["tone"]) => void>(() => undefined);
  const applyFetchedThreadRef = useRef<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>(
    () => false,
  );
  const messageMutationVersionRef = useRef(0);
  const loadSessionCoreStateRef = useRef<
    (sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>
  >(async () => undefined);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  // HX-411: mirrors server truth so operator Chat send fails closed while an
  // external session_control_client owns the current session. Read synchronously
  // by the keyboard/composer send path; never optimistically cleared on SSE drop.
  const sessionControlSendLockedRef = useRef(false);

  const initialOutboundSessionCreationRef = useRef<InitialOutboundSessionCreation | null>(null);
  return {
    initialOutboundSessionCreationRef,
    pushLocalNoticeRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
    composerRef,
    loadSessionCoreStateRef,
    sessionControlSendLockedRef,
    queuedOutboundSetterRef,
    activeStreamRef,
    tryBeginOutboundExecutionRef,
    executeOutboundItemRef,
    outboundRequestPrefsSnapshotRef,
    lastPublishedWorkTrustSummaryRef,
    lastCapabilitySuggestionSyncKeyRef,
    lastSpecialistSuggestionSyncKeyRef,
    prefMutationSequenceRef,
    fileInputRef,
  };
}
