import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { fetchTurnLearningReceipt } from "@goatcitadel/mission-control-shared/api/chat-learning";
import {
  fetchTraceMemoryCandidate,
  editTraceMemoryCandidate,
  promoteTraceMemoryCandidate,
  rejectTraceMemoryCandidate,
} from "@goatcitadel/mission-control-shared/api/memory";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { subscribeRefresh } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { Button } from "../../ui/Button";
import { ChatLearningReceipt } from "./ChatLearningReceipt";
interface Props {
  sessionId: string;
  turnId: string;
  workspaceId: string;
  readOnly?: boolean;
  identity: string;
  open: boolean;
  isCurrent: () => boolean;
}

export function ChatLearningReceiptControl({
  sessionId,
  workspaceId,
  turnId,
  readOnly,
  identity,
  open,
  isCurrent,
}: Props) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const query = useQuery({
    queryKey: ["chat", "learning-receipt", identity],
    queryFn: () => fetchTurnLearningReceipt(sessionId, turnId, workspaceId),
    enabled: open,
    staleTime: 0,
  });
  const mounted = useRef(true),
    lock = useRef(false);
  const { refetch } = query;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const unsub = (["memory", "skills", "system"] as const).map((topic) =>
      subscribeRefresh(topic, () => void refetch()),
    );
    return () => unsub.forEach((callback) => callback());
  }, [open, refetch]);
  async function run(candidate: TraceMemoryCandidateRecord, action: "promote" | "reject" | "edit", content?: string) {
    if (lock.current || readOnly || !candidate.reviewHash || !isCurrent()) return;
    lock.current = true;
    setPending(true);
    setError(undefined);
    try {
      const fresh = await fetchTraceMemoryCandidate(candidate.candidateId, { workspaceId });
      if (!mounted.current || !isCurrent()) return;
      if (fresh.workspaceId !== workspaceId || fresh.status !== "proposed" || fresh.reviewHash !== candidate.reviewHash)
        throw new Error("The lesson changed after review. Refresh before deciding.");
      const review = { workspaceId, expectedReviewHash: candidate.reviewHash };
      if (action === "edit")
        await editTraceMemoryCandidate(candidate.candidateId, { ...review, proposedInsight: content! });
      else if (action === "promote") await promoteTraceMemoryCandidate(candidate.candidateId, review);
      else await rejectTraceMemoryCandidate(candidate.candidateId, review);
      if (mounted.current) await query.refetch();
    } catch (cause) {
      if (mounted.current) {
        setError(`${describeApiError(cause).summary} Refresh to inspect the recorded outcome.`);
        await query.refetch();
      }
      throw cause;
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="min-w-0 space-y-3 pt-3">
      {open && query.isPending ? <p>Reading learning receipts…</p> : null}
      {open && query.data ? (
        <ChatLearningReceipt
          receipt={query.data}
          pending={pending}
          readOnly={readOnly}
          onDecision={(candidate, action) => {
            void run(candidate, action).catch(() => {});
          }}
          onEdit={(candidate, content) => run(candidate, "edit", content)}
        />
      ) : null}
      {error || query.error ? (
        <div role="alert">
          {error ? <p>{error}</p> : null}
          {query.error ? <p>{describeApiError(query.error).summary}</p> : null}
        </div>
      ) : null}
      {open ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh learning receipt
        </Button>
      ) : null}
    </div>
  );
}
