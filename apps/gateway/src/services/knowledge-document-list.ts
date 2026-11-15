import type { KnowledgeDocumentListResponse } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

/**
 * A file ingest without a title is stored as `file:` plus the host path it was read from (ingestion-backends.ts,
 * the fallback title). The list shows only the file name, never the folder it sits in.
 */
function displayTitle(doc: { sourceType: string; title: string }): string {
  if (doc.sourceType !== "file" || !doc.title.startsWith("file:")) return doc.title;
  const name = doc.title.slice("file:".length).split(/[\\/]/u).filter(Boolean).at(-1);
  return name ?? doc.title;
}

type KnowledgeDocumentReader = Pick<AsyncStorage["knowledge"], "listDocuments">;

/**
 * Operator-only metadata list of stored Knowledge sources. It returns no content, source reference or metadata:
 * only what the Library needs to say which sources exist. Documents carry no workspace, so the list is installation-wide.
 */
export async function listKnowledgeDocuments(
  reader: KnowledgeDocumentReader,
  input: { namespace?: string; limit: number },
): Promise<KnowledgeDocumentListResponse> {
  const documents = await reader.listDocuments(input.namespace, input.limit + 1);
  return {
    items: documents.slice(0, input.limit).map((doc) => ({
      docId: doc.docId,
      namespace: doc.namespace,
      sourceType: doc.sourceType,
      title: displayTitle(doc),
      createdAt: doc.createdAt,
    })),
    truncated: documents.length > input.limit,
  };
}
