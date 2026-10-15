import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchMemoryQmdStats } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchJourneyTimeline } from "@goatcitadel/mission-control-shared/api/journey";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useLibraryOperation } from "./use-library-operation";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TimeText } from "../../ui/TimeText";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { freeformLabel } from "./memory-diagnostics-vocabulary";

type CitationExcerpt = { role?: string; text: string; raw?: string };

/** Transcript citations arrive as a serialized `{ message }`; show the words, keep the record as technical detail. */
function describeCitationSnippet(snippet: string | undefined): CitationExcerpt | null {
  if (!snippet) return null;
  const trimmed = snippet.trim();
  if (!trimmed.startsWith("{")) return { text: snippet };
  try {
    const parsed = JSON.parse(trimmed) as { message?: { role?: unknown; content?: unknown; parts?: unknown } };
    const message = parsed?.message;
    if (!message || typeof message !== "object") return { text: snippet };
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const partText = parts
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
    const text = typeof message.content === "string" && message.content.trim() ? message.content : partText;
    return {
      role:
        typeof message.role === "string" && message.role
          ? message.role.charAt(0).toUpperCase() + message.role.slice(1)
          : undefined,
      text: text || "No message text recorded",
      raw: JSON.stringify(parsed, null, 2),
    };
  } catch {
    // The Gateway caps citation snippets, so a transcript excerpt is usually cut mid-JSON. Pull the role and the
    // message text out of the prefix rather than showing the broken record as the card's content.
    const role = /"role"\s*:\s*"([^"]*)"/u.exec(trimmed)?.[1];
    const content =
      /"content"\s*:\s*"((?:[^"\\]|\\.)*)"?/u.exec(trimmed)?.[1] ??
      /"text"\s*:\s*"((?:[^"\\]|\\.)*)"?/u.exec(trimmed)?.[1];
    if (!role && !content) return { text: snippet };
    const text = content ? content.replace(/\\"/gu, '"').replace(/\\n/gu, "\n") : "";
    return {
      role: role ? role.charAt(0).toUpperCase() + role.slice(1) : undefined,
      text: text ? `${text}…` : "Message text cut off in the retained excerpt",
      raw: snippet,
    };
  }
}

