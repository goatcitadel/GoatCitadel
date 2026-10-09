import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalReplaySnapshot, ApprovalRequest, MemoryItemRecord } from "@goatcitadel/contracts";
import { fetchMemoryItems, fetchMemoryItemHistory, patchMemoryItem, forgetMemoryItem } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { fetchApproval, fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryMemoryEditor } from "./LibraryMemoryEditor";
import { __resetInboxApprovalAttemptsForTests } from "../inbox/inbox-approval-attempts";
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ resolveApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ fetchMemoryItems: vi.fn(), fetchMemoryItemHistory: vi.fn(), patchMemoryItem: vi.fn(), forgetMemoryItem: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: vi.fn(), fetchApprovalReplay: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "one" }) }));
const item: MemoryItemRecord = { itemId: "m-a", workspaceId: "one", title: "A memory", content: "Original", metadata: {}, namespace: "workspace", pinned: false, status: "active", lifecycleState: "active", createdAt: "2026-10-01", updatedAt: "2026-10-01" };
const pendingApproval = { approvalId: "approval-a", status: "pending", kind: "memory.lifecycle" as const, action: "item_updated" as const, subjectKind: "memory_item" as const, subjectId: "m-a", workspaceId: "one", requestSha256: "a", expectedStateSha256: "b", createdAt: "now", replayed: false, itemIds: ["m-a"] };
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetApprovalOperationAttemptsForTests(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(fetchMemoryItems).mockResolvedValue({ items: [item], total: 1, snapshotAt: "now" }); vi.mocked(fetchSettings).mockResolvedValue({ features: { memoryLifecycleAdminV1Enabled: true } } as Awaited<ReturnType<typeof fetchSettings>>); vi.mocked(fetchApproval).mockRejectedValue(new Error("Approval unavailable")); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><LibraryMemoryEditor itemId="m-a" workspaceId="one" /></QueryClientProvider>)); await vi.waitFor(() => expect(container.querySelector("textarea")).toBeTruthy()); await vi.waitFor(() => expect(client.isFetching()).toBe(0)); }
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => !node.closest('[aria-hidden="true"]') && (node.getAttribute("aria-label") ?? node.textContent) === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
it("treats a 202 memory request as pending, retains the draft and persists the receipt in its real portal", async () => {
  vi.mocked(fetchApprovalReplay).mockResolvedValue(replay("pending")); vi.mocked(fetchMemoryItemHistory).mockResolvedValue({ items: [] });
  vi.mocked(patchMemoryItem).mockResolvedValue({ pendingApproval }); await render();
  const input = container.querySelector("textarea")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "My retained memory"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Review memory changes"); expect(document.querySelector('[aria-label="Proposed memory changes"]')?.textContent).toContain("My retained memory"); expect(document.querySelector('[aria-label="Proposed memory changes"]')?.textContent).toContain("Requested pinned state: unpinned"); expect(patchMemoryItem).not.toHaveBeenCalled(); await click("Request memory approval");
  await act(async () => { await client.invalidateQueries({ queryKey: ["library", "memory-item"] }); });
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No memory change is confirmed yet"));
  expect(patchMemoryItem).toHaveBeenCalledExactlyOnceWith("m-a", { title: "A memory", content: "My retained memory", pinned: false });
  await click("Close dialog"); expect(container.querySelector("textarea")?.value).toBe("My retained memory");
});
it("withholds stale writes and keeps the error through settled canonical refresh", async () => {
  await render(); await click("Review memory changes");
  vi.mocked(fetchMemoryItems).mockResolvedValue({ items: [{ ...item, content: "Changed", updatedAt: "2026-10-02" }], total: 1, snapshotAt: "now" });
  await click("Request memory approval"); await act(async () => { await client.invalidateQueries({ queryKey: ["library", "memory-item"] }); });
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("changed during review"); expect(patchMemoryItem).not.toHaveBeenCalled();
});
it("governs forget and reads bounded history separately from item content", async () => {
  vi.mocked(forgetMemoryItem).mockResolvedValue({ pendingApproval: { ...pendingApproval, action: "items_forgotten" } });
  vi.mocked(fetchMemoryItemHistory).mockResolvedValue({ items: [{ changeId: "h1", itemId: "m-a", changeType: "created", actorId: "operator", createdAt: "now", payload: {} }] });
  await render(); await click("Memory history"); await vi.waitFor(() => expect(container.textContent).toContain("operator"));
  await click("Review forget"); await click("Request memory approval"); expect(forgetMemoryItem).toHaveBeenCalledExactlyOnceWith("m-a"); expect(patchMemoryItem).not.toHaveBeenCalled();
});
it("keeps administration disabled when the feature flag is false", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { memoryLifecycleAdminV1Enabled: false } } as Awaited<ReturnType<typeof fetchSettings>>);
  await render(); expect(container.textContent).toContain("Memory administration is disabled"); await click("Review forget"); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(forgetMemoryItem).not.toHaveBeenCalled();
});

