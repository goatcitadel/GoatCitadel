import { useCallback } from "react";
import { type SessionMetadataConflictDraft } from "../useChatSessionControls";
import { useChatThreadController } from "../useChatThreadController";
import { useChatMetadataDraftState } from "./useChatMetadataDraftState";

type Input = {
  metadataDraft: Pick<
    ReturnType<typeof useChatMetadataDraftState>,
    "sessionMetadataConflictDraftRef" | "setFolderName" | "setTagsValue"
  >;
  setRenameTitle: React.Dispatch<React.SetStateAction<string>>;
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession">;
};

/** Preserves local metadata drafts and their conflict snapshot on edits. */
export function useChatMetadataDraftActions({ metadataDraft, setRenameTitle, threadController }: Input) {
  const { setFolderName } = metadataDraft;
  const { setTagsValue } = metadataDraft;

  const handleSessionMetadataConflictDraftChange = useCallback(
    (draft: SessionMetadataConflictDraft | null) => {
      metadataDraft.sessionMetadataConflictDraftRef.current = draft;
    },
    [metadataDraft.sessionMetadataConflictDraftRef],
  );

  const handleRenameTitleChange = useCallback(
    (value: string) => {
      setRenameTitle(value);
      const conflictDraft = metadataDraft.sessionMetadataConflictDraftRef.current;
      if (conflictDraft?.kind === "rename" && conflictDraft.sessionId === threadController.selectedSession?.sessionId) {
        metadataDraft.sessionMetadataConflictDraftRef.current = { ...conflictDraft, renameTitle: value };
      }
    },
    [threadController.selectedSession?.sessionId, metadataDraft.sessionMetadataConflictDraftRef, setRenameTitle],
  );

  const handleFolderNameChange = useCallback(
    (value: string) => {
      setFolderName(value);
      const conflictDraft = metadataDraft.sessionMetadataConflictDraftRef.current;
      if (
        conflictDraft?.kind === "organization" &&
        conflictDraft.sessionId === threadController.selectedSession?.sessionId
      ) {
        metadataDraft.sessionMetadataConflictDraftRef.current = { ...conflictDraft, folderName: value };
      }
    },
    [threadController.selectedSession?.sessionId, metadataDraft.sessionMetadataConflictDraftRef, setFolderName],
  );

  const handleTagsValueChange = useCallback(
    (value: string) => {
      setTagsValue(value);
      const conflictDraft = metadataDraft.sessionMetadataConflictDraftRef.current;
      if (
        conflictDraft?.kind === "organization" &&
        conflictDraft.sessionId === threadController.selectedSession?.sessionId
      ) {
        metadataDraft.sessionMetadataConflictDraftRef.current = { ...conflictDraft, tagsValue: value };
      }
    },
    [threadController.selectedSession?.sessionId, metadataDraft.sessionMetadataConflictDraftRef, setTagsValue],
  );

  return {
    handleSessionMetadataConflictDraftChange,
    handleRenameTitleChange,
    handleFolderNameChange,
    handleTagsValueChange,
  };
}