export function LibraryKnowledgeEvidence({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["knowledge-evidence", workspaceId]));
  const [showContext, setShowContext] = useState(false);
  const retrieval = useQuery({
    queryKey: ["library", "knowledge-retrieval", workspaceId, access.identity],
    queryFn: () => fetchMemoryQmdStats(undefined, undefined, 8),
    staleTime: 0,
  });
  const recovered = useQuery({
    queryKey: ["library", "knowledge-snapshots", workspaceId, access.identity],
    queryFn: () => fetchJourneyTimeline({ workspaceId, eventTypes: ["knowledge_snapshot_lifecycle"], limit: 30 }),
    staleTime: 0,
  });
  return (
    <section className="grid gap-3" aria-label="Knowledge evidence">
      <h2 className="font-display text-lg">Context use and retrieval evidence</h2>
      <p>
        Retained installation retrieval records explain context selection. Recovered external snapshots are governed
        Knowledge documents, separate from lifecycle memory items.
      </p>
      <Button
        onClick={() => {
          void retrieval.refetch();
          void recovered.refetch();
        }}
      >
        Refresh Knowledge evidence
      </Button>
      {retrieval.error ? <Callout tone="error">{describeApiError(retrieval.error).summary}</Callout> : null}
      {retrieval.isPending ? <p role="status">Reading retrieval evidence…</p> : null}
      <Button onClick={() => setShowContext((value) => !value)}>
        {showContext ? "Hide context packs" : "Show context packs"}
      </Button>
      <ul className="grid gap-3">
        {retrieval.data?.recent.map((pack) => (
          <li key={pack.contextId} className="rounded-md border border-line p-3">
            <p>
              {plural(pack.citations.length, "citation")} · <TimeText value={pack.createdAt} /> ·{" "}
              {freeformLabel(pack.scope, "Scope not recorded")}
            </p>
            <p>
              Context tokens: {pack.originalTokenEstimate} original → {pack.distilledTokenEstimate} retained
            </p>
            <ul>
              {pack.citations.map((citation, index) => {
                const excerpt = describeCitationSnippet(citation.snippet);
                return (
                  <li key={index} className="my-2">
                    <h3>{freeformLabel(citation.sourceType, "Source")}</h3>
                    <p className="whitespace-pre-wrap break-words">
                      {excerpt ? (
                        <>
                          {excerpt.role ? <span className="font-medium">{excerpt.role}: </span> : null}
                          {excerpt.text}
                        </>
                      ) : (
                        "No excerpt recorded"
                      )}
                    </p>
                    <p>
                      Score {citation.score.toFixed(3)} · {citation.provenance?.relationScope ?? "Scope not recorded"} ·{" "}
                      {citation.provenance?.freshness ?? "Freshness unknown"}
                    </p>
                    <p>{citation.provenance?.selectionReason ?? "Selection reason not recorded"}</p>
                    {excerpt?.raw ? (
                      <details className="text-xs text-fg-secondary">
                        <summary className="cursor-pointer">Technical details</summary>
                        <pre className="whitespace-pre-wrap break-words">{excerpt.raw}</pre>
                      </details>
                    ) : null}
                    <TechnicalDetails label="Citation provenance">
                      <p>{citation.sourceRef}</p>
                      <p>
                        {citation.provenance?.retrievalStrategy} · {citation.provenance?.sourceTimestamp}
                      </p>
                    </TechnicalDetails>
                  </li>
                );
              })}
            </ul>
            {showContext ? (
              <details>
                <summary>Retained context text</summary>
                <p className="whitespace-pre-wrap break-words">{pack.contextText}</p>
              </details>
            ) : null}
            <TechnicalDetails label="Context pack provenance">
              <p>
                {pack.contextId} · {pack.createdAt} · expires {pack.expiresAt}
              </p>
              <pre className="whitespace-pre-wrap break-words">{JSON.stringify(pack.quality, null, 2)}</pre>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
      <h2 className="font-display text-lg">Recovered external snapshots</h2>
      {recovered.error ? <Callout tone="error">{describeApiError(recovered.error).summary}</Callout> : null}
      {recovered.isPending ? <p role="status">Reading snapshot lifecycle…</p> : null}
      <ul className="grid gap-2">
        {recovered.data?.items.map((event) => (
          <li key={event.eventId} className="rounded-md border border-line p-3">
            <h3>
              {event.action === "snapshot_created"
                ? "Snapshot created"
                : event.action === "approval_requested"
                  ? "Approval requested"
                  : freeformLabel(event.action, "Snapshot event")}
            </h3>
            <p>
              <TimeText value={event.occurredAt} absolute />
            </p>
            <p>
              {event.action === "snapshot_created" && typeof event.summary.knowledgeDocumentId === "string"
                ? "Knowledge document materialized with " + String(event.summary.chunkCount ?? "unknown") + " chunks."
                : "This event does not establish a completed Knowledge write."}
            </p>
            {event.sessionId ? (
              <NativeOwnerLink
                scope={access.identity}
                href={"/chat?sessionId=" + encodeURIComponent(event.sessionId) + "&shell=cockpit"}
              >
                Open snapshot conversation
              </NativeOwnerLink>
            ) : null}
            {event.approvalId ? (
              <NativeOwnerLink
                scope={access.identity}
                href={"/inbox?approvalId=" + encodeURIComponent(event.approvalId) + "&shell=cockpit"}
              >
                Inspect snapshot approval
              </NativeOwnerLink>
            ) : null}
            <TechnicalDetails label="Snapshot provenance">
              <p>{event.occurredAt}</p>
              <pre className="whitespace-pre-wrap break-words">{JSON.stringify(event.summary, null, 2)}</pre>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
      {recovered.data?.items.length === 0 ? <p>No retained snapshot lifecycle events in this workspace.</p> : null}
    </section>
  );
}