const canonicalApproval: ApprovalRequest = { approvalId: "approval-a", kind: "memory.lifecycle", riskLevel: "danger", status: "pending", payload: { memoryLifecycle: { ...pendingApproval } }, linkage: { workspaceId: "one" }, preview: { target: "A memory", requestedContent: "Original" }, createdAt: "now", explanationStatus: "pending" };
function replay(status: ApprovalRequest["status"], effectStatus?: "completed" | "failed" | "running"): ApprovalReplaySnapshot {
  return { approval: { ...canonicalApproval, payload: structuredClone(canonicalApproval.payload), status }, events: [], effects: effectStatus ? [{ effectId: "effect-a", approvalId: "approval-a", effectKind: "memory_lifecycle_apply", targetKind: "memory_record", targetId: "m-a", idempotencyKey: "effect-a", status: effectStatus, payload: {}, result: {}, attemptCount: 1, version: 1, createdAt: "now", updatedAt: "now" }] : [] };
}
function historyReceipt(action: "save" | "forget", hash = "a") {
  vi.mocked(fetchMemoryItemHistory).mockResolvedValue({ items: [{ changeId: "h1", itemId: "m-a", changeType: action === "forget" ? "forgotten" : "updated", createdAt: "later", payload: { approvalId: "approval-a", requestSha256: hash, expectedStateSha256: "b", operationKind: action === "forget" ? "approved_forget" : "approved_patch" } }] });
}
async function requestReview(action: "save" | "forget" = "save") {
  vi.mocked(fetchApproval).mockResolvedValue(canonicalApproval);
  const initial = replay("pending");
  if (action === "forget") (initial.approval.payload.memoryLifecycle as Record<string, unknown>).action = "items_forgotten";
  vi.mocked(fetchApprovalReplay).mockResolvedValue(initial);
  vi.mocked(fetchMemoryItemHistory).mockResolvedValue({ items: [] });
  vi.mocked(patchMemoryItem).mockResolvedValue({ pendingApproval });
  vi.mocked(forgetMemoryItem).mockResolvedValue({ pendingApproval: { ...pendingApproval, action: "items_forgotten" } });
  await render(); await click(action === "save" ? "Review memory changes" : "Review forget"); await click("Request memory approval");
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("Approval requested."));
  await vi.waitFor(() => expect([...document.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === "Refresh approval and record")?.disabled).toBe(false));
}
it.each(["save", "forget"] as const)("replaces the initial %s request with canonical effect and bound item/history readback", async action => {
  await requestReview(action);
  const settled = replay("approved", "completed");
  if (action === "forget") (settled.approval.payload.memoryLifecycle as Record<string, unknown>).action = "items_forgotten";
  vi.mocked(fetchApproval).mockResolvedValue(settled.approval); vi.mocked(fetchApprovalReplay).mockResolvedValue(settled);
  historyReceipt(action);
  vi.mocked(fetchMemoryItems).mockResolvedValue({ items: [{ ...item, status: action === "forget" ? "forgotten" : "active", updatedAt: "later" }], total: 1, snapshotAt: "later" });
  await click("Refresh approval and record");
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("Original memory effect completed; matching change history confirmed."));
  expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain(`Current memory record: ${action === "forget" ? "forgotten" : "active"}`);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("No memory change is confirmed yet");
  expect(patchMemoryItem).toHaveBeenCalledTimes(action === "save" ? 1 : 0);
  expect(forgetMemoryItem).toHaveBeenCalledTimes(action === "forget" ? 1 : 0);
});
it.each(["approved-only", "failed", "missing-history", "wrong-history"] as const)("does not infer completion from matching content with %s evidence", async state => {
  await requestReview();
  const settled = replay("approved", state === "failed" ? "failed" : state === "approved-only" ? undefined : "completed");
  vi.mocked(fetchApproval).mockResolvedValue(settled.approval); vi.mocked(fetchApprovalReplay).mockResolvedValue(settled);
  if (state === "wrong-history") historyReceipt("save", "other-request");
  await click("Refresh approval and record");
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain(state === "failed" ? "Memory effect failed" : "not verified"));
  const receipt = document.querySelector('[aria-label="Memory request receipt"]');
  expect(receipt?.textContent).toContain(state === "failed" ? "Memory effect failed" : "not verified");
  expect(receipt?.textContent).not.toContain("Original memory effect completed;");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("No memory change is confirmed yet");
});

it("tracks an independent decision, running effect, completed history and later unavailable owner without stale success", async () => {
  await requestReview();
  const running = replay("approved", "running");
  vi.mocked(fetchApproval).mockResolvedValue(running.approval); vi.mocked(fetchApprovalReplay).mockResolvedValue(running);
  await click("Refresh approval and record");
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("Memory effect is pending"));
  expect(document.querySelector('[aria-label="Library approval"]')?.textContent).toContain("Decision recorded: approved");
  expect(document.querySelector('[aria-label="Library approval"] [aria-label="Approval decisions"]')).toBeNull();
  vi.mocked(fetchApprovalReplay).mockResolvedValue(replay("approved", "completed")); historyReceipt("save");
  await act(async () => { await client.invalidateQueries({ queryKey: ["library"] }); });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("matching change history confirmed"));
  vi.mocked(fetchMemoryItemHistory).mockRejectedValue(new Error("History unavailable"));
  await act(async () => { await client.invalidateQueries({ queryKey: ["library"] }); });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("current owner evidence is unavailable"));
  expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).not.toContain("Original memory effect completed");
  expect(container.querySelector("textarea")?.value).toBe("Original");
});

