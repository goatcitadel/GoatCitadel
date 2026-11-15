import type { KnowledgeDocumentListResponse } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

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
      title: doc.title,
      createdAt: doc.createdAt,
    })),
    truncated: documents.length > input.limit,
  };
}
