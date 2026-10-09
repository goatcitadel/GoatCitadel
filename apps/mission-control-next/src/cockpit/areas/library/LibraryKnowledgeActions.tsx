import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DocsIngestInput } from "@goatcitadel/contracts";
import { knowledgeDocsIngest, knowledgeEmbeddingsIndex, knowledgeEmbeddingsQuery, fetchKnowledgeApprovalResult } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchChatSessions } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { LibraryApproval } from "./LibraryApproval";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function LibraryKnowledgeActions({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  return <KnowledgeActions key={operation.identity} workspaceId={workspaceId} />;
}
function KnowledgeActions({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  const draft = useSessionDraft(JSON.stringify(["cockpit-knowledge", operation.presentationScope]), { title: "", source: "", sourceType: "text" as DocsIngestInput["sourceType"], sessionId: "", namespace: `workspace/${workspaceId}/knowledge`, query: "" }, undefined, { label: "Knowledge source" });
  const sessions = useQuery({ queryKey: ["library", "knowledge-conversations", workspaceId, operation.identity], queryFn: () => fetchChatSessions({ workspaceId, limit: 100, view: "active" }), staleTime: 0 });
  const [review, setReview] = useSessionViewState<{ action: "ingest" | "index" | "retrieve"; draft: typeof draft.value } | undefined>(operation.key + ":review", undefined), [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string; approvalId?: string; rows?: Record<string, unknown>[]; documentId?: string } | undefined>(operation.key + ":outcome", undefined);
  const [resultAuthorized, setResultAuthorized] = useState(false);
  const pending = useRef(false);
  const resultRequest = useRef(0);
  const gatewayUrl = getGatewayApiBaseUrl();
  const currentReview = useRef({ review, workspaceId, gatewayUrl }); currentReview.current = { review, workspaceId, gatewayUrl };
  async function refreshResult() {
    if (!outcome?.approvalId || !review) return;
    setResultAuthorized(false);
    const approvalId = outcome.approvalId, captured = review;
    const generation = ++resultRequest.current;
    setOutcome({ approvalId, error: false, text: "Checking the original Knowledge operation and current source access…" });
    try {
      const receipt = await fetchKnowledgeApprovalResult(approvalId, { workspaceId, sessionId: captured.draft.sessionId, toolName: captured.action === "ingest" ? "docs.ingest" : captured.action === "index" ? "embeddings.index" : "embeddings.query" });
      if (!operation.current() || generation !== resultRequest.current || currentReview.current.review !== captured || currentReview.current.workspaceId !== workspaceId || currentReview.current.gatewayUrl !== gatewayUrl) return;
      if (receipt.approvalId !== approvalId) throw new Error("Knowledge receipt does not match this approval.");
      setResultAuthorized(true);
      const result = record(receipt.result), document = record(result.document);
      setOutcome({ approvalId, error: ["denied", "failed", "blocked", "uncertain"].includes(receipt.state), text: receipt.message, rows: receipt.state === "completed" && Array.isArray(result.items) ? result.items.map(record) : undefined, documentId: receipt.state === "completed" && typeof document.docId === "string" ? document.docId : undefined });
    } catch (cause) {
      if (operation.current() && generation === resultRequest.current && currentReview.current.review === captured && currentReview.current.workspaceId === workspaceId && currentReview.current.gatewayUrl === gatewayUrl) setOutcome({ approvalId, error: true, text: describeApiError(cause).summary + " Original operation result is unavailable; refresh before relying on completion." });
    }
  }
  async function submit() {
    if (!review || pending.current || outcome || operation.locked || !operation.current()) return;
    pending.current = true; setBusy(true);
    try {
      const input = review.draft;
      const received = await operation.run(review.action, async () => {
        const current = await fetchChatSessions({ workspaceId, sessionId: input.sessionId, view: "all", limit: 1 });
        if (!current.items.some(item => item.sessionId === input.sessionId && item.workspaceId === workspaceId)) throw new Error("The source conversation is not confirmed in this workspace.");
      }, () => review.action === "ingest" ? knowledgeDocsIngest({ namespace: input.namespace, sessionId: input.sessionId, sourceType: input.sourceType, source: input.source, title: input.title || undefined }) : review.action === "index" ? knowledgeEmbeddingsIndex({ namespace: input.namespace, sessionId: input.sessionId }) : knowledgeEmbeddingsQuery({ namespace: input.namespace, sessionId: input.sessionId, query: input.query, limit: 20 }));
      if (!received || !operation.current()) return;
      setResultAuthorized(true);
      const response = record(received);
      if (response.outcome === "approval_required") {
        setOutcome({ error: false, text: "Knowledge request requires approval. No completed ingest, index or retrieval is confirmed.", approvalId: typeof response.approvalId === "string" ? response.approvalId : undefined });
      } else if (response.outcome === "blocked") {
        setOutcome({ error: true, text: typeof response.policyReason === "string" ? response.policyReason : "Knowledge request blocked by Gateway policy." });
      } else {
        const result = response.outcome === "executed" ? record(response.result) : response;
        const rows = Array.isArray(result.items) ? result.items.map(record) : Array.isArray(result.matches) ? result.matches.map(record) : undefined;
        const document = record(result.document), documentId = typeof result.documentId === "string" ? result.documentId : typeof document.docId === "string" ? document.docId : typeof document.documentId === "string" ? document.documentId : undefined;
        setOutcome({ error: false, text: review.action === "retrieve" && rows ? `Gateway returned ${rows.length} matches under the source conversation's read policy.` : documentId ? "Gateway returned a persisted document receipt. Indexing and context admission remain separate." : response.outcome === "executed" ? "Gateway reports the tool executed. Inspect owner evidence before relying on context availability." : "Gateway returned a result. Completion and context availability are not independently confirmed.", rows, documentId });
      }
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The operation is not confirmed. Your source draft is retained.` }); }
    finally { pending.current = false; if (operation.current()) setBusy(false); }
  }
  function start(action: "ingest" | "index" | "retrieve") { if (operation.locked) return; setOutcome(undefined); setReview({ action, draft: { ...draft.value } }); }
  return <section className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere rounded-lg border border-line p-3" aria-label="Knowledge ingest and retrieval"><h2 className="font-display text-lg">Knowledge ingest and retrieval</h2><p className="text-sm text-fg-secondary">Choose the source conversation explicitly. Gateway tool policy, source admission and read access remain authoritative.</p>
    {sessions.error ? <Callout tone="error">{describeApiError(sessions.error).summary}</Callout> : null}
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <Field label="Source conversation">{props => <select {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value.sessionId} onChange={event => draft.setValue({ ...draft.value, sessionId: event.target.value })}><option value="">Choose a conversation</option>{sessions.data?.items.filter(item => item.workspaceId === workspaceId).map(item => <option key={item.sessionId} value={item.sessionId}>{item.title || "Untitled conversation"}</option>)}</select>}</Field>
    <Field label="Knowledge namespace">{props => <input {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value.namespace} onChange={event => draft.setValue({ ...draft.value, namespace: event.target.value })} />}</Field>
    <Field label="Source type">{props => <select {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value.sourceType} onChange={event => draft.setValue({ ...draft.value, sourceType: event.target.value as DocsIngestInput["sourceType"] })}><option value="text">Text</option><option value="file">File</option><option value="url">URL</option></select>}</Field>
    <Field label="Source title">{props => <input {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value.title} onChange={event => draft.setValue({ ...draft.value, title: event.target.value })} />}</Field><Field label="Knowledge source" help="Text, an allowed file path, or a URL matching the selected source type.">{props => <textarea {...props} rows={4} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value.source} onChange={event => draft.setValue({ ...draft.value, source: event.target.value })} />}</Field>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !draft.value.sessionId || !draft.value.namespace.trim() || !draft.value.source.trim() || sessions.isError} onClick={() => start("ingest")}>Review knowledge ingest</Button><Button disabled={busy || !draft.value.sessionId || !draft.value.namespace.trim() || sessions.isError} onClick={() => start("index")}>Review knowledge indexing</Button></div>
    <Field label="Knowledge query">{props => <input {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={draft.value.query} onChange={event => draft.setValue({ ...draft.value, query: event.target.value })} />}</Field><Button disabled={busy || !draft.value.sessionId || !draft.value.query.trim() || sessions.isError} onClick={() => start("retrieve")}>Review knowledge retrieval</Button><Button variant="ghost" disabled={busy} onClick={draft.discard}>Discard knowledge draft</Button>
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review knowledge request" description="Tool execution may require approval; source access is evaluated by Gateway."><div className="grid min-w-0 grid-cols-1 gap-3 wrap-anywhere"><p>{review?.action} · Workspace {workspaceId}</p><p className="break-words">Namespace: {review?.draft.namespace}</p><p className="break-words">Conversation: {review?.draft.sessionId}</p><p className="whitespace-pre-wrap break-words">{review?.action === "ingest" ? `Source (${review.draft.sourceType}): ${review.draft.source}` : review?.draft.query}</p><Callout tone="warning">Ingest persists source material. Indexing can invoke an embedding provider. Retrieval may return only content admitted for this conversation.</Callout>{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}{outcome?.approvalId ? <LibraryApproval approvalId={outcome.approvalId} workspaceId={workspaceId} onRefresh={refreshResult} /> : null}{outcome?.documentId ? <TechnicalDetails label="Document receipt"><p>{outcome.documentId}</p></TechnicalDetails> : null}{outcome?.rows && !resultAuthorized ? <Callout>Retained result content is withheld until current source access is checked. Refresh the original approval result, or make an explicit new retrieval when no approval was needed.</Callout> : null}{outcome?.rows && resultAuthorized ? <ul className="grid min-w-0 grid-cols-1 gap-2">{outcome.rows.map((row, index) => <KnowledgeMatch key={index} row={row} index={index} />)}</ul> : null}<Button disabled={busy || Boolean(outcome)} onClick={() => void submit()}>Confirm knowledge request</Button></div></Dialog>
  </section>;
}

function KnowledgeMatch({ row, index }: { row: Record<string, unknown>; index: number }) {
  const attribution = record(row.attribution);
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  const redacted = row.redacted === true || attribution.redacted === true;
  return <li className="grid min-w-0 grid-cols-1 gap-1 wrap-anywhere rounded-md border border-line p-2">
    <h3>{text(attribution.title) ?? `Match ${index + 1}: title unavailable`}</h3>
    <p className="whitespace-pre-wrap break-words">{redacted ? "Excerpt redacted by the source owner." : text(row.snippet) ?? "Excerpt unavailable"}</p>
    <p className="break-words text-sm">Source: {text(attribution.sourceRef) ?? "Unavailable"}</p>
    <p className="text-sm">Source type: {text(attribution.sourceType) ?? "Unavailable"} · Trust: {text(attribution.trustLevel) ?? "Unavailable"}</p>
    <TechnicalDetails label="Retrieved record identifiers"><p>Document: {text(row.docId) ?? "Unavailable"}</p><p>Chunk: {text(row.chunkId) ?? "Unavailable"}</p></TechnicalDetails>
  </li>;
}
