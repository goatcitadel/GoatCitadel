import { useQuery } from "@tanstack/react-query";
import type { KnowledgeDocumentSummary } from "@goatcitadel/contracts";
import { fetchKnowledgeDocuments } from "@goatcitadel/mission-control-shared/api/memory";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { Section } from "../../ui/Section";
import { TimeText } from "../../ui/TimeText";
import { useLibraryOperation } from "./use-library-operation";
import { memoryNamespaceLabel } from "./library-vocabulary";

const SOURCE_LABELS: Readonly<Record<KnowledgeDocumentSummary["sourceType"], string>> = {
  file: "File",
  url: "Web page",
  text: "Pasted text",
  memory: "Memory",
  external_source_snapshot: "External source snapshot",
};

/** Metadata only: titles, namespaces and dates of the stored sources. Removal needs a governed delete and is not offered here. */
export function LibraryKnowledgeSources({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["knowledge", workspaceId]));
  const documents = useQuery({
    queryKey: ["library", "knowledge-documents", access.identity],
    queryFn: () => fetchKnowledgeDocuments(),
    staleTime: 0,
  });
  const items = documents.data?.items;
  return (
    <Section
      title="Knowledge sources"
      description="What the AI can retrieve. Sources are shared by every workspace on this installation."
    >
      {documents.error ? (
        <Callout tone="error">
          Could not load knowledge sources. {describeApiError(documents.error).summary}{" "}
          <Button onClick={() => void documents.refetch()}>Try again</Button>
        </Callout>
      ) : null}
      {documents.isPending ? <p role="status">Reading knowledge sources…</p> : null}
      {items && !items.length ? (
        <EmptyState
          title="No knowledge sources yet"
          description="A source appears here once its ingest is approved."
          headingLevel={3}
        />
      ) : null}
      {items?.length ? (
        <ul className="divide-y divide-line-subtle">
          {items.map((doc) => (
            <li key={doc.docId} className="space-y-1 py-3">
              <h3 className="break-words">{doc.title}</h3>
              <p className="text-sm text-fg-secondary">
                {memoryNamespaceLabel(doc.namespace)} · {SOURCE_LABELS[doc.sourceType]} ·{" "}
                <TimeText prefix="Added" value={doc.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {documents.data?.truncated ? <p>Showing the newest {plural(items?.length ?? 0, "source")}.</p> : null}
    </Section>
  );
}
