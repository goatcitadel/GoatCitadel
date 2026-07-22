import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatRoutedContextRef, ExternalSessionAttachmentRecord } from "@goatcitadel/contracts";
import {
  attachExternalSourceToSession,
  detachExternalSourceAttachment,
  fetchExternalSessionAttachments,
  isExternalSourceCapabilityAbsent,
  requestExternalSourceKnowledgeSnapshot,
} from "@goatcitadel/mission-control-shared/api/external-sources";

/**
 * HX-407 C3 Chat-side external-source attachment state.
 *
 * Owns the durable content-free attachment list for the selected session, the
 * EXPLICIT per-turn selection, and the attach / detach / knowledge-request
 * actions over the typed client. Everything here is inert until C4 composes the
 * Gateway routes: the list read 404s, which this hook treats as "capability
 * absent" (`supported: false`, controls hidden, no error spam) — the same
 * degradation shape as `useChatCapabilityProfileInspection`'s 404 branch.
 *
 * Mutations additionally require the current session incarnation (a C1 CAS
 * precondition the Gateway does not yet expose to clients); until C4 surfaces
 * it through `sessionIncarnationId`, attach/detach/knowledge-request stay
 * disabled while list/chips/selection remain fully live.
 *
 * Selection freezing: `captureOutboundExternalContextRefs` snapshots the
 * selection as frozen `external_attachment` routed-context refs for one queue
 * item, and `handleOutboundExternalContextSent` clears exactly those refs only
 * after the send succeeds (failed/aborted sends retain the selection).
 */
export interface UseExternalSourceAttachmentsInput {
  workspaceId: string;
  sessionId: string | null;
  /** Current session incarnation once C4 exposes it; null keeps mutations disabled (fail closed). */
  sessionIncarnationId?: string | null;
  pushLocalNotice?: (content: string, tone?: "neutral" | "success" | "warning") => void;
}

export interface ExternalSourceAttachInputSeed {
  sourceId: string;
  importId: string;
  itemId: string;
}

export interface ExternalSourceAttachmentsState {
  /** null = not yet probed for this session; false = capability absent (pre-C4); true = live. */
  supported: boolean | null;
  loading: boolean;
  /** Non-404 load failure only; capability absence is never an error. */
  error: string | null;
  /** Live read-only attachments (status "attached") for the selected session. */
  attachments: readonly ExternalSessionAttachmentRecord[];
  /** Explicit per-turn selection, in toggle order. */
  selectedAttachmentIds: readonly string[];
  /** Attachment id with an in-flight mutation, if any. */
  busyAttachmentId: string | null;
  /** True when attach/detach/knowledge-request may run (capability live + incarnation known). */
  canMutate: boolean;
  reload: () => Promise<void>;
  toggleSelection: (attachmentId: string) => void;
  clearSelection: () => void;
  attach: (seed: ExternalSourceAttachInputSeed) => Promise<boolean>;
  detach: (attachmentId: string) => Promise<boolean>;
  requestKnowledgeSnapshot: (attachmentId: string) => Promise<boolean>;
  captureOutboundExternalContextRefs: () => readonly ChatRoutedContextRef[];
  handleOutboundExternalContextSent: (item: { externalContextRefs?: readonly ChatRoutedContextRef[] }) => void;
}

function describeAttachmentLabel(attachment: ExternalSessionAttachmentRecord): string {
  return `External ${attachment.itemId}`.slice(0, 160);
}

