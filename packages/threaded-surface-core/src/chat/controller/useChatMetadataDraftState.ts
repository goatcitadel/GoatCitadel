import type { ChatSessionPrefsPatch } from "@goatcitadel/contracts";
import { useRef, useState } from "react";
import { type SessionMetadataConflictDraft } from "../useChatSessionControls";

/** Owns unsubmitted organization and preference conflict drafts. */
export function useChatMetadataDraftState() {
  const [folderName, setFolderName] = useState("");
  const [tagsValue, setTagsValue] = useState("");
  const sessionMetadataConflictDraftRef = useRef<SessionMetadataConflictDraft | null>(null);
  const [preferenceConflictDraft, setPreferenceConflictDraft] = useState<{
    sessionId: string;
    patch: ChatSessionPrefsPatch;
  } | null>(null);

  return {
    sessionMetadataConflictDraftRef,
    setFolderName,
    setTagsValue,
    folderName,
    tagsValue,
    preferenceConflictDraft,
    setPreferenceConflictDraft,
  };
}
