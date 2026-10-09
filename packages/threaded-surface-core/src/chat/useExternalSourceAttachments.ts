import { useScopedOperation } from "@goatcitadel/mission-control-shared/hooks/use-scoped-operation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type {
  ChatRoutedContextRef,
  ExternalSessionAttachmentRecord,
  ExternalSourceAttachmentCandidateRecord,
} from "@goatcitadel/contracts";
import {
  attachExternalSourceToSession,
  detachExternalSourceAttachment,
  fetchExternalSessionAttachments,
  fetchExternalSourceAttachmentCandidates,
  isExternalSourceCapabilityAbsent,
  requestExternalSourceKnowledgeSnapshot,
} from "@goatcitadel/mission-control-shared/api/external-sources";

/**
 * HX-407 C3/C4b Chat-side external-source attachment state.
 *
 * Owns the durable content-free attachment list for the selected session, the
 * EXPLICIT per-turn selection, and the attach / detach / knowledge-request
 * actions over the typed client. When the Gateway does not compose the routes
 * the list read 404s, which this hook treats as "capability absent"
 * (`supported: false`, controls hidden, no error spam) — the same degradation
 * shape as `useChatCapabilityProfileInspection`'s 404 branch.
 *
 * Mutations require the current session incarnation (the C1 exact-CAS
 * precondition). Since C4 the durable reload response carries it as
 * `sessionIncarnationId`, so the hook activates attach/detach/knowledge-request
 * exactly when the server supplies the value — the freshest list-carried
 * incarnation always wins over the optional host-supplied seam, and a response
 * without one keeps the mutations disabled fail-closed while list / chips /
 * selection remain fully live.
 *
 * Selection freezing: `captureOutboundExternalContextRefs` snapshots the
 * selection as frozen `external_attachment` routed-context refs for one queue
 * item, and `handleOutboundExternalContextSent` clears exactly those refs only
 * after the send succeeds (failed/aborted sends retain the selection).
 */
export interface UseExternalSourceAttachmentsInput {
  workspaceId: string;
  sessionId: string | null;
  /**
   * Optional host-supplied session incarnation, used only while the durable
   * reload has not yet carried one (the list-carried value is fresher and wins).
   * Absent both, mutations stay disabled (fail closed).
   */
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
  /** Content-free, server-filtered applied import items eligible for this session. */
  candidates: readonly ExternalSourceAttachmentCandidateRecord[];
  /** False when the candidate-list endpoint is absent while legacy attachment routes remain live. */
  candidatesSupported: boolean | null;
  /** Explicit per-turn selection, in toggle order. */
  selectedAttachmentIds: readonly string[];
  /** Attachment id with an in-flight mutation, if any. */
  busyAttachmentId: string | null;
  /** True when attach/detach/knowledge-request may run (capability live + incarnation known). */
  canMutate: boolean;
  /** Effective session incarnation (freshest list-carried value, else the host seam); null until known. */
  sessionIncarnationId: string | null;
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
  const attempt = useScopedOperation(JSON.stringify(["external-attachments", workspaceId, sessionId]));
  const { current: currentAccess, identity: accessIdentity, locked: operationLocked, run: runOperation } = attempt;
  const hostSessionIncarnationId = input.sessionIncarnationId ?? null;
  const [loadedIdentity, setLoadedIdentity] = useState<string>();
  const liveScope = loadedIdentity === accessIdentity && currentAccess();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly ExternalSessionAttachmentRecord[]>([]);
  const [candidates, setCandidates] = useState<readonly ExternalSourceAttachmentCandidateRecord[]>([]);
  const [candidatesSupported, setCandidatesSupported] = useState<boolean | null>(null);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<readonly string[]>([]);
  const [busyAttachmentId, setBusyAttachmentId] = useState<string | null>(null);
  // C4 activation seam: the durable reload response is the sanctioned place
  // clients learn the current server-owned incarnation. Only a successful load
  // updates it; a session switch or capability absence resets it to null so a
  // stale value can never authorize a mutation on the wrong session.
  const [listSessionIncarnationId, setListSessionIncarnationId] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const scopeGenerationRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const mutationActiveRef = useRef(false);

