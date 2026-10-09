import * as gatewayClient from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchExternalSourceImportDetail } from "@goatcitadel/mission-control-shared/api/external-sources";
import { fetchExternalSourceCatalogPage, createExternalSourceImportPlan, applyExternalSourceImport } from "@goatcitadel/mission-control-shared/api/external-sources";
// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { fetchEngineeringLearning, fetchEngineeringLearnings, requestEngineeringLearningAction } from "@goatcitadel/mission-control-shared/api/engineering-learnings";
import { fetchChatSessions } from "@goatcitadel/mission-control-shared/api/chat";
import { knowledgeDocsIngest, knowledgeEmbeddingsQuery, fetchKnowledgeApprovalResult } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchExternalSources, fetchExternalSourceDetail, scanExternalSource } from "@goatcitadel/mission-control-shared/api/external-sources";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { setGatewayCallerScope, notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { LibraryEngineeringLearnings } from "./LibraryEngineeringLearnings";
import { LibraryKnowledgeActions } from "./LibraryKnowledgeActions";
import { LibraryExternalSources } from "./LibraryExternalSources";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ search: window.location.search, navigate: vi.fn() }) }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/engineering-learnings", () => ({ fetchEngineeringLearning: vi.fn(), fetchEngineeringLearnings: vi.fn(), requestEngineeringLearningAction: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ knowledgeDocsIngest: vi.fn(), knowledgeEmbeddingsIndex: vi.fn(), knowledgeEmbeddingsQuery: vi.fn(), fetchKnowledgeApprovalResult: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/external-sources", async original => ({ ...await original<typeof import("@goatcitadel/mission-control-shared/api/external-sources")>(), fetchExternalSources: vi.fn(), fetchExternalSourceDetail: vi.fn(), scanExternalSource: vi.fn(), fetchExternalSourceCatalogPage: vi.fn(), createExternalSourceImportPlan: vi.fn(), applyExternalSourceImport: vi.fn(), fetchExternalSourceImportDetail: vi.fn() }));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetSessionViewStateForTests(); __resetApprovalOperationAttemptsForTests(); setGatewayCallerScope("operator-a"); window.history.replaceState(null, "", "/library/knowledge?learningId=l-a"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(fetchApproval).mockRejectedValue(new Error("Approval unavailable")); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); window.localStorage.removeItem("goatcitadel.ui.technical_details.v1"); });
async function render(child: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}>{child}</QueryClientProvider>)); }
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[aria-hidden="true"]') && (item.getAttribute("aria-label") ?? item.textContent) === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
it("does not promote a disabled Engineering deep link into reads or actions", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { engineeringLearningsV1Enabled: false } } as Awaited<ReturnType<typeof fetchSettings>>);
  await render(<LibraryEngineeringLearnings workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("disabled in this runtime")); expect(fetchEngineeringLearning).not.toHaveBeenCalled(); expect(fetchEngineeringLearnings).not.toHaveBeenCalled(); expect(requestEngineeringLearningAction).not.toHaveBeenCalled();
});
it("requests Engineering approval and preserves the pending receipt after canonical refresh", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { engineeringLearningsV1Enabled: true } } as Awaited<ReturnType<typeof fetchSettings>>);
  const learning = { learningId: "l-a", workspaceId: "one", title: "Learning", status: "proposed" as const, problem: "Problem", rootCause: "Cause", resolution: "Resolution", prevention: "Prevention", failedAttempts: [], applicablePaths: [], source: { runId: "r-a" }, fileEvidence: [], verificationEvidence: [], provenanceHash: "hash", createdAt: "now", updatedAt: "now" };
  vi.mocked(fetchEngineeringLearning).mockResolvedValue(learning); vi.mocked(fetchEngineeringLearnings).mockResolvedValue({ items: [learning] }); vi.mocked(requestEngineeringLearningAction).mockResolvedValue({ approvalId: "approval-a", kind: "engineering_learning.lifecycle", riskLevel: "danger", status: "pending", preview: {}, createdAt: "2026-10-06", explanationStatus: "not_requested", linkage: { workspaceId: "one" }, payload: { learningId: learning.learningId, action: "activate" } } as Awaited<ReturnType<typeof requestEngineeringLearningAction>>);
  await render(<LibraryEngineeringLearnings workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("Review activate learning")); await click("Review activate learning"); await click("Request learning approval"); await act(async () => { await client.invalidateQueries({ queryKey: ["library", "learning"] }); });
  expect(container.querySelector('a[href="/work/runs/r-a?shell=cockpit"]')?.textContent).toBe("Open source run"); expect(requestEngineeringLearningAction).toHaveBeenCalledExactlyOnceWith("l-a", { action: "activate" }); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("learning status has not been confirmed changed");
});
it("keeps external-source capability absence distinct from failed authenticated access", async () => {
  vi.mocked(fetchExternalSources).mockRejectedValue(new ApiRequestError("Absent", { kind: "http", method: "GET", path: "/sources", status: 404 })); await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("unavailable in this runtime")); expect(scanExternalSource).not.toHaveBeenCalled();
  vi.mocked(fetchExternalSources).mockRejectedValue(new ApiRequestError("Forbidden", { kind: "http", method: "GET", path: "/sources", status: 403 })); await act(async () => { await client.invalidateQueries(); }); await vi.waitFor(() => expect(container.textContent).toContain("specific authenticated operator"));
});
it("ingests only with fresh workspace conversation evidence and treats approval-required as pending", async () => {
  const session = { sessionId: "conversation-a", workspaceId: "one", title: "Source conversation" };
  vi.mocked(fetchChatSessions).mockResolvedValue({ items: [session] } as Awaited<ReturnType<typeof fetchChatSessions>>); vi.mocked(knowledgeDocsIngest).mockResolvedValue({ outcome: "approval_required", approvalId: "approval-a", policyReason: "Review", auditEventId: "event-a" });
  await render(<LibraryKnowledgeActions workspaceId="one" />); await vi.waitFor(() => expect(container.querySelector('option[value="conversation-a"]')).toBeTruthy());
  const select = container.querySelector("select")!; await act(async () => { select.value = "conversation-a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const input = container.querySelector("textarea")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Knowledge text"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Review knowledge ingest"); await click("Confirm knowledge request"); expect(knowledgeDocsIngest).toHaveBeenCalledExactlyOnceWith({ namespace: "workspace/one/knowledge", sessionId: "conversation-a", sourceType: "text", source: "Knowledge text", title: undefined }); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No completed ingest");
});

it("scans with the reviewed revision and keeps a sealed receipt after owner refresh", async () => {
  window.history.replaceState(null, "", "/library/knowledge?sourceId=source-a");
  const detail = { source: { sourceId: "source-a", workspaceId: "one", revision: 3, label: "Fixture source", canonicalRootPath: "C:/fixture", status: "active", adapterId: "fixture" } } as unknown as Awaited<ReturnType<typeof fetchExternalSourceDetail>>;
  vi.mocked(fetchExternalSources).mockResolvedValue({ schemaVersion: "goatcitadel.external-source.v1", workspaceId: "one", items: [] }); vi.mocked(fetchExternalSourceDetail).mockResolvedValue(detail);
  vi.mocked(scanExternalSource).mockResolvedValue({ workspaceId: "one", sourceId: "source-a", configRevision: 3, status: "sealed", supportedItemCount: 2, itemCount: 3 } as Awaited<ReturnType<typeof scanExternalSource>>);
  await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("Review source scan")); await click("Review source scan"); await click("Confirm source action"); await act(async () => { await client.invalidateQueries(); });
  expect(scanExternalSource).toHaveBeenCalledExactlyOnceWith("source-a", { workspaceId: "one", expectedRevision: 3 }); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Scan sealed: 2 supported of 3 items");
});
it("blocks scanning a source revised after review without dispatching a mutation", async () => {
  window.history.replaceState(null, "", "/library/knowledge?sourceId=source-a");
  const detail = { source: { sourceId: "source-a", workspaceId: "one", revision: 3, label: "Fixture source", canonicalRootPath: "C:/fixture", status: "active", adapterId: "fixture" } } as unknown as Awaited<ReturnType<typeof fetchExternalSourceDetail>>;
  vi.mocked(fetchExternalSources).mockResolvedValue({ schemaVersion: "goatcitadel.external-source.v1", workspaceId: "one", items: [] }); vi.mocked(fetchExternalSourceDetail).mockResolvedValue(detail);
  await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("Review source scan")); await click("Review source scan"); vi.mocked(fetchExternalSourceDetail).mockResolvedValue({ ...detail, source: { ...detail.source, revision: 4 } }); await click("Confirm source action");
  expect(scanExternalSource).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("changed during review");
});
it("renders canonical nested retrieval attribution and unavailable sources without exposing protocol IDs by default", async () => {
  vi.mocked(fetchChatSessions).mockResolvedValue({ items: [{ sessionId: "conversation-a", workspaceId: "one", title: "Source" }] } as Awaited<ReturnType<typeof fetchChatSessions>>);
  vi.mocked(knowledgeEmbeddingsQuery).mockResolvedValue({ items: [
    { chunkId: "chunk-secret-id", docId: "doc-secret-id", score: 0.9, snippet: "First excerpt", attribution: { title: "Source One", sourceRef: "notes/design.md", sourceType: "file", trustLevel: "operator" } },
    { chunkId: "second", docId: "second-doc", snippet: "Second excerpt", attribution: { title: "Source Two", sourceRef: "https://example.test/article", sourceType: "url", trustLevel: "untrusted" } },
    { chunkId: "third", snippet: "Unattributed excerpt" },
    { chunkId: "fourth", snippet: "Must not render", redacted: true },
  ] });
  await render(<LibraryKnowledgeActions workspaceId="one" />); await vi.waitFor(() => expect(container.querySelector('option[value="conversation-a"]')).toBeTruthy());
  const select = container.querySelector("select")!; await act(async () => { select.value = "conversation-a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const id = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith("Knowledge query"))!.htmlFor; const input = document.getElementById(id)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Evidence"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Review knowledge retrieval"); await click("Confirm knowledge request");
  const dialog = document.querySelector('[role="dialog"]')!.textContent!; expect(dialog).toContain("Source One"); expect(dialog).toContain("notes/design.md"); expect(dialog).toContain("Trust: operator"); expect(dialog).toContain("Source Two"); expect(dialog).toContain("Trust: untrusted"); expect(dialog).toContain("Source: Unavailable"); expect(dialog).toContain("Excerpt redacted"); expect(dialog).not.toContain("Must not render"); expect(dialog).not.toContain("doc-secret-id");
});
it("refreshes a governed original query result without a second dispatch and clears withheld results", async () => {
  vi.mocked(fetchChatSessions).mockResolvedValue({ items: [{ sessionId: "conversation-a", workspaceId: "one", title: "Source" }] } as Awaited<ReturnType<typeof fetchChatSessions>>);
  vi.mocked(knowledgeEmbeddingsQuery).mockResolvedValue({ outcome: "approval_required", approvalId: "approval-query", policyReason: "approval required by approval mode", auditEventId: "audit" });
  vi.mocked(fetchKnowledgeApprovalResult).mockResolvedValue({ approvalId: "approval-query", state: "completed", message: "Original retrieval completed.", result: { items: [{ snippet: "Original excerpt", attribution: { title: "Canonical source", sourceRef: "memory:original", sourceType: "memory", trustLevel: "trusted_operator" } }] } });
  await render(<LibraryKnowledgeActions workspaceId="one" />);
  await vi.waitFor(() => expect(container.querySelector('option[value="conversation-a"]')).toBeTruthy());
  const select = container.querySelector("select")!;
  await act(async () => { select.value = "conversation-a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const id = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith("Knowledge query"))!.htmlFor;
  await act(async () => { const input = document.getElementById(id)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Evidence"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Review knowledge retrieval"); await click("Confirm knowledge request");
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Refresh approval and record"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await vi.waitFor(() => expect([...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Refresh approval and record")?.disabled).toBe(false)); await click("Refresh approval and record");
  expect(fetchKnowledgeApprovalResult).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Original excerpt"));
  expect(fetchKnowledgeApprovalResult).toHaveBeenCalledExactlyOnceWith("approval-query", { workspaceId: "one", sessionId: "conversation-a", toolName: "embeddings.query" });
  expect(knowledgeEmbeddingsQuery).toHaveBeenCalledTimes(1);
  vi.mocked(fetchKnowledgeApprovalResult).mockResolvedValue({ approvalId: "approval-query", state: "blocked", message: "Current source policy withholds the result." });
  await click("Refresh approval and record");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Original excerpt");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Current source policy withholds");
  expect(knowledgeEmbeddingsQuery).toHaveBeenCalledTimes(1);
});

async function prepareIngest() {
  vi.mocked(fetchChatSessions).mockResolvedValue({ items: [{ sessionId: "conversation-a", workspaceId: "one", title: "Source" }] } as Awaited<ReturnType<typeof fetchChatSessions>>);
  await render(<LibraryKnowledgeActions workspaceId="one" />);
  await vi.waitFor(() => expect(container.querySelector('option[value="conversation-a"]')).toBeTruthy());
  await act(async () => { const select = container.querySelector("select")!; select.value = "conversation-a"; select.dispatchEvent(new Event("change", { bubbles: true })); const input = container.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Private operator draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Review knowledge ingest");
}
it.each(["caller", "access", "workspace"])("withholds Knowledge dispatch when %s changes during awaited conversation preflight", async change => {
  await prepareIngest();
  let finish!: (value: Awaited<ReturnType<typeof fetchChatSessions>>) => void;
  vi.mocked(fetchChatSessions).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await click("Confirm knowledge request");
  if (change === "workspace") await render(<LibraryKnowledgeActions workspaceId="two" />);
  else await act(async () => { if (change === "caller") setGatewayCallerScope("operator-b"); else notifyGatewayAccessChanged(); });
  await act(async () => finish({ items: [{ sessionId: "conversation-a", workspaceId: "one" }] } as Awaited<ReturnType<typeof fetchChatSessions>>));
  expect(knowledgeDocsIngest).not.toHaveBeenCalled();
  if (change === "caller") expect(container.querySelector("textarea")?.value).toBe("");
});
it("keeps an interrupted Knowledge write locked after presentation remount and a plain refetch", async () => {
  await prepareIngest();
  vi.mocked(knowledgeDocsIngest).mockRejectedValue(new Error("Connection lost after sending"));
  await click("Confirm knowledge request");
  await render(<div />); await render(<LibraryKnowledgeActions workspaceId="one" />);
  await act(async () => { await client.invalidateQueries(); });
  expect(container.textContent).toContain("request outcome is uncertain");
  await click("Confirm knowledge request");
  expect(knowledgeDocsIngest).toHaveBeenCalledTimes(1);
});

it("preserves sealed selection and replays only the exact idempotent import after a lost response", async () => {
 window.history.replaceState(null, "", "/library/knowledge?sourceId=source-a");
 const detail = { source: { sourceId: "source-a", workspaceId: "one", revision: 3, label: "Source", canonicalRootPath: "C:/fixture", kind: "codex_sessions", status: "active" }, latestScan: { scanId: "scan-a", status: "sealed" } } as unknown as Awaited<ReturnType<typeof fetchExternalSourceDetail>>;
 vi.mocked(fetchExternalSources).mockResolvedValue({ schemaVersion: "goatcitadel.external-source.v1", workspaceId: "one", items: [] }); vi.mocked(fetchExternalSourceDetail).mockResolvedValue(detail);
 vi.mocked(fetchExternalSourceCatalogPage).mockResolvedValue({ items: [{ itemId: "item-a", disposition: "supported", normalizedRelativePath: "session.jsonl", rawByteCount: 40, messageCount: 2, reasonCodes: [] }] } as unknown as Awaited<ReturnType<typeof fetchExternalSourceCatalogPage>>);
 const sealed = { plan: { planId: "plan-a", workspaceId: "one", sourceId: "source-a", scanId: "scan-a", planSha256: "sealed-hash", selectedItemIds: ["item-a"], blockerCodes: [], rawByteCount: 40, normalizedByteCount: 50, messageCount: 2, stagingExpiresAt: "2026-12-01T00:00:00Z" }, idempotencyKey: "exact-attempt" } as unknown as Awaited<ReturnType<typeof createExternalSourceImportPlan>>;
 vi.mocked(createExternalSourceImportPlan).mockResolvedValue(sealed); vi.mocked(applyExternalSourceImport).mockRejectedValueOnce(new Error("Lost response"));
 await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("session.jsonl"));

 const catalogCheck = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("session.jsonl"))!; if (!catalogCheck.checked) await act(async () => catalogCheck.click());
 await click("Review import plan"); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("session.jsonl"); await click("Confirm source action"); expect(createExternalSourceImportPlan).toHaveBeenCalledExactlyOnceWith({ workspaceId: "one", sourceId: "source-a", scanId: "scan-a", selectedItemIds: ["item-a"], expectedRevision: 3 }); await click("Close dialog"); await click("Review import apply"); await click("Confirm source action");
 await render(<div />); vi.mocked(fetchExternalSourceDetail).mockResolvedValue({ ...detail, source: { ...detail.source, revision: 4 } }); await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(document.body.textContent).toContain("Replay exact import request"));
 vi.mocked(applyExternalSourceImport).mockResolvedValue({ intent: { workspaceId: "one", sourceId: "source-a", planId: "plan-a", idempotencyKey: "exact-attempt", planSha256: "sealed-hash", admittedAt: "2026-10-01T00:00:00Z" }, plan: sealed.plan, items: [], applyDisposition: "replayed", settlement: { disposition: "complete", settledAt: "2026-10-01T00:00:00Z" } } as unknown as Awaited<ReturnType<typeof applyExternalSourceImport>>); await vi.waitFor(() => expect([...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Replay exact import request")?.disabled).toBe(false)); await click("Replay exact import request"); await vi.waitFor(() => expect(applyExternalSourceImport).toHaveBeenCalledTimes(2)); expect(vi.mocked(applyExternalSourceImport).mock.calls[1]).toEqual(vi.mocked(applyExternalSourceImport).mock.calls[0]); expect(applyExternalSourceImport).toHaveBeenLastCalledWith({ workspaceId: "one", planId: "plan-a", expectedPlanSha256: "sealed-hash", idempotencyKey: "exact-attempt" }); await vi.waitFor(() => expect(document.body.textContent).toContain("Import replayed"));
});

const recoveryDetail = { source: { sourceId: "source-a", workspaceId: "one", revision: 3, label: "Original source", canonicalRootPath: "C:/original", kind: "codex_sessions", status: "active" }, latestScan: { scanId: "scan-a", status: "sealed" } } as unknown as Awaited<ReturnType<typeof fetchExternalSourceDetail>>;
const recoveryPlan = { plan: { planId: "plan-a", workspaceId: "one", sourceId: "source-a", scanId: "scan-a", planSha256: "sealed-hash", selectedItemIds: ["item-a"], blockerCodes: [], rawByteCount: 40, normalizedByteCount: 50, messageCount: 2, stagingExpiresAt: "2026-12-01T00:00:00Z" }, idempotencyKey: "exact-attempt" } as unknown as Awaited<ReturnType<typeof createExternalSourceImportPlan>>;
const recoveryReceipt = { intent: { workspaceId: "one", sourceId: "source-a", planId: "plan-a", idempotencyKey: "exact-attempt", planSha256: "sealed-hash", admittedAt: "2026-10-01T00:00:00Z" }, plan: recoveryPlan.plan, items: [], applyDisposition: "replayed", settlement: { disposition: "complete", settledAt: "2026-10-01T00:00:00Z" } } as unknown as Awaited<ReturnType<typeof applyExternalSourceImport>>;
function namedButton(name: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => !button.closest('[aria-hidden="true"]') && (button.getAttribute("aria-label") ?? button.textContent) === name); }
async function prepareLostImport(committed = true) {
 window.history.replaceState(null, "", "/library/knowledge?sourceId=source-a"); vi.mocked(fetchExternalSources).mockResolvedValue({ schemaVersion: "goatcitadel.external-source.v1", workspaceId: "one", items: [] }); vi.mocked(fetchExternalSourceDetail).mockResolvedValue(recoveryDetail); vi.mocked(fetchExternalSourceImportDetail).mockResolvedValue(recoveryReceipt);
 vi.mocked(fetchExternalSourceCatalogPage).mockResolvedValue({ items: [{ itemId: "item-a", disposition: "supported", normalizedRelativePath: "original-session.jsonl", rawByteCount: 40, messageCount: 2, reasonCodes: [] }, { itemId: "item-b", disposition: "supported", normalizedRelativePath: "other-session.jsonl", rawByteCount: 30, messageCount: 1, reasonCodes: [] }] } as unknown as Awaited<ReturnType<typeof fetchExternalSourceCatalogPage>>);
 vi.mocked(createExternalSourceImportPlan).mockResolvedValue(recoveryPlan);
 // Mock only transport/owner behavior: the same idempotent request materializes once,
 // whether the first request committed before losing its response or never committed.
 let materializations = 0; let dispatched = false;
 vi.mocked(applyExternalSourceImport).mockImplementation(async () => { if (!dispatched) { dispatched = true; if (committed) materializations++; throw new Error("Lost response"); } if (!materializations) materializations++; return recoveryReceipt; });
 await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(container.textContent).toContain("original-session.jsonl"));
 const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("original-session.jsonl"))!; await act(async () => checkbox.click()); await click("Review import plan"); await click("Close dialog"); expect(createExternalSourceImportPlan).not.toHaveBeenCalled(); await click("Review import plan"); await click("Confirm source action"); await click("Close dialog"); await click("Review import apply"); await click("Confirm source action"); await vi.waitFor(() => expect(document.body.textContent).toContain("outcome is uncertain"));
 return () => materializations;
}
it.each([[true, "close"], [true, "escape"], [false, "close"], [false, "escape"]] as const)("recovers committed=%s response loss after %s, reads, changed selection and remount", async (committed, dismissal) => {
 const materializations = await prepareLostImport(committed);
 if (dismissal === "close") await click("Close dialog"); else await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
 await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
 const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("other-session.jsonl"))!; await act(async () => checkbox.click()); expect(namedButton("Review import plan")?.disabled).toBe(true); await click("Review import plan"); await click("Review source scan"); expect(createExternalSourceImportPlan).toHaveBeenCalledTimes(1); expect(scanExternalSource).not.toHaveBeenCalled();
 const lookup = [...container.querySelectorAll("label")].find(label => label.textContent === "Import record ID")!; const input = container.querySelector<HTMLInputElement>('#'+lookup.htmlFor)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"existing-import"); input.dispatchEvent(new Event("input",{bubbles:true})); }); await click("Look up import"); expect(applyExternalSourceImport).toHaveBeenCalledTimes(1);
 await render(<div />); vi.mocked(fetchExternalSourceDetail).mockResolvedValue({ ...recoveryDetail, source: { ...recoveryDetail.source, revision: 4, label: "Changed source", canonicalRootPath: "C:/changed" } }); await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(namedButton("Review import apply")?.disabled).toBe(false)); expect(document.querySelector('[role="dialog"]')).toBeNull(); await click("Review import apply");
 const dialog = document.querySelector('[role="dialog"]')!; expect(dialog.textContent).toContain("Original source"); expect(dialog.textContent).toContain("C:/original"); expect(dialog.textContent).toContain("original-session.jsonl"); expect(dialog.textContent).not.toContain("other-session.jsonl"); expect(dialog.textContent).toContain("40 source bytes"); expect(namedButton("Confirm source action")?.disabled).toBe(true); await click("Confirm source action"); expect(applyExternalSourceImport).toHaveBeenCalledTimes(1);
 await click("Replay exact import request"); await vi.waitFor(() => expect(applyExternalSourceImport).toHaveBeenCalledTimes(2)); expect(vi.mocked(applyExternalSourceImport).mock.calls[1]).toEqual(vi.mocked(applyExternalSourceImport).mock.calls[0]); expect(applyExternalSourceImport).toHaveBeenLastCalledWith({ workspaceId: "one", planId: "plan-a", expectedPlanSha256: "sealed-hash", idempotencyKey: "exact-attempt" }); await vi.waitFor(() => expect(document.body.textContent).toContain("Import replayed")); expect(materializations()).toBe(1); expect(namedButton("Replay exact import request")).toBeUndefined(); await click("Close dialog"); expect(namedButton("Review import apply")).toBeUndefined();
});
it.each(["caller", "Gateway", "workspace", "source"])("isolates uncertain import recovery from another %s", async boundary => {
 await prepareLostImport(); await click("Close dialog");
 if (boundary === "caller") await act(async () => setGatewayCallerScope("operator-b"));
 if (boundary === "Gateway") vi.spyOn(gatewayClient,"getGatewayApiBaseUrl").mockReturnValue("http://other-gateway.invalid");
 if (boundary === "source") { window.history.replaceState(null,"","/library/knowledge?sourceId=source-b"); vi.mocked(fetchExternalSourceDetail).mockResolvedValue({ ...recoveryDetail, source: { ...recoveryDetail.source, sourceId: "source-b" } }); }
 await render(<LibraryExternalSources workspaceId={boundary === "workspace" ? "two" : "one"} />); await act(async () => { await client.invalidateQueries(); }); expect(namedButton("Review import apply")).toBeUndefined(); expect(namedButton("Replay exact import request")).toBeUndefined(); expect(document.body.textContent).not.toContain("Original import request retained"); expect(applyExternalSourceImport).toHaveBeenCalledTimes(1);
});
it.each(["plan", "hash", "key", "source"])("keeps import recovery locked after a mismatched %s receipt", async mismatch => {
 await prepareLostImport(); await click("Close dialog"); await click("Review import apply");
 vi.mocked(applyExternalSourceImport).mockResolvedValueOnce({ ...recoveryReceipt, intent: { ...recoveryReceipt.intent, ...(mismatch === "plan" ? { planId: "foreign" } : mismatch === "hash" ? { planSha256: "foreign" } : mismatch === "key" ? { idempotencyKey: "foreign" } : { sourceId: "foreign" }) } });
 await click("Replay exact import request"); expect(document.body.textContent).toContain("Import receipt does not match"); expect(namedButton("Confirm source action")?.disabled).toBe(true); await click("Close dialog"); await render(<div />); await render(<LibraryExternalSources workspaceId="one" />); await vi.waitFor(() => expect(namedButton("Review import apply")?.disabled).toBe(false)); await click("Review import apply"); expect(namedButton("Replay exact import request")).toBeTruthy(); expect(applyExternalSourceImport).toHaveBeenCalledTimes(2);
});
it("fences exact replay during an awaited caller switch", async () => {
 await prepareLostImport(); await click("Close dialog"); await click("Review import apply"); let finish!: (value: typeof recoveryDetail) => void; vi.mocked(fetchExternalSourceDetail).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await click("Replay exact import request"); await act(async () => setGatewayCallerScope("operator-b")); await act(async () => finish(recoveryDetail)); expect(applyExternalSourceImport).toHaveBeenCalledTimes(1); expect(namedButton("Replay exact import request")).toBeUndefined();
});
it("settles a late matching replay only in its original presentation scope", async () => {
 await prepareLostImport(); await click("Close dialog"); await click("Review import apply"); let finish!: (value: typeof recoveryReceipt) => void; vi.mocked(applyExternalSourceImport).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await click("Replay exact import request"); await act(async () => setGatewayCallerScope("operator-b")); await act(async () => finish(recoveryReceipt)); expect(document.body.textContent).not.toContain("Import provenance"); await act(async () => setGatewayCallerScope("operator-a")); await render(<div />); await render(<LibraryExternalSources workspaceId="one" />); await act(async () => { await client.invalidateQueries(); }); expect(namedButton("Replay exact import request")).toBeUndefined(); if (namedButton("Close dialog")) await click("Close dialog"); expect(namedButton("Review import apply")).toBeUndefined(); expect(applyExternalSourceImport).toHaveBeenCalledTimes(2);
});
it("keeps the whole long catalog label operable and retains its exact reviewed path", async () => {
 const path="session/" + "long-path-segment-".repeat(40)+".jsonl";
 window.history.replaceState(null,"","/library/knowledge?sourceId=source-a");vi.mocked(fetchExternalSources).mockResolvedValue({schemaVersion:"goatcitadel.external-source.v1",workspaceId:"one",items:[]});vi.mocked(fetchExternalSourceDetail).mockResolvedValue(recoveryDetail);vi.mocked(fetchExternalSourceCatalogPage).mockResolvedValue({items:[{itemId:"long-item",normalizedRelativePath:path,disposition:"supported",reasonCodes:[]}]} as unknown as Awaited<ReturnType<typeof fetchExternalSourceCatalogPage>>);
 await render(<LibraryExternalSources workspaceId="one"/>);await vi.waitFor(()=>expect(container.textContent).toContain(path));const label=[...container.querySelectorAll('label')].find(n=>n.textContent?.includes(path))!;expect(label.classList.contains("min-h-11")).toBe(true);expect(label.classList.contains("flex")).toBe(true);expect(label.querySelector("span")?.textContent).toBe(path);await act(async()=>label.click());expect(label.querySelector("input")?.checked).toBe(true);await click("Review import plan");expect(document.querySelector('[role="dialog"]')?.textContent).toContain(path);await click("Close dialog");expect(createExternalSourceImportPlan).not.toHaveBeenCalled();
});

