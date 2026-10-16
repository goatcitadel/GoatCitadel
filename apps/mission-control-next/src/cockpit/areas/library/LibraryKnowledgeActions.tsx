import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DocsIngestInput } from "@goatcitadel/contracts";
import {
  knowledgeDocsIngest,
  knowledgeEmbeddingsIndex,
  knowledgeEmbeddingsQuery,
  fetchKnowledgeApprovalResult,
} from "@goatcitadel/mission-control-shared/api/memory";
import { fetchChatSessions } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { KnowledgeResults, record, type KnowledgeOutcome } from "./LibraryKnowledgeResults";
import { KnowledgeSourceFields } from "./LibraryKnowledgeSourceFields";

const KNOWLEDGE_ACTION = {
  ingest: "Add to knowledge",
  index: "Index knowledge",
  retrieve: "Search knowledge",
} as const;
export function LibraryKnowledgeActions({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  return <KnowledgeActions key={operation.identity} workspaceId={workspaceId} />;
}
function KnowledgeActions({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  const draft = useSessionDraft(
    JSON.stringify(["cockpit-knowledge", operation.presentationScope]),
    {
      title: "",
      source: "",
      sourceType: "text" as DocsIngestInput["sourceType"],
      sessionId: "",
      namespace: `workspace/${workspaceId}/knowledge`,
      query: "",
    },
    undefined,
    { label: "Knowledge source" },
  );
  const sessions = useQuery({
    queryKey: ["library", "knowledge-conversations", workspaceId, operation.identity],
    queryFn: () => fetchChatSessions({ workspaceId, limit: 100, view: "active" }),
    staleTime: 0,
  });
  const [review, setReview] = useSessionViewState<
      { action: "ingest" | "index" | "retrieve"; draft: typeof draft.value } | undefined
    >(operation.key + ":review", undefined),
    [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useSessionViewState<KnowledgeOutcome | undefined>(
    operation.key + ":outcome",
    undefined,
  );
  const [resultAuthorized, setResultAuthorized] = useState(false);
  const pending = useRef(false);
  const resultRequest = useRef(0);
  const gatewayUrl = getGatewayApiBaseUrl();
  const currentReview = useRef({ review, workspaceId, gatewayUrl });
  currentReview.current = { review, workspaceId, gatewayUrl };
  async function refreshResult() {
    if (!outcome?.approvalId || !review) return;
    setResultAuthorized(false);
    const approvalId = outcome.approvalId,
      captured = review;
    const generation = ++resultRequest.current;
    setOutcome({
      approvalId,
      error: false,
      text: "Checking the original Knowledge operation and current source access…",
    });
    try {
      const receipt = await fetchKnowledgeApprovalResult(approvalId, {
        workspaceId,
        sessionId: captured.draft.sessionId,
        toolName:
          captured.action === "ingest"
            ? "docs.ingest"
            : captured.action === "index"
              ? "embeddings.index"
              : "embeddings.query",
      });
      if (
        !operation.current() ||
        generation !== resultRequest.current ||
        currentReview.current.review !== captured ||
        currentReview.current.workspaceId !== workspaceId ||
        currentReview.current.gatewayUrl !== gatewayUrl
      )
        return;
      if (receipt.approvalId !== approvalId) throw new Error("Knowledge receipt does not match this approval.");
      setResultAuthorized(true);
      const result = record(receipt.result),
        document = record(result.document);
      setOutcome({
        approvalId,
        error: ["denied", "failed", "blocked", "uncertain"].includes(receipt.state),
        text: receipt.message,
        rows: receipt.state === "completed" && Array.isArray(result.items) ? result.items.map(record) : undefined,
        documentId: receipt.state === "completed" && typeof document.docId === "string" ? document.docId : undefined,
      });
    } catch (cause) {
      if (
        operation.current() &&
        generation === resultRequest.current &&
        currentReview.current.review === captured &&
        currentReview.current.workspaceId === workspaceId &&
        currentReview.current.gatewayUrl === gatewayUrl
      )
        setOutcome({
          approvalId,
          error: true,
          text:
            describeApiError(cause).summary +
            " Original operation result is unavailable; refresh before relying on completion.",
        });
    }
  }
  async function submit() {
    if (!review || pending.current || outcome || operation.locked || !operation.current()) return;
    pending.current = true;
    setBusy(true);
    try {
      const input = review.draft;
      const received = await operation.run(
        review.action,
        async () => {
          const current = await fetchChatSessions({ workspaceId, sessionId: input.sessionId, view: "all", limit: 1 });
          if (!current.items.some((item) => item.sessionId === input.sessionId && item.workspaceId === workspaceId))
            throw new Error("The source conversation is not confirmed in this workspace.");
        },
        () =>
          review.action === "ingest"
            ? knowledgeDocsIngest({
                namespace: input.namespace,
                sessionId: input.sessionId,
                sourceType: input.sourceType,
                source: input.source,
                title: input.title || undefined,
              })
            : review.action === "index"
              ? knowledgeEmbeddingsIndex({ namespace: input.namespace, sessionId: input.sessionId })
              : knowledgeEmbeddingsQuery({
                  namespace: input.namespace,
                  sessionId: input.sessionId,
                  query: input.query,
                  limit: 20,
                }),
      );
      if (!received || !operation.current()) return;
      setResultAuthorized(true);
      const response = record(received);
      if (response.outcome === "approval_required") {
        setOutcome({
          error: false,
          text: "Knowledge request requires approval. No completed ingest, index or retrieval is confirmed.",
          approvalId: typeof response.approvalId === "string" ? response.approvalId : undefined,
        });
      } else if (response.outcome === "blocked") {
        setOutcome({
          error: true,
          text:
            typeof response.policyReason === "string"
              ? response.policyReason
              : "Knowledge request blocked by Gateway policy.",
        });
      } else {
        const result = response.outcome === "executed" ? record(response.result) : response;
        const rows = Array.isArray(result.items)
          ? result.items.map(record)
          : Array.isArray(result.matches)
            ? result.matches.map(record)
            : undefined;
        const document = record(result.document),
          documentId =
            typeof result.documentId === "string"
              ? result.documentId
              : typeof document.docId === "string"
                ? document.docId
                : typeof document.documentId === "string"
                  ? document.documentId
                  : undefined;
        setOutcome({
          error: false,
          text:
            review.action === "retrieve" && rows
              ? `Gateway returned ${plural(rows.length, "match", "matches")} under the source conversation's read policy.`
              : documentId
                ? "Document saved. Indexing and use in conversations are checked separately."
                : response.outcome === "executed"
                  ? "The tool ran. It is not yet confirmed as available to conversations."
                  : "Gateway returned a result. Completion and context availability are not independently confirmed.",
          rows,
          documentId,
        });
      }
    } catch (cause) {
      if (operation.current())
        setOutcome({
          error: true,
          text: `${describeApiError(cause).summary} The operation is not confirmed. Your source draft is retained.`,
        });
    } finally {
      pending.current = false;
      if (operation.current()) setBusy(false);
    }
  }
  function start(action: "ingest" | "index" | "retrieve") {
    if (operation.locked) return;
    setOutcome(undefined);
    setReview({ action, draft: { ...draft.value } });
  }
  return (
    <section
      className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere border-t border-line-subtle pt-4"
      aria-label="Knowledge ingest and retrieval"
    >
      <h2 className="text-base font-semibold">Knowledge ingest and retrieval</h2>
      <p className="text-sm text-fg-secondary">
        Choose the source conversation. Tool policy and read access still decide what this conversation can use.
      </p>
      {sessions.error ? <Callout tone="error">{describeApiError(sessions.error).summary}</Callout> : null}
      {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
      <Field label="Source conversation">
        {(props) => (
          <select
            {...props}
            className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2"
            value={draft.value.sessionId}
            onChange={(event) => draft.setValue({ ...draft.value, sessionId: event.target.value })}
          >
            <option value="">Choose a conversation</option>
            {sessions.data?.items
              .filter((item) => item.workspaceId === workspaceId)
              .map((item) => (
                <option key={item.sessionId} value={item.sessionId}>
                  {item.title || "Untitled conversation"}
                </option>
              ))}
          </select>
        )}
      </Field>
      <KnowledgeSourceFields value={draft.value} onChange={(next) => draft.setValue(next)} />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy ||
            !draft.value.sessionId ||
            !draft.value.namespace.trim() ||
            !draft.value.source.trim() ||
            sessions.isError
          }
          onClick={() => start("ingest")}
        >
          Review knowledge ingest
        </Button>
        <Button
          disabled={busy || !draft.value.sessionId || !draft.value.namespace.trim() || sessions.isError}
          onClick={() => start("index")}
        >
          Review knowledge indexing
        </Button>
      </div>
      <Field label="Knowledge query">
        {(props) => (
          <input
            {...props}
            className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2"
            value={draft.value.query}
            onChange={(event) => draft.setValue({ ...draft.value, query: event.target.value })}
          />
        )}
      </Field>
      <Button
        disabled={busy || !draft.value.sessionId || !draft.value.query.trim() || sessions.isError}
        onClick={() => start("retrieve")}
      >
        Review knowledge retrieval
      </Button>
      <Button variant="ghost" disabled={busy} onClick={draft.discard}>
        Discard knowledge draft
      </Button>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(undefined);
        }}
        title="Review knowledge request"
        description="Tool execution may require approval; source access is evaluated by Gateway."
      >
        <div className="grid min-w-0 grid-cols-1 gap-3 wrap-anywhere">
          <p>{review ? KNOWLEDGE_ACTION[review.action] : ""} · This workspace</p>
          <p className="break-words">Namespace: {review?.draft.namespace}</p>
          <p className="break-words">
            Conversation:{" "}
            {sessions.data?.items.find((item) => item.sessionId === review?.draft.sessionId)?.title ||
              "Untitled conversation"}
          </p>
          <p className="whitespace-pre-wrap break-words">
            {review?.action === "ingest"
              ? `Source (${review.draft.sourceType}): ${review.draft.source}`
              : review?.draft.query}
          </p>
          <Callout tone="warning">
            Ingest persists source material. Indexing can invoke an embedding provider. Retrieval returns only content
            allowed for this conversation.
          </Callout>
          <KnowledgeResults
            outcome={outcome}
            workspaceId={workspaceId}
            resultAuthorized={resultAuthorized}
            onRefresh={refreshResult}
          />
          <Button disabled={busy || Boolean(outcome)} onClick={() => void submit()}>
            Confirm knowledge request
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