  const reload = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setLoading(true);
    try {
      const list = await fetchExternalSessionAttachments(sessionId, workspaceId);
      if (loadSequenceRef.current !== loadId || !currentAccess()) {
        return;
      }
      const live = list.items.filter((item) => item.status === "attached");
      setLoadedIdentity(accessIdentity);
      setSupported(true);
      setError(null);
      setAttachments(live);
      setListSessionIncarnationId(list.sessionIncarnationId ?? null);
      const liveIds = new Set(live.map((item) => item.attachmentId));
      setSelectedAttachmentIds((current) => {
        const next = current.filter((id) => liveIds.has(id));
        return next.length === current.length ? current : next;
      });
      try {
        const candidateList = await fetchExternalSourceAttachmentCandidates(sessionId, workspaceId, 100);
        if (loadSequenceRef.current !== loadId || !currentAccess()) {
          return;
        }
        setCandidates(candidateList.items);
        setCandidatesSupported(true);
      } catch (candidateError) {
        if (loadSequenceRef.current !== loadId || !currentAccess()) {
          return;
        }
        setCandidates([]);
        if (isExternalSourceCapabilityAbsent(candidateError)) {
          setCandidatesSupported(false);
        } else {
          setCandidatesSupported(true);
          setError(describeApiError(candidateError, "Eligible imported external items are unavailable right now.").summary);
        }
      }
    } catch (loadError) {
      if (loadSequenceRef.current !== loadId || !currentAccess()) {
        return;
      }
      if (isExternalSourceCapabilityAbsent(loadError)) {
        // Capability-absent steady state: hide the controls, never spam an error.
        setSupported(false);
        setError(null);
        setAttachments([]);
        setCandidates([]);
        setCandidatesSupported(false);
        setListSessionIncarnationId(null);
        setSelectedAttachmentIds((current) => (current.length === 0 ? current : []));
      } else {
        setError(describeApiError(loadError, "External source attachments are unavailable right now.").summary);
      }
    } finally {
      if (loadSequenceRef.current === loadId) {
        setLoading(false);
      }
    }
  }, [sessionId, workspaceId, accessIdentity, currentAccess]);

  useEffect(() => {
    scopeGenerationRef.current += 1;
    loadSequenceRef.current += 1;
    setLoadedIdentity(undefined);
    setSupported(null);
    setError(null);
    setAttachments([]);
    setCandidates([]);
    setCandidatesSupported(null);
    setSelectedAttachmentIds([]);
    setBusyAttachmentId(null);
    mutationActiveRef.current = false;
    setListSessionIncarnationId(null);
    if (sessionId) {
      void reload();
    } else {
      setLoading(false);
    }
    return () => {
      scopeGenerationRef.current += 1;
      loadSequenceRef.current += 1;
    };
  }, [reload, sessionId]);

  const toggleSelection = useCallback(
    (attachmentId: string) => {
      if (!liveScope || !currentAccess()) return;
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
    [attachments, liveScope, currentAccess],
  );

  const clearSelection = useCallback(() => {
    setSelectedAttachmentIds((current) => (current.length === 0 ? current : []));
  }, []);

  // Freshest truth wins: the list-carried incarnation reflects the durable
  // reload that just completed (and refreshes after every mutation), so it
  // takes precedence over the host seam; the seam remains a fallback for
  // runtimes whose list response does not carry the field yet.
  const sessionIncarnationId = listSessionIncarnationId ?? hostSessionIncarnationId;
  const canMutate = liveScope && supported === true && Boolean(sessionId) && Boolean(sessionIncarnationId) && !operationLocked && currentAccess();

  const runMutation = useCallback(
    async (
      busyKey: string,
      operation: (isCurrent: () => boolean) => Promise<void>,
      failureNotice: string,
    ): Promise<boolean> => {
      if (mutationActiveRef.current || operationLocked || !currentAccess()) return false;
      mutationActiveRef.current = true;
      const scope = scopeGenerationRef.current;
      const mutation = ++mutationSequenceRef.current;
      const isCurrent = () => scopeGenerationRef.current === scope && currentAccess();
      setBusyAttachmentId(busyKey);
      try {
        const completed = await runOperation(sessionIncarnationId ?? "missing", async () => { if (!isCurrent()) throw new Error("The source conversation changed."); }, async () => { await operation(isCurrent); return true; });
        if (!completed) return false;
        if (isCurrent()) await reload();
        return true;
      } catch (mutationError) {
        if (!isCurrent()) return false;
        if (isExternalSourceCapabilityAbsent(mutationError)) {
          setSupported(false);
          setAttachments([]);
          setSelectedAttachmentIds([]);
          return false;
        }
        setError("The source request outcome is uncertain. Further source changes are locked; refreshing does not settle the original request.");
        pushLocalNotice?.(failureNotice + " Outcome is uncertain; no automatic retry will run.", "warning");
        return false;
      } finally {
        if (isCurrent() && mutationSequenceRef.current === mutation) { mutationActiveRef.current = false; setBusyAttachmentId(null); }
      }
    },
    [pushLocalNotice, reload, currentAccess, operationLocked, runOperation, sessionIncarnationId],
  );

  const attach = useCallback(
    async (seed: ExternalSourceAttachInputSeed): Promise<boolean> => {
      if (!canMutate || !sessionId || !sessionIncarnationId) {
        return false;
      }
      return runMutation(
        `attach:${seed.itemId}`,
        async (isCurrent) => {
          await attachExternalSourceToSession({
            workspaceId,
            sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
            sourceId: seed.sourceId,
            importId: seed.importId,
            itemId: seed.itemId,
          });
          if (isCurrent()) pushLocalNotice?.("Attached the imported item read-only.", "success");
        },
        "The external source attach did not return a confirmed receipt.",
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
        async (isCurrent) => {
          await detachExternalSourceAttachment({
            workspaceId,
            sessionId,
            attachmentId,
            expectedRevision: attachment.revision,
            expectedSessionIncarnationId: sessionIncarnationId,
          });
          if (isCurrent())
            pushLocalNotice?.("Detached the external source. Imported evidence remains immutable.", "neutral");
        },
        "The external source detach did not return a confirmed receipt.",
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
        async (isCurrent) => {
          const receipt = await requestExternalSourceKnowledgeSnapshot({
            workspaceId,
            sessionId,
            expectedSessionIncarnationId: sessionIncarnationId,
            attachmentId,
            importId: attachment.importId,
            itemId: attachment.itemId,
            expectedAttachmentRevision: attachment.revision,
          });
          if (isCurrent())
            pushLocalNotice?.(
              receipt.approvalId
                ? `Knowledge copy requested. Resolve approval ${receipt.approvalId.slice(-8)} in the approvals inbox.`
                : "Knowledge copy requested. Resolve it in the approvals inbox.",
              "success",
            );
        },
        "The knowledge copy request did not return a confirmed receipt.",
      );
    },
    [attachments, canMutate, pushLocalNotice, runMutation, sessionId, sessionIncarnationId, workspaceId],
  );

  // Read via refs inside the capture callback so the queue can freeze the
  // CURRENT selection at enqueue time while the callback identity stays stable
  // for the orchestration hook (synced-ref pattern).
  const captureScopeRef = useRef<() => boolean>(() => false);
  captureScopeRef.current = () => liveScope && currentAccess();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const selectedRef = useRef(selectedAttachmentIds);
  selectedRef.current = selectedAttachmentIds;

  const captureOutboundExternalContextRefs = useCallback((): readonly ChatRoutedContextRef[] => {
    if (!captureScopeRef.current()) return [];
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
      error: operationLocked ? attempt.attempt?.message ?? error : error,
      attachments: liveScope ? attachments : [],
      candidates: liveScope ? candidates : [],
      candidatesSupported,
      selectedAttachmentIds: liveScope ? selectedAttachmentIds : [],
      busyAttachmentId,
      canMutate,
      sessionIncarnationId,
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
      liveScope, operationLocked, attempt.attempt?.message,
      supported,
      loading,
      error,
      attachments,
      candidates,
      candidatesSupported,
      selectedAttachmentIds,
      busyAttachmentId,
      canMutate,
      sessionIncarnationId,
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