export function useExternalSourceAttachments(input: UseExternalSourceAttachmentsInput): ExternalSourceAttachmentsState {
  const { workspaceId, sessionId, pushLocalNotice } = input;
  const sessionIncarnationId = input.sessionIncarnationId ?? null;
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly ExternalSessionAttachmentRecord[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<readonly string[]>([]);
  const [busyAttachmentId, setBusyAttachmentId] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const reload = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setLoading(true);
    try {
      const list = await fetchExternalSessionAttachments(sessionId, workspaceId);
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      const live = list.items.filter((item) => item.status === "attached");
      setSupported(true);
      setError(null);
      setAttachments(live);
      const liveIds = new Set(live.map((item) => item.attachmentId));
      setSelectedAttachmentIds((current) => {
        const next = current.filter((id) => liveIds.has(id));
        return next.length === current.length ? current : next;
      });
    } catch (loadError) {
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      if (isExternalSourceCapabilityAbsent(loadError)) {
        // Pre-C4 steady state: hide the controls, never spam an error.
        setSupported(false);
        setError(null);
        setAttachments([]);
        setSelectedAttachmentIds((current) => (current.length === 0 ? current : []));
      } else {
        setError("External source attachments are unavailable right now.");
      }
    } finally {
      if (loadSequenceRef.current === loadId) {
        setLoading(false);
      }
    }
  }, [sessionId, workspaceId]);

  useEffect(() => {
    loadSequenceRef.current += 1;
    setSupported(null);
    setError(null);
    setAttachments([]);
    setSelectedAttachmentIds([]);
    setBusyAttachmentId(null);
    if (!sessionId) {
      setLoading(false);
      return;
    }
    void reload();
  }, [reload, sessionId]);

  const toggleSelection = useCallback(
    (attachmentId: string) => {
      setSelectedAttachmentIds((current) => {
        if (current.includes(attachmentId)) {
          return current.filter((id) => id !== attachmentId);
        }
        if (!attachments.some((item) => item.attachmentId === attachmentId)) {
          return current;
        }
        return [...current, attachmentId];
      });
    },
    [attachments],
  );

  const clearSelection = useCallback(() => {
    setSelectedAttachmentIds((current) => (current.length === 0 ? current : []));
  }, []);

  const canMutate = supported === true && Boolean(sessionId) && Boolean(sessionIncarnationId);

  const runMutation = useCallback(
    async (busyKey: string, operation: () => Promise<void>, failureNotice: string): Promise<boolean> => {
      setBusyAttachmentId(busyKey);
      try {
        await operation();
        await reload();
        return true;
      } catch (mutationError) {
        if (isExternalSourceCapabilityAbsent(mutationError)) {
          setSupported(false);
          setAttachments([]);
          setSelectedAttachmentIds([]);
          return false;
        }
        pushLocalNotice?.(failureNotice, "warning");
        return false;
      } finally {
        setBusyAttachmentId(null);
      }
    },
    [pushLocalNotice, reload],
  );

  const attach = useCallback(
    async (seed: ExternalSourceAttachInputSeed): Promise<boolean> => {
      if (!canMutate || !sessionId || !sessionIncarnationId) {
        return false;
      }
      return runMutation(
        `attach:${seed.itemId}`,
        async () => {
          await attachExternalSourceToSession({
            workspaceId,
            sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
            sourceId: seed.sourceId,
            importId: seed.importId,
            itemId: seed.itemId,
          });
          pushLocalNotice?.("Attached the imported item read-only.", "success");
        },
        "The external source attach was rejected. Reload and retry.",
      );
    },
    [canMutate, pushLocalNotice, runMutation, sessionId, sessionIncarnationId, workspaceId],
  );

  const detach = useCallback(
    async (attachmentId: string): Promise<boolean> => {
      const attachment = attachments.find((item) => item.attachmentId === attachmentId);
      if (!canMutate || !sessionId || !sessionIncarnationId || !attachment) {
        return false;
      }
      return runMutation(
        attachmentId,
        async () => {
          await detachExternalSourceAttachment({
            workspaceId,
            sessionId,
            attachmentId,
            expectedRevision: attachment.revision,
            expectedSessionIncarnationId: sessionIncarnationId,
          });
          pushLocalNotice?.("Detached the external source. Imported evidence remains immutable.", "neutral");
        },
        "The external source detach was rejected. Reload and retry.",
      );
    },
    [attachments, canMutate, pushLocalNotice, runMutation, sessionId, sessionIncarnationId, workspaceId],
  );

  const requestKnowledgeSnapshot = useCallback(
    async (attachmentId: string): Promise<boolean> => {
      const attachment = attachments.find((item) => item.attachmentId === attachmentId);
      if (!canMutate || !sessionId || !sessionIncarnationId || !attachment) {
        return false;
      }
      return runMutation(
        `knowledge:${attachmentId}`,
        async () => {
          const receipt = await requestExternalSourceKnowledgeSnapshot({
            workspaceId,
            sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
            attachmentId,
            importId: attachment.importId,
            itemId: attachment.itemId,
            expectedAttachmentRevision: attachment.revision,
          });
          pushLocalNotice?.(
            receipt.approvalId
              ? `Knowledge copy requested. Resolve approval ${receipt.approvalId.slice(-8)} in the approvals inbox.`
              : "Knowledge copy requested. Resolve it in the approvals inbox.",
            "success",
          );
        },
        "The knowledge copy request was rejected. Reload and retry.",
      );
    },
    [attachments, canMutate, pushLocalNotice, runMutation, sessionId, sessionIncarnationId, workspaceId],
  );

  // Read via refs inside the capture callback so the queue can freeze the
  // CURRENT selection at enqueue time while the callback identity stays stable
  // for the orchestration hook (synced-ref pattern).
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const selectedRef = useRef(selectedAttachmentIds);
  selectedRef.current = selectedAttachmentIds;

  const captureOutboundExternalContextRefs = useCallback((): readonly ChatRoutedContextRef[] => {
    const live = new Map(attachmentsRef.current.map((item) => [item.attachmentId, item] as const));
    return selectedRef.current.flatMap((attachmentId) => {
      const attachment = live.get(attachmentId);
      if (!attachment) {
        return [];
      }
      return [
        {
          kind: "external_attachment" as const,
          ref: attachment.attachmentId,
          label: describeAttachmentLabel(attachment),
        },
      ];
    });
  }, []);

  const handleOutboundExternalContextSent = useCallback(
    (item: { externalContextRefs?: readonly ChatRoutedContextRef[] }) => {
      const sent = new Set(
        (item.externalContextRefs ?? []).filter((ref) => ref.kind === "external_attachment").map((ref) => ref.ref),
      );
      if (sent.size === 0) {
        return;
      }
      setSelectedAttachmentIds((current) => {
        const next = current.filter((id) => !sent.has(id));
        return next.length === current.length ? current : next;
      });
    },
    [],
  );

  return useMemo(
    () => ({
      supported,
      loading,
      error,
      attachments,
      selectedAttachmentIds,
      busyAttachmentId,
      canMutate,
      reload,
      toggleSelection,
      clearSelection,
      attach,
      detach,
      requestKnowledgeSnapshot,
      captureOutboundExternalContextRefs,
      handleOutboundExternalContextSent,
    }),
    [
      supported,
      loading,
      error,
      attachments,
      selectedAttachmentIds,
      busyAttachmentId,
      canMutate,
      reload,
      toggleSelection,
      clearSelection,
      attach,
      detach,
      requestKnowledgeSnapshot,
      captureOutboundExternalContextRefs,
      handleOutboundExternalContextSent,
    ],
  );
}
