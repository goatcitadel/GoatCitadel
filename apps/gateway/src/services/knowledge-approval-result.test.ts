import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Storage, createLocalAsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { KnowledgeApprovalResultQuery, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { readKnowledgeApprovalResult } from "./knowledge-approval-result.js";
import { KnowledgeFacadeService } from "./memory-facade-service.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
});
function fixture(kind: "dm" | "group" = "dm") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-result-test-"));
  const sync = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanups.push(() => {
    sync.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const storage = createLocalAsyncStorage(sync);
  sync.sessions.upsert({
    sessionId: "session-a",
    sessionKey: "test:session-a",
    kind,
    channel: "test",
    account: "operator",
    timestamp: new Date().toISOString(),
  });
  sync.chatSessionMeta.ensure("session-a", undefined, "default");
  const config: ToolPolicyConfig = {
    tools: { approvalMode: "approve_all", allow: ["*"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
  const engine = new ToolPolicyEngine(config, storage);
  const invoke = vi.fn((request: ToolInvokeRequest) => engine.invoke({ ...request, workspaceId: "default" }));
  const facade = new KnowledgeFacadeService({ invokeAndUnwrap: invoke });
  const port = {
    storage,
    evaluateToolAccess: (request: Parameters<typeof engine.evaluateAccess>[0]) => engine.evaluateAccess(request),
  };
  const scope: KnowledgeApprovalResultQuery = {
    workspaceId: "default",
    sessionId: "session-a",
    toolName: "embeddings.query",
  };
  return { sync, storage, engine, facade, invoke, port, config, scope };
}
it("reads the original ask-always query after real approval and one execution, then rechecks source and scope", async () => {
  const f = fixture();
  const doc = f.sync.knowledge.createDocument({
    namespace: "decisions",
    title: "Canonical decision",
    sourceType: "memory",
    sourceRef: "memory:fixture",
    metadata: {},
  });
  f.sync.knowledge.appendChunks(doc.docId, [{ content: "Use the existing local store" }]);
  const pending = await f.facade.knowledgeEmbeddingsQuery({
    namespace: "decisions",
    sessionId: "session-a",
    query: "local store",
    limit: 20,
  });
  expect(pending).toMatchObject({ outcome: "approval_required" });
  const approvalId = pending.approvalId as string;
  expect(f.sync.approvals.get(approvalId).preview).toMatchObject({
    reviewKind: "knowledge.operation",
    query: "local store",
    target: "Knowledge namespace: decisions",
  });
  expect(await readKnowledgeApprovalResult(f.port, approvalId, f.scope)).toMatchObject({ state: "pending" });
  f.sync.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator" });
  expect(await readKnowledgeApprovalResult(f.port, approvalId, f.scope)).toMatchObject({ state: "pending" });
  expect(await f.engine.executeApprovedAction(approvalId)).toMatchObject({ outcome: "executed" });
  const receipt = await readKnowledgeApprovalResult(f.port, approvalId, f.scope);
  expect(receipt).toMatchObject({
    state: "completed",
    result: {
      items: [
        {
          docId: doc.docId,
          snippet: "Use the existing local store",
          attribution: { title: "Canonical decision", sourceRef: "memory:fixture" },
        },
      ],
    },
  });
  expect(await readKnowledgeApprovalResult(f.port, approvalId, f.scope)).toEqual(receipt);
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(await f.engine.executeApprovedAction(approvalId)).toBeUndefined();
  await expect(
    readKnowledgeApprovalResult(f.port, approvalId, { ...f.scope, workspaceId: "foreign" }),
  ).rejects.toThrow();
  await expect(
    readKnowledgeApprovalResult(f.port, approvalId, { ...f.scope, toolName: "docs.ingest" }),
  ).rejects.toThrow();
  f.config.tools.deny = ["embeddings.query"];
  expect(await readKnowledgeApprovalResult(f.port, approvalId, f.scope)).toMatchObject({ state: "blocked" });
  f.config.tools.deny = [];
  f.sync.knowledge.deleteDocument(doc.docId);
  expect(await readKnowledgeApprovalResult(f.port, approvalId, f.scope)).toMatchObject({
    state: "completed",
    result: { items: [] },
  });
});
it.each(["reject", "fail"] as const)("keeps %s outcomes distinct from completion", async (decision) => {
  const f = fixture();
  const pending = await f.facade.knowledgeEmbeddingsQuery({
    sessionId: "session-a",
    namespace: "decisions",
    query: "evidence",
  });
  const id = pending.approvalId as string;
  f.sync.approvals.resolve(id, { decision: decision === "reject" ? "reject" : "approve", resolvedBy: "operator" });
  if (decision === "fail")
    f.sync.pendingApprovalActions.markResolved(id, "failed", {
      outcome: "blocked",
      result: { items: [{ snippet: "must not leak" }] },
    });
  const receipt = await readKnowledgeApprovalResult(f.port, id, f.scope);
  expect(receipt.state).toBe(decision === "reject" ? "denied" : "blocked");
  expect(receipt.result).toBeUndefined();
});

it("withholds workspace-private sources from a group conversation", async () => {
  const f = fixture("group");
  const doc = f.sync.knowledge.createDocument({
    namespace: "private",
    title: "Private",
    sourceType: "text",
    sourceRef: "text:private",
    metadata: {},
  });
  f.sync.knowledge.appendChunks(doc.docId, [{ content: "Private material" }]);
  const pending = await f.facade.knowledgeEmbeddingsQuery({
    sessionId: "session-a",
    namespace: "private",
    query: "private",
  });
  const id = pending.approvalId as string;
  f.sync.approvals.resolve(id, { decision: "approve", resolvedBy: "operator" });
  await f.engine.executeApprovedAction(id);
  const receipt = await readKnowledgeApprovalResult(f.port, id, f.scope);
  expect(receipt).toMatchObject({ state: "completed", result: { items: [] } });
  expect(JSON.stringify(receipt)).not.toContain("Private material");
});

it("returns the actual document.docId after governed ingest and the original indexing outcome", async () => {
  const f = fixture();
  const pending = await f.facade.knowledgeDocsIngest({
    sessionId: "session-a",
    namespace: "docs",
    sourceType: "text",
    source: "Exact source text",
    title: "Source title",
  });
  const id = pending.approvalId as string;
  expect(f.sync.approvals.get(id).preview).toMatchObject({ source: "Exact source text" });
  f.sync.approvals.resolve(id, { decision: "approve", resolvedBy: "operator" });
  await f.engine.executeApprovedAction(id);
  const doc = f.sync.knowledge.listDocuments("docs", 1)[0]!;
  const ingestReceipt = await readKnowledgeApprovalResult(f.port, id, { ...f.scope, toolName: "docs.ingest" });
  expect(ingestReceipt).toMatchObject({ state: "completed", result: { document: { docId: doc.docId } } });
  const index = await f.facade.knowledgeEmbeddingsIndex({ sessionId: "session-a", namespace: "docs" });
  const indexId = index.approvalId as string;
  f.sync.approvals.resolve(indexId, { decision: "approve", resolvedBy: "operator" });
  await f.engine.executeApprovedAction(indexId);
  expect(
    await readKnowledgeApprovalResult(f.port, indexId, { ...f.scope, toolName: "embeddings.index" }),
  ).toMatchObject({ state: "completed" });
  expect(f.invoke).toHaveBeenCalledTimes(2);
});

it("withholds separately protected file sources and carried source attribution under current ask-always policy", async () => {
  const f = fixture();
  for (const sourceType of ["file", "memory"] as const) {
    const doc = f.sync.knowledge.createDocument({
      namespace: "protected",
      title: "Protected",
      sourceType,
      sourceRef: "C:/restricted/source.txt",
      metadata:
        sourceType === "memory"
          ? { sourceAttribution: [{ sourceType: "file", sourceRef: "C:/restricted/carried.txt" }] }
          : {},
    });
    f.sync.knowledge.appendChunks(doc.docId, [{ content: "Protected original excerpt" }]);
  }
  const pending = await f.facade.knowledgeEmbeddingsQuery({
    sessionId: "session-a",
    namespace: "protected",
    query: "protected",
  });
  const id = pending.approvalId as string;
  f.sync.approvals.resolve(id, { decision: "approve", resolvedBy: "operator" });
  expect(await f.engine.executeApprovedAction(id)).toMatchObject({ outcome: "executed" });
  const receipt = await readKnowledgeApprovalResult(f.port, id, f.scope);
  expect(receipt).toMatchObject({ state: "completed", result: { items: [] } });
  expect(receipt.message).toContain("2 withheld");
  expect(JSON.stringify(receipt)).not.toContain("restricted");
});

it("fails closed on a changed captured request and missing canonical execution result", async () => {
  const f = fixture();
  const pending = await f.facade.knowledgeEmbeddingsQuery({
    sessionId: "session-a",
    namespace: "docs",
    query: "original",
  });
  const id = pending.approvalId as string;
  const captured = f.sync.pendingApprovalActions.get(id);
  f.sync.pendingApprovalActions.upsertPending({
    approvalId: id,
    actionType: "tool.invoke",
    request: { ...captured.request, args: { namespace: "docs", query: "changed" } },
    expiresAt: captured.expiresAt,
  });
  await expect(readKnowledgeApprovalResult(f.port, id, f.scope)).rejects.toThrow(/bound knowledge approval/);
  f.sync.pendingApprovalActions.upsertPending({
    approvalId: id,
    actionType: "tool.invoke",
    request: captured.request,
    expiresAt: captured.expiresAt,
  });
  f.sync.approvals.resolve(id, { decision: "approve", resolvedBy: "operator" });
  f.sync.pendingApprovalActions.markResolved(id, "executed", {});
  expect(await readKnowledgeApprovalResult(f.port, id, f.scope)).toMatchObject({ state: "uncertain" });
});