it("bounds the outer source and post-import provenance tracks while preserving long records and lookup input", async () => {
 window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "true");
 const label = "Source-" + "unbroken".repeat(30), rootPath = "C:/" + "source-directory/".repeat(30);
 const importId = "import-" + "a".repeat(160), artifactPath = "imported/" + "sealed-evidence/".repeat(25) + "session.jsonl";
 const source = { ...recoveryDetail.source, label, canonicalRootPath: rootPath };
 const receipt = { ...recoveryReceipt, intent: { ...recoveryReceipt.intent, importId }, items: [{
   itemId: "item-" + "b".repeat(160), normalizedByteCount: 1234, rawSha256: "a".repeat(64),
   normalizedArtifactSha256: "b".repeat(64), artifactRelativeKey: artifactPath,
 }] } as unknown as typeof recoveryReceipt;
 window.history.replaceState(null, "", "/library/knowledge?sourceId=source-a");
 vi.mocked(fetchExternalSources).mockResolvedValue({ schemaVersion: "goatcitadel.external-source.v1", workspaceId: "one", items: [source] } as Awaited<ReturnType<typeof fetchExternalSources>>);
 vi.mocked(fetchExternalSourceDetail).mockResolvedValue({ ...recoveryDetail, source });
 vi.mocked(fetchExternalSourceCatalogPage).mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof fetchExternalSourceCatalogPage>>);
 vi.mocked(fetchExternalSourceImportDetail).mockResolvedValue(receipt);
 await render(<UiPreferencesProvider><LibraryExternalSources workspaceId="one" /></UiPreferencesProvider>);
 await vi.waitFor(() => expect(container.textContent).toContain(rootPath));
 const lookupLabel = [...container.querySelectorAll("label")].find(item => item.textContent === "Import record ID")!;
 const input = document.getElementById(lookupLabel.htmlFor) as HTMLInputElement;
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, importId); input.dispatchEvent(new Event("input", { bubbles: true })); });
 await click("Look up import");
 await vi.waitFor(() => expect(container.querySelector('[aria-label="Import provenance"]')).toBeTruthy());
 expect(fetchExternalSourceImportDetail).toHaveBeenCalledExactlyOnceWith("one", importId);
 expect(input.value).toBe(importId);
 expect(container.textContent).toContain(label);
 expect(container.textContent).toContain(artifactPath);
 expect(container.textContent).toContain(receipt.items[0]!.itemId);
 expect(container.querySelector('a[href="/chat?shell=cockpit"]')?.textContent).toBe("Open Chat to attach imported source");
 // DOM proves local shrink/wrap contracts and full data retention; native QA measures pixels.
 for (const region of container.querySelectorAll('[aria-label="External sources"], [aria-label="Import provenance"]')) {
   expect(region.classList.contains("grid-cols-1")).toBe(true);
   expect(region.classList.contains("min-w-0")).toBe(true);
   expect(region.classList.contains("wrap-anywhere")).toBe(true);
 }
 for (const field of container.querySelectorAll('input:not([type="checkbox"]), select')) {
   expect(field.classList.contains("w-full")).toBe(true);
   expect(field.classList.contains("min-w-0")).toBe(true);
 }
 expect(container.querySelector('[class*="overflow-hidden"], [class*="truncate"], [class*="line-clamp"]')).toBeNull();
 expect(applyExternalSourceImport).not.toHaveBeenCalled();
});

