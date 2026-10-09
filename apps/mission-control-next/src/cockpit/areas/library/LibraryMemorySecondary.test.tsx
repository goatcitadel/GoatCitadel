// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { MemoryItemRecord } from "@goatcitadel/contracts";
import { LibraryMemoryBatch } from "./LibraryMemoryBatch";
import { LibraryMemoryDiagnostics } from "./LibraryMemoryDiagnostics";
import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), list: vi.fn(), batch: vi.fn(), snapshot: vi.fn(), scan: vi.fn(), issues: vi.fn(), patchIssue: vi.fn(), evidence: vi.fn(), reload: vi.fn(), recommendations: vi.fn(), maintenance: vi.fn(), accept: vi.fn(), approval: vi.fn(), replay: vi.fn(), history: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: mocks.settings }));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ fetchMemoryItems: mocks.list, batchMutateMemoryItems: mocks.batch, fetchMemoryItemHistory: mocks.history }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: mocks.approval, fetchApprovalReplay: mocks.replay }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot", () => ({ useMemoryOperatorSnapshot: mocks.snapshot }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchSettings: mocks.settings, fetchEvidenceEnvelopes: mocks.evidence, runMemoryQualityScan: mocks.scan, fetchMemoryQualityIssues: mocks.issues, patchMemoryQualityIssue: mocks.patchIssue, fetchMemoryMaintenanceRecommendations: mocks.recommendations, fetchMemoryMaintenanceStatus: mocks.maintenance, acceptMemoryMaintenanceRecommendation: mocks.accept }));
const item = { itemId: "a", workspaceId: "one", title: "Reviewed memory", content: "Original", namespace: "workspace", metadata: {}, pinned: false, status: "active", lifecycleState: "active", updatedAt: "2026-10-01", createdAt: "2026-10-01" } as MemoryItemRecord;
const issue = { issueId: "q", workspaceId: "one", summary: "Duplicate source", rationale: "Two retained entries", status: "open", severity: "warning", updatedAt: "2026-10-01" };
const policy = { workspaceId: "one", revision: "p1", enabled: true, runMode: "manual", timingStrategy: "fixed", timeZone: "UTC", minHoursSinceLastSuccess: 24, minChangedSessions: 2, executionTarget: "local", unavailableModelPolicy: "skip" };
const recommendation = { recommendationId: "r", workspaceId: "one", revision: "r1", status: "queued", summary: "Change schedule", proposedPatch: { schedule: { hour: 3, minute: 15 } }, updatedAt: "2026-10-01" };
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetApprovalOperationAttemptsForTests(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); setGatewayCallerScope("a"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); mocks.settings.mockResolvedValue({ features: { memoryLifecycleAdminV1Enabled: true, memoryMaintenanceV1Enabled: true, durableKernelV1Enabled: true } }); mocks.list.mockResolvedValue({ items: [item], total: 1 }); mocks.evidence.mockResolvedValue({ items: [] }); mocks.issues.mockResolvedValue({ items: [issue] }); mocks.snapshot.mockReturnValue({ loading: false, reload: mocks.reload, data: { memoryAdminEnabled: true, memoryQualityIssues: [issue], memoryFeedback: [], maintenanceEnabled: true, maintenanceDurableReady: true, maintenanceStatus: { policy }, maintenanceRecommendations: [recommendation], maintenanceRuns: [], sectionErrors: {} } }); mocks.recommendations.mockResolvedValue({ items: [recommendation] }); mocks.maintenance.mockResolvedValue({ policy }); mocks.approval.mockRejectedValue(new Error("Unavailable")); mocks.replay.mockRejectedValue(new Error("Unavailable")); mocks.history.mockResolvedValue({ items: [] }); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render(child: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}>{child}</QueryClientProvider>)); }
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => !node.closest('[aria-hidden="true"]') && node.textContent === name); expect(button).toBeTruthy(); await act(async () => button!.click()); }
const batch = () => <LibraryMemoryBatch workspaceId="one" items={[item]} available onClear={() => undefined} onRefresh={async () => undefined} />;
it("reviews exact batch targets, cancels without mutation, and requests the existing atomic owner once", async () => {
 await render(batch()); await click("Review pin selected memory"); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Reviewed memory · workspace · Unpinned"); await click("Cancel"); expect(mocks.batch).not.toHaveBeenCalled();
 mocks.batch.mockResolvedValue({ pendingApproval: { approvalId: "approval", workspaceId: "one", action: "batch_mutated", subjectKind: "memory_item_batch", itemIds: ["a"] } });
 await click("Review pin selected memory"); await click("Request batch memory approval"); expect(mocks.batch).toHaveBeenCalledExactlyOnceWith({ source: "mission-control:library", operations: [{ kind: "patch_item", itemId: "a", patch: { pinned: true } }] });
});
it("withholds a batch when any reviewed target changed", async () => {
 await render(batch()); await click("Review forget selected memory"); mocks.list.mockResolvedValue({ items: [{ ...item, content: "Another write" }], total: 1 }); await click("Request batch memory approval"); expect(mocks.batch).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("changed or is not owned");
});
it("locks a lost batch response across navigation and another action", async () => {
 mocks.batch.mockRejectedValue(new Error("Lost response")); await render(batch()); await click("Review unpin selected memory"); await click("Request batch memory approval"); await render(<div />); await render(batch()); expect(document.body.textContent).toContain("uncertain"); await click("Request batch memory approval"); expect(mocks.batch).toHaveBeenCalledTimes(1);
});
it("checks the current quality record before a reviewed status mutation", async () => {
 await render(<LibraryMemoryDiagnostics workspaceId="one" />); await click("Review resolved"); mocks.issues.mockResolvedValue({ items: [{ ...issue, status: "dismissed" }] }); await click("Confirm memory operation"); expect(mocks.patchIssue).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("reviewed record changed");
});
it("fences a caller change during awaited quality preflight", async () => {
 await render(<LibraryMemoryDiagnostics workspaceId="one" />); await click("Review quality scan"); let finish!: (value: unknown) => void; mocks.settings.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await click("Confirm memory operation"); await act(async () => setGatewayCallerScope("b")); await act(async () => finish({ features: { memoryLifecycleAdminV1Enabled: true } })); expect(mocks.scan).not.toHaveBeenCalled();
});
it("reviews nested recommendation values and binds both recommendation and policy revisions", async () => {
 mocks.accept.mockResolvedValue({ recommendation: { ...recommendation, status: "applied", revision: "r2" }, policy: { ...policy, revision: "p2" } }); await render(<LibraryMemoryDiagnostics workspaceId="one" />); await click("Memory maintenance"); await click("Review accept recommendation"); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("hour: 3; minute: 15"); await click("Confirm memory operation"); expect(mocks.accept).toHaveBeenCalledExactlyOnceWith("r", { expectedRevision: "r1", expectedPolicyRevision: "p1" }); expect(document.body.textContent).toContain("Recommendation accept receipt returned");
});
it("does not accept a recommendation against a changed policy", async () => {
 await render(<LibraryMemoryDiagnostics workspaceId="one" />); await click("Memory maintenance"); await click("Review accept recommendation"); mocks.maintenance.mockResolvedValue({ policy: { ...policy, revision: "p2" } }); await click("Confirm memory operation"); expect(mocks.accept).not.toHaveBeenCalled();
});
it("retains full long maintenance evidence inside shrinkable wrapping regions", async () => {
 const long = "source/" + "unbroken-evidence-".repeat(80);
 const snapshot = mocks.snapshot.getMockImplementation()!();
 mocks.snapshot.mockReturnValue({ ...snapshot, data: { ...snapshot.data, selectedRunProvenance: { run: {status:"completed",summary:long},sources:[{sourceId:"s",sourceKind:"session",excerpt:long,sourceRef:long,modifiedAt:"2026-10-06"}],changes:[{changeId:"c",summary:long,targetKind:"memory",targetRef:long,beforeRef:long,afterRef:long,createdAt:"2026-10-06"}] } } });
 await render(<LibraryMemoryDiagnostics workspaceId="one" />);await click("Memory maintenance");
 const region=container.querySelector('[aria-label="Maintenance run provenance"]')!;
 expect(region.textContent).toContain(long);expect(region.classList.contains("min-w-0")).toBe(true);expect(region.classList.contains("grid-cols-1")).toBe(true);expect(region.classList.contains("wrap-anywhere")).toBe(true);expect(region.querySelectorAll('li p.whitespace-pre-wrap')).toHaveLength(2);
 expect([...region.querySelectorAll('*')].some(n=>/overflow-hidden|truncate|line-clamp/.test(n.className))).toBe(false);
});
