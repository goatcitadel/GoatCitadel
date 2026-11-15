import { expect, it, vi } from "vitest";
import { listKnowledgeDocuments } from "./knowledge-document-list.js";

const doc = (n: number) => ({
  docId: `d${n}`,
  namespace: "general",
  sourceType: "text" as const,
  sourceRef: "secret-ref",
  title: `Doc ${n}`,
  metadata: { token: "x" },
  createdAt: `2026-11-0${n}T00:00:00Z`,
});
const readerWith = (docs: ReturnType<typeof doc>[]) => {
  const listDocuments = vi.fn(async () => docs);
  return { storage: { listDocuments } as never, listDocuments };
};

it("maps documents to summaries without content, reference or metadata", async () => {
  const { storage } = readerWith([doc(2), doc(1)]);
  const result = await listKnowledgeDocuments(storage, { limit: 5 });
  expect(result.truncated).toBe(false);
  expect(result.items).toEqual([
    { docId: "d2", namespace: "general", sourceType: "text", title: "Doc 2", createdAt: "2026-11-02T00:00:00Z" },
    { docId: "d1", namespace: "general", sourceType: "text", title: "Doc 1", createdAt: "2026-11-01T00:00:00Z" },
  ]);
  expect(JSON.stringify(result)).not.toContain("secret-ref");
});
it("reports truncation when more than the limit came back", async () => {
  const { storage, listDocuments } = readerWith([doc(3), doc(2), doc(1)]);
  const result = await listKnowledgeDocuments(storage, { limit: 2 });
  expect(result.items.map((item) => item.docId)).toEqual(["d3", "d2"]);
  expect(result.truncated).toBe(true);
  expect(listDocuments).toHaveBeenCalledWith(undefined, 3);
});
it("passes the namespace through", async () => {
  const { storage, listDocuments } = readerWith([]);
  await listKnowledgeDocuments(storage, { namespace: "workspace:a", limit: 50 });
  expect(listDocuments).toHaveBeenCalledWith("workspace:a", 51);
});