it("keeps a long source conversation title selectable without widening the Knowledge track", async () => {
 // A select's intrinsic width is its longest option; unbounded, it widened every
 // sibling Knowledge section on phone. Native QA measures the actual pixels.
 const title = "Conversation-" + "unbroken".repeat(30) + " retained draft";
 vi.mocked(fetchChatSessions).mockResolvedValue({ items: [{ sessionId: "conversation-a", workspaceId: "one", title }] } as Awaited<ReturnType<typeof fetchChatSessions>>);
 await render(<LibraryKnowledgeActions workspaceId="one" />);
 await vi.waitFor(() => expect(container.querySelector('option[value="conversation-a"]')?.textContent).toBe(title));
 const region = container.querySelector('[aria-label="Knowledge ingest and retrieval"]')!;
 for (const token of ["grid-cols-1", "min-w-0", "max-w-full", "wrap-anywhere"]) expect(region.classList.contains(token)).toBe(true);
 const fields = region.querySelectorAll("input, select, textarea");
 expect(fields.length).toBeGreaterThanOrEqual(6);
 for (const field of fields) for (const token of ["min-w-0", "w-full", "max-w-full"]) expect(field.classList.contains(token)).toBe(true);
 const ingest = [...region.querySelectorAll("button")].find(button => button.textContent === "Review knowledge ingest")!;
 expect(ingest.parentElement!.classList.contains("flex-wrap")).toBe(true);
 expect(region.querySelector('[class*="overflow-hidden"], [class*="truncate"], [class*="line-clamp"]')).toBeNull();
 expect(knowledgeDocsIngest).not.toHaveBeenCalled();
});

