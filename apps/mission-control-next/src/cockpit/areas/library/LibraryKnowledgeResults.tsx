import { LibraryApproval } from "./LibraryApproval";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The retained outcome of one reviewed Knowledge request. */
export type KnowledgeOutcome = {
  error: boolean;
  text: string;
  approvalId?: string;
  rows?: Record<string, unknown>[];
  documentId?: string;
};

/** Outcome, approval, document receipt and authorized matches for a reviewed Knowledge request. */
export function KnowledgeResults({
  outcome,
  workspaceId,
  resultAuthorized,
  onRefresh,
}: {
  outcome: KnowledgeOutcome | undefined;
  workspaceId: string;
  resultAuthorized: boolean;
  onRefresh: () => Promise<void>;
}) {
  return (
    <>
      {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
      {outcome?.approvalId ? (
        <LibraryApproval approvalId={outcome.approvalId} workspaceId={workspaceId} onRefresh={onRefresh} />
      ) : null}
      {outcome?.documentId ? (
        <TechnicalDetails label="Document receipt">
          <p>{outcome.documentId}</p>
        </TechnicalDetails>
      ) : null}
      {outcome?.rows && !resultAuthorized ? (
        <Callout>
          Retained result content is withheld until current source access is checked. Refresh the original approval
          result, or make an explicit new retrieval when no approval was needed.
        </Callout>
      ) : null}
      {outcome?.rows && resultAuthorized ? (
        <ul className="grid min-w-0 grid-cols-1 divide-y divide-line-subtle">
          {outcome.rows.map((row, index) => (
            <KnowledgeMatch key={index} row={row} index={index} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

function KnowledgeMatch({ row, index }: { row: Record<string, unknown>; index: number }) {
  const attribution = record(row.attribution);
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const redacted = row.redacted === true || attribution.redacted === true;
  return (
    <li className="grid min-w-0 grid-cols-1 gap-1 wrap-anywhere py-2">
      <h3>{text(attribution.title) ?? `Match ${index + 1}: title unavailable`}</h3>
      <p className="whitespace-pre-wrap break-words">
        {redacted ? "Excerpt redacted by its source." : (text(row.snippet) ?? "Excerpt unavailable")}
      </p>
      <p className="break-words text-sm">Source: {text(attribution.sourceRef) ?? "Unavailable"}</p>
      <p className="text-sm">
        Source type: {text(attribution.sourceType) ?? "Unavailable"} · Trust:{" "}
        {text(attribution.trustLevel) ?? "Unavailable"}
      </p>
      <TechnicalDetails label="Retrieved record identifiers">
        <p>Document: {text(row.docId) ?? "Unavailable"}</p>
        <p>Chunk: {text(row.chunkId) ?? "Unavailable"}</p>
      </TechnicalDetails>
    </li>
  );
}
