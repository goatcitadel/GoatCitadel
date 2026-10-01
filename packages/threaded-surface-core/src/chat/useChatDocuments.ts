import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  ChatSessionRecord,
  ChatRoutedContextRef,
  NoteRecord,
  DocumentPatchProposalRecord,
  ChatGeneratedArtifactRecord,
} from "@goatcitadel/contracts";
import {
  applyDocumentPatchProposal,
  createChatGeneratedArtifactVersion,
  createDocumentPatchProposal,
  listDocumentPatchProposals,
  rejectDocumentPatchProposal,
} from "@goatcitadel/mission-control-shared/api/chat";
import { listNotes, updateNote } from "@goatcitadel/mission-control-shared/api/personal-ops";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";
import type { useChatSessionData } from "./useChatSessionData";

type Input = {
  workspaceId: string;
  selectedSession: ChatSessionRecord | null;
  selectedSessionId: string | null;
  documentEditingEnabled: boolean;
  artifacts: ChatGeneratedArtifactRecord[];
  setUiError: (value: string | null) => void;
  setActiveGeneratedArtifact: Dispatch<SetStateAction<ChatGeneratedArtifactRecord | null>>;
  loadSessionSecondaryState: ReturnType<typeof useChatSessionData>["loadSessionSecondaryState"];
};

export function useChatDocuments({
  workspaceId,
  selectedSession,
  selectedSessionId,
  documentEditingEnabled,
  setUiError,
  setActiveGeneratedArtifact,
  loadSessionSecondaryState,
  artifacts,
}: Input) {
  const documentWorkspaceId = selectedSession?.workspaceId ?? workspaceId;
  const documentScope = JSON.stringify([documentWorkspaceId, selectedSessionId, documentEditingEnabled]);
  const documentOwner = useRef({ scope: documentScope, generation: 0 });
  if (documentOwner.current.scope !== documentScope)
    documentOwner.current = { scope: documentScope, generation: documentOwner.current.generation + 1 };
  const documentGeneration = documentOwner.current.generation;
  const documentRequest = useRef(0);
  const ownsDocuments = () => documentOwner.current.generation === documentGeneration;
  const [documentNotes, setDocumentNotes] = useState<NoteRecord[]>([]);
  const [documentProposals, setDocumentProposals] = useState<DocumentPatchProposalRecord[]>([]);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [pendingDocumentContextRefs, setPendingDocumentContextRefs] = useState<ChatRoutedContextRef[]>([]);
  const refreshDocuments = useCallback(async () => {
    if (documentOwner.current.generation !== documentGeneration) return;
    const request = ++documentRequest.current;
    const current = () =>
      documentOwner.current.generation === documentGeneration && documentRequest.current === request;
    if (!documentEditingEnabled || !selectedSessionId) {
      setDocumentNotes([]);
      setDocumentProposals([]);
      setDocumentLoading(false);
      return;
    }
    setDocumentLoading(true);
    try {
      const [notesResponse, proposalsResponse] = await Promise.all([
        listNotes(documentWorkspaceId),
        listDocumentPatchProposals({ workspaceId: documentWorkspaceId, sessionId: selectedSessionId }),
      ]);
      if (!current()) return;
      setDocumentNotes(notesResponse.items);
      setDocumentProposals(proposalsResponse.items);
    } catch (error) {
      if (current()) setUiError(error instanceof Error ? error.message : "Unable to refresh Chat documents.");
    } finally {
      if (current()) setDocumentLoading(false);
    }
  }, [documentEditingEnabled, documentGeneration, documentWorkspaceId, selectedSessionId, setUiError]);
  useEffect(() => {
    setPendingDocumentContextRefs([]);
    setDocumentNotes([]);
    setDocumentProposals([]);
    void refreshDocuments();
    return () => {
      documentRequest.current += 1;
    };
  }, [refreshDocuments]);
  const toggleDocumentContext = useCallback((ref: ChatRoutedContextRef) => {
    setPendingDocumentContextRefs((current) => {
      const key = `${ref.kind}:${ref.ref}`;
      return current.filter((item) => `${item.kind}:${item.ref}` !== key);
    });
  }, []);

  const documents: ChatContextDockPanelsProps["documents"] = selectedSession
    ? {
        enabled: documentEditingEnabled,
        loading: documentLoading,
        notes: documentNotes,
        artifacts: artifacts,
        proposals: documentProposals,
        includedRefs: pendingDocumentContextRefs,
        onRefresh: refreshDocuments,
        onToggleInclude: toggleDocumentContext,
        onSaveNote: async (note, body) => {
          const updated = await updateNote(note.noteId, {
            workspaceId: documentWorkspaceId,
            body,
            expectedRevision: note.revision,
          });
          await refreshDocuments();
          return updated;
        },
        onSaveArtifact: async (artifact, content) => {
          if (!artifact.contentHash) throw new Error("Artifact content hash is unavailable.");
          const response = await createChatGeneratedArtifactVersion(artifact.artifactId, {
            workspaceId: documentWorkspaceId,
            baseContentHash: artifact.contentHash,
            content,
          });
          if (ownsDocuments()) {
            setActiveGeneratedArtifact(response.item);
            await loadSessionSecondaryState(selectedSession.sessionId, { background: true }).catch((error: unknown) => {
              if (ownsDocuments())
                setUiError(
                  error instanceof Error ? error.message : "Artifact saved; refreshed evidence is unavailable.",
                );
            });
          }
          return response.item;
        },
        onCreateProposal: async (input) => {
          const response = await createDocumentPatchProposal({
            ...input,
            workspaceId: documentWorkspaceId,
            sessionId: selectedSession.sessionId,
          });
          await refreshDocuments();
          return response.item;
        },
        onApplyProposal: async (proposalId) => {
          const response = await applyDocumentPatchProposal(proposalId, documentWorkspaceId);
          if (ownsDocuments())
            await Promise.all([
              refreshDocuments(),
              loadSessionSecondaryState(selectedSession.sessionId, { background: true }),
            ]).catch((error: unknown) => {
              if (ownsDocuments())
                setUiError(
                  error instanceof Error ? error.message : "Proposal applied; refreshed evidence is unavailable.",
                );
            });
          return response.item;
        },
        onRejectProposal: async (proposalId) => {
          const response = await rejectDocumentPatchProposal(proposalId, documentWorkspaceId);
          await refreshDocuments();
          return response.item;
        },
      }
    : undefined;

  return { documents, documentOwner, pendingDocumentContextRefs, setPendingDocumentContextRefs };
}