it.each(["rejected", "blocked", "wrong-request", "foreign-effect"])("keeps the distinct %s receipt without inferring a memory write", async state => {
  await requestReview();
  const result = replay(state === "rejected" ? "rejected" : "approved", "completed"); historyReceipt("save");
  if (state === "blocked") result.approval.actionOutcome = "policy_blocked";
  if (state === "wrong-request") (result.approval.payload.memoryLifecycle as Record<string, unknown>).requestSha256 = "other-request";
  if (state === "foreign-effect") result.effects[0]!.approvalId = "other-approval";
  vi.mocked(fetchApprovalReplay).mockResolvedValue(result);
  await act(async () => { await client.invalidateQueries({ queryKey: ["library"] }); });
  const text = state === "rejected" ? "Memory request rejected" : state === "blocked" ? "blocked by policy" : state === "wrong-request" ? "does not match this memory request" : "not verified";
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain(text));
  expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).not.toContain("Original memory effect completed");
});

it("does not replace newer canonical effect evidence with a late pending response", async () => {
  await requestReview();
  let finish!: (value: ApprovalReplaySnapshot) => void;
  vi.mocked(fetchApprovalReplay).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => { void client.invalidateQueries({ queryKey: ["library", "memory-receipt"] }); });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("Checking canonical"));
  vi.mocked(fetchApprovalReplay).mockResolvedValue(replay("approved", "completed")); historyReceipt("save");
  await act(async () => { await client.invalidateQueries({ queryKey: ["library", "memory-receipt"] }); });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("matching change history confirmed"));
  await act(async () => finish(replay("pending")));
  expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("matching change history confirmed");
  expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).not.toContain("No memory change is confirmed yet");
});

it("does not carry a late original receipt or review across a selected item change", async () => {
  await requestReview();
  let finish!: (value: ApprovalReplaySnapshot) => void;
  vi.mocked(fetchApprovalReplay).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => { void client.invalidateQueries({ queryKey: ["library", "memory-receipt"] }); });
  const second = { ...item, itemId: "m-b", title: "Second memory" };
  vi.mocked(fetchMemoryItems).mockResolvedValue({ items: [item, second], total: 2, snapshotAt: "now" });
  await act(async () => root.render(<QueryClientProvider client={client}><LibraryMemoryEditor itemId="m-b" workspaceId="one" /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain("Second memory"));
  await act(async () => finish(replay("approved", "completed")));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[aria-label="Memory request receipt"]')).toBeNull();
});

it("uses the real Library decision portal then replaces its pending decision receipt after effect settlement", async () => {
  __resetInboxApprovalAttemptsForTests();
  await requestReview();
  const running = replay("approved", "running");
  vi.mocked(resolveApproval).mockImplementation(async () => {
    vi.mocked(fetchApproval).mockResolvedValue(running.approval);
    vi.mocked(fetchApprovalReplay).mockResolvedValue(running);
    return { ...running, replay: running };
  });
  await click("Review approval"); await click("Approve once");
  expect(resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("Memory effect is pending"));
  const completed = replay("approved", "completed");
  completed.approval.followUp = { status: "completed" };
  vi.mocked(fetchApproval).mockResolvedValue(completed.approval); vi.mocked(fetchApprovalReplay).mockResolvedValue(completed); historyReceipt("save");
  await act(async () => { await client.invalidateQueries({ queryKey: ["library"] }); });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Memory request receipt"]')?.textContent).toContain("matching change history confirmed"));
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Follow-on settlement is pending");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("No memory change is confirmed yet");
  expect(resolveApproval).toHaveBeenCalledOnce();
  __resetInboxApprovalAttemptsForTests();
});

it("captures reviewed TTL seconds in the governed patch", async () => {
 vi.mocked(patchMemoryItem).mockResolvedValue({ pendingApproval }); await render(); const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"7200"); input.dispatchEvent(new Event("input",{bubbles:true})); }); await click("Review memory changes"); expect(document.querySelector('[aria-label="Proposed memory changes"]')?.textContent).toContain("Requested TTL: 7200 seconds"); await click("Request memory approval"); expect(patchMemoryItem).toHaveBeenCalledExactlyOnceWith("m-a", { title: "A memory", content: "Original", pinned: false, ttlOverrideSeconds: 7200 });
});
it("withholds an invalid TTL before the mutation owner", async () => {
 await render(); const input = container.querySelector<HTMLInputElement>('input[type="number"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"-1"); input.dispatchEvent(new Event("input",{bubbles:true})); }); await click("Review memory changes"); await click("Request memory approval"); expect(patchMemoryItem).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("TTL must be empty");
});