it("keeps long unbroken retrieval records complete inside bounded review dialog tracks", async () => {
 // A copied snapshot chunk is canonical JSON with no spaces; unbounded, it widened the
 // modal body past the dialog edge. Native QA measures the dialog's actual pixels.
 const snippet = '{"adapterId":"codex.rollout-jsonl.v1","entries":[{"cwdSha256":"' + "5ef961cc".repeat(24) + '"}]}';
 const sourceRef = "external-source://snapshot/" + "c9bca7ce".repeat(8);
 vi.mocked(fetchChatSessions).mockResolvedValue({ items: [{ sessionId: "conversation-a", workspaceId: "one", title: "Source" }] } as Awaited<ReturnType<typeof fetchChatSessions>>);
 vi.mocked(knowledgeEmbeddingsQuery).mockResolvedValue({ items: [{ chunkId: "chunk-a", docId: "doc-a", snippet, attribution: { title: "External source snapshot " + "item".repeat(20), sourceRef, sourceType: "external_source_snapshot", trustLevel: "untrusted_external" } }] });
 await render(<LibraryKnowledgeActions workspaceId="one" />); await vi.waitFor(() => expect(container.querySelector('option[value="conversation-a"]')).toBeTruthy());
 const select = container.querySelector("select")!; await act(async () => { select.value = "conversation-a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
 const id = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith("Knowledge query"))!.htmlFor; const input = document.getElementById(id)!;
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Synthetic"); input.dispatchEvent(new Event("input", { bubbles: true })); });
 await click("Review knowledge retrieval"); await click("Confirm knowledge request");
 const dialog = document.querySelector('[role="dialog"]')!;
 expect(dialog.textContent).toContain(snippet); expect(dialog.textContent).toContain(sourceRef); expect(dialog.textContent).toContain("Trust: untrusted_external");
 const body = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Confirm knowledge request")!.parentElement!;
 for (const track of [body, body.querySelector("ul")!, body.querySelector("li")!]) for (const token of ["grid-cols-1", "min-w-0"]) expect(track.classList.contains(token)).toBe(true);
 // overflow-wrap is inherited; the body and each record establish it explicitly.
 for (const wrapping of [body, body.querySelector("li")!]) expect(wrapping.classList.contains("wrap-anywhere")).toBe(true);
 expect(dialog.querySelector('[class*="overflow-hidden"], [class*="truncate"], [class*="line-clamp"]')).toBeNull();
});
