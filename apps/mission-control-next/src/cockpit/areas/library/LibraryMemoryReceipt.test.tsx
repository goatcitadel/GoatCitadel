// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { ApprovalReplaySnapshot, MemoryChangeEvent } from "@goatcitadel/contracts";
import type { MemoryLifecyclePendingApproval } from "@goatcitadel/mission-control-shared/api/memory";
import { LibraryMemoryReceipt } from "./LibraryMemoryReceipt";
const mocks = vi.hoisted(() => ({ replay: vi.fn(), history: vi.fn(), items: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovalReplay: mocks.replay }));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ fetchMemoryItemHistory: mocks.history, fetchMemoryItems: mocks.items }));
const request = { approvalId: "approval-original", workspaceId: "one", action: "batch_mutated", subjectKind: "memory_item_batch", requestSha256: "request-hash", expectedStateSha256: "state-hash", itemIds: ["a", "b"] } as MemoryLifecyclePendingApproval;
let root: Root, client: QueryClient, container: HTMLDivElement;
beforeEach(() => { vi.resetAllMocks(); container=document.createElement("div");document.body.append(container);root=createRoot(container);client=new QueryClient({defaultOptions:{queries:{retry:false}}}); mocks.items.mockResolvedValue({ items: [{ itemId:"b",workspaceId:"one",metadata:{},title:"Later current record",content:"Readback is not effect proof",pinned:false,status:"active",updatedAt:"2026-10-06T00:00:00Z" }],total:1 }); });
afterEach(() => { act(() => root.unmount());client.clear();container.remove(); });
function evidence(action: "pin"|"unpin"|"forget") {
 const operations = request.itemIds.map(itemId => action === "forget" ? { kind:"forget_item",itemId } : {kind:"patch_item",itemId,patch:{pinned:action === "pin"}});
 const replay = {approval:{approvalId:request.approvalId,kind:"memory.lifecycle",status:"approved",linkage:{workspaceId:"one"},payload:{memoryLifecycle:{...request},request:{mutation:{operations}}}},events:[],effects:[{approvalId:request.approvalId,effectKind:"memory_lifecycle_apply",targetKind:"memory_record",targetId:request.approvalId,status:"completed",payload:{workspaceId:"one",action:request.action,subjectKind:request.subjectKind,requestSha256:request.requestSha256},result:{workspaceId:"one",action:request.action,subjectKind:request.subjectKind,itemIds:["b","a"],disposition:"applied",changedCount:2}}]} as unknown as ApprovalReplaySnapshot;
 const history = {items:[{changeId:"original-history",itemId:"b",changeType:action === "forget" ? "forgotten" : "pin_changed",createdAt:"2026-10-06T00:00:00Z",payload:{approvalId:request.approvalId,requestSha256:request.requestSha256,expectedStateSha256:request.expectedStateSha256,operationKind:"approved_batch",batchOperationIndex:1,batchOperationKind:action === "forget" ? "forget_item" : "patch_item",fieldCodes:[action === "forget" ? "status" : "pinned"]}}]} as {items:MemoryChangeEvent[]};
 return {replay,history};
}
async function render(action: "pin"|"unpin"|"forget") { await act(async () => root.render(<QueryClientProvider client={client}><LibraryMemoryReceipt request={request} itemId="b" workspaceId="one" batchAction={action}/></QueryClientProvider>));await vi.waitFor(() => expect(client.isFetching()).toBe(0)); }
it.each(["pin","unpin","forget"] as const)("confirms original %s batch from canonical operation/effect/history, independent of later item state", async action => {const e=evidence(action);mocks.replay.mockResolvedValue(e.replay);mocks.history.mockResolvedValue(e.history);await render(action);await vi.waitFor(() => expect(container.textContent).toContain("Original memory effect completed"));expect(container.textContent).toContain("Later current record");expect(mocks.history).toHaveBeenCalledExactlyOnceWith("b",100);});
it.each(["history-type","request-hash","state-hash","history-item","history-approval","history-operation","history-index","absent-effect","failed-effect","effect-target","effect-hash","effect-workspace","effect-result-item","effect-result-workspace","wrong-pin","approval-hash","approval-workspace"])("does not confirm from current pinned state with %s mismatch", async failure => {
 const e=evidence("pin"),change=e.history.items[0]!,effect=e.replay.effects[0]!;
 if(failure === "history-type") change.changeType="updated";
 if(failure === "request-hash") change.payload.requestSha256="foreign";
 if(failure === "state-hash") change.payload.expectedStateSha256="foreign";
 if(failure === "history-item") change.itemId="a";
 if(failure === "history-approval") change.payload.approvalId="foreign";
 if(failure === "history-operation") change.payload.batchOperationKind="forget_item";
 if(failure === "history-index") change.payload.batchOperationIndex=0;
 if(failure === "absent-effect") e.replay.effects=[];
 if(failure === "failed-effect") effect.status="failed";
 if(failure === "effect-target") effect.targetId="foreign";
 if(failure === "effect-hash") effect.payload.requestSha256="foreign";
 if(failure === "effect-workspace") effect.payload.workspaceId="foreign";
 if(failure === "effect-result-item") effect.result!.itemIds=["a","foreign"];
 if(failure === "effect-result-workspace") effect.result!.workspaceId="foreign";
 if(failure === "wrong-pin") (e.replay.approval.payload.request as {mutation:{operations:{patch:{pinned:boolean}}[]}}).mutation.operations[1]!.patch.pinned=false;
 if(failure === "approval-hash") (e.replay.approval.payload.memoryLifecycle as Record<string,unknown>).requestSha256="foreign";
 if(failure === "approval-workspace") e.replay.approval.linkage!.workspaceId="foreign";
 mocks.replay.mockResolvedValue(e.replay);mocks.history.mockResolvedValue(e.history);mocks.items.mockResolvedValue({items:[{itemId:"b",workspaceId:"one",metadata:{},title:"Already pinned",pinned:true,status:"active",updatedAt:"now"}],total:1});await render("pin");await vi.waitFor(() => expect(container.textContent).toMatch(/not verified|effect failed/));expect(container.textContent).not.toContain("Original memory effect completed");
});
