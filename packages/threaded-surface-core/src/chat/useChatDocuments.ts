import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  ChatSessionRecord,
  ChatRoutedContextRef,
  NoteRecord,
  DocumentPatchProposalRecord,
  ChatGeneratedArtifactRecord,
} from "@goatcitadel/contracts";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";
import type { useChatSessionData } from "./useChatSessionData";

type DocumentsApi = typeof import("./chat-documents-api.js");
let documentsApi: Promise<DocumentsApi> | undefined;

function loadDocumentsApi() {
  return (documentsApi ??= import("./chat-documents-api.js").catch((error: unknown) => {
    documentsApi = undefined;
    throw error;
  }));
}

function documentAccessFence() {
  const installation = getGatewayApiBaseUrl();
  const access = getGatewayAccessRevision();
  const caller = getGatewayCallerScopeRevision();
  return () =>
    installation === getGatewayApiBaseUrl() &&
    access === getGatewayAccessRevision() &&
    caller === getGatewayCallerScopeRevision();
}

type Input = {
  workspaceId: string;
  selectedSession: ChatSessionRecord | null;
  selectedSessionId: string | null;
  documentEditingEnabled: boolean;
  readEnabled?: boolean;
  explicitContextEnabled?: boolean;
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
  readEnabled,
  explicitContextEnabled = false,
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
  const documentLifetime = useRef(0);
  const ownsDocuments = () => documentOwner.current.generation === documentGeneration;
  async function invokeDocument<T>(dispatch: (api: DocumentsApi) => Promise<T>): Promise<T> {
    const accessCurrent = documentAccessFence();
    const lifetime = documentLifetime.current;
    const api = await loadDocumentsApi();
    if (!accessCurrent() || !ownsDocuments() || documentLifetime.current !== lifetime) {
      throw new DOMException("Chat document context changed.", "AbortError");
    }
    return dispatch(api);
  }
  const [documentNotes, setDocumentNotes] = useState<NoteRecord[]>([]);
  const [documentProposals, setDocumentProposals] = useState<DocumentPatchProposalRecord[]>([]);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [pendingDocumentContextRefs, setPendingDocumentContextRefs] = useState<ChatRoutedContextRef[]>([]);
  const refreshDocuments = useCallback(async () => {
    if (documentOwner.current.generation !== documentGeneration) return;
    const request = ++documentRequest.current;
    const accessCurrent = documentAccessFence();
    const ownsRead = () =>
      documentOwner.current.generation === documentGeneration && documentRequest.current === request;
    const current = () => accessCurrent() && ownsRead();
    if (!documentEditingEnabled || !selectedSessionId) {
      setDocumentNotes([]);
      setDocumentProposals([]);
      setDocumentLoading(false);
      return;
    }
    setDocumentLoading(true);
    try {
      const { listNotes, listDocumentPatchProposals } = await loadDocumentsApi();
      if (!current()) return;
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
      if (ownsRead()) setDocumentLoading(false);
    }
  }, [documentEditingEnabled, documentGeneration, documentWorkspaceId, selectedSessionId, setUiError]);
  useEffect(() => {
    setPendingDocumentContextRefs([]);
    setDocumentNotes([]);
    setDocumentProposals([]);
    return () => {
      documentRequest.current += 1;
      documentLifetime.current += 1;
    };
  }, [documentGeneration]);
  useEffect(() => {
    if (readEnabled !== false) void refreshDocuments();
    else setDocumentLoading(false);
    return () => {
      documentRequest.current += 1;
    };
  }, [refreshDocuments, readEnabled]);
  const toggleDocumentContext = useCallback(
    (ref: ChatRoutedContextRef, allowAddition = true) => {
      setPendingDocumentContextRefs((current) => {
        const key = `${ref.kind}:${ref.ref}`;
        if (current.some((item) => `${item.kind}:${item.ref}` === key)) {
          return current.filter((item) => `${item.kind}:${item.ref}` !== key);
        }
        return explicitContextEnabled && allowAddition ? [...current, ref] : current;
      });
    },
    [explicitContextEnabled],
  );
  const includeDocumentContext = useCallback(
    (ref: ChatRoutedContextRef) => {
      if (!explicitContextEnabled) return;
      setPendingDocumentContextRefs((current) =>
        current.some((item) => item.kind === ref.kind && item.ref === ref.ref) ? current : [...current, ref],
      );
    },
    [explicitContextEnabled],
  );

  const documents: ChatContextDockPanelsProps["documents"] = selectedSession
    ? {
        enabled: documentEditingEnabled,
        contextInclusionEnabled: explicitContextEnabled,
        loading: documentLoading,
        notes: documentNotes,
        artifacts: artifacts,
        proposals: documentProposals,
        includedRefs: pendingDocumentContextRefs,
        onRefresh: refreshDocuments,
        onToggleInclude: toggleDocumentContext,
        onSaveNote: async (note, body) => {
          const noteId = note.noteId;
          const patch = {
            workspaceId: documentWorkspaceId,
            body,
            expectedRevision: note.revision,
          };
          const updated = await invokeDocument(({ updateNote }) => updateNote(noteId, patch));
          await refreshDocuments();
          return updated;
        },
        onSaveArtifact: async (artifact, content) => {
          if (!artifact.contentHash) throw new Error("Artifact content hash is unavailable.");
          const artifactId = artifact.artifactId;
          const version = {
            workspaceId: documentWorkspaceId,
            baseContentHash: artifact.contentHash,
            content,
          };
          const response = await invokeDocument(({ createChatGeneratedArtifactVersion }) =>
            createChatGeneratedArtifactVersion(artifactId, version),
          );
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
          const proposal = {
            ...input,
            workspaceId: documentWorkspaceId,
            sessionId: selectedSession.sessionId,
          };
          const response = await invokeDocument(({ createDocumentPatchProposal }) =>
            createDocumentPatchProposal(proposal),
          );
          await refreshDocuments();
          return response.item;
        },
        onApplyProposal: async (proposalId) => {
          const response = await invokeDocument(({ applyDocumentPatchProposal }) =>
            applyDocumentPatchProposal(proposalId, documentWorkspaceId),
          );
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
          const response = await invokeDocument(({ rejectDocumentPatchProposal }) =>
            rejectDocumentPatchProposal(proposalId, documentWorkspaceId),
          );
          await refreshDocuments();
          return response.item;
        },
      }
    : undefined;

  return {
    documents,
    documentOwner,
    pendingDocumentContextRefs,
    setPendingDocumentContextRefs,
    includeDocumentContext,
  };
}
