// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { __resetApprovalOperationAttemptsForTests } from "./approval-operation-attempts";
import { ApprovalBulkReject } from "./ApprovalBulkReject";
import { notifyGatewayAccessChanged, setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
const bulk = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ resolveApprovalsBulk: bulk }));
let root: Root, host: HTMLDivElement;
beforeEach(async () => { __resetApprovalOperationAttemptsForTests(); bulk.mockReset(); host = document.createElement('div'); document.body.append(host); root=createRoot(host); await act(async()=>root.render(<ApprovalBulkReject onResolved={vi.fn()}/>)); });
afterEach(async()=>{await act(async()=>root.unmount()); host.remove();});
function button(name:string){return [...document.querySelectorAll('button')].find(item=>!item.closest('[aria-hidden="true"]')&&item.textContent===name)!;}
async function click(name:string){await act(async()=>button(name).click());}
async function type(){const input=document.querySelector('[role="dialog"] input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'reject all');input.dispatchEvent(new Event('input',{bubbles:true}));});}
it('requires typed installation-wide review, cancels without effects and permits a fresh review after a canonical receipt',async()=>{
  await click('Review installation-wide rejection'); expect(button('Confirm installation-wide rejection').disabled).toBe(true);await type();await click('Cancel');expect(bulk).not.toHaveBeenCalled();
  bulk.mockResolvedValue({resolvedCount:2,skippedCount:0,failedCount:0});await click('Review installation-wide rejection');await type();await click('Confirm installation-wide rejection');expect(bulk).toHaveBeenCalledExactlyOnceWith({decision:'reject',status:'pending',resolutionNote:'Bulk rejected from the approvals queue.'});await click('Cancel');await click('Review installation-wide rejection');await type();await click('Confirm installation-wide rejection');expect(bulk).toHaveBeenCalledTimes(2);
});
it('retains an unconfirmed response lock and closes review on caller change',async()=>{
  bulk.mockRejectedValue(new Error('lost response'));await click('Review installation-wide rejection');await type();await click('Confirm installation-wide rejection');await click('Cancel');await click('Review installation-wide rejection');await type();expect(button('Confirm installation-wide rejection').disabled).toBe(true);expect(bulk).toHaveBeenCalledOnce();await act(async()=>notifyGatewayAccessChanged());expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('preserves a lost response through history collapse and remount',async()=>{
  bulk.mockRejectedValue(new Error('response lost'));
  await click('Review installation-wide rejection');await type();await click('Confirm installation-wide rejection');
  await act(async()=>root.render(null));
  await act(async()=>root.render(<ApprovalBulkReject onResolved={vi.fn()}/>));
  await click('Review installation-wide rejection');await type();
  expect(button('Confirm installation-wide rejection').disabled).toBe(true);expect(bulk).toHaveBeenCalledOnce();
});
it('keeps an interrupted caller operation locked after switching away and back',async()=>{
  await act(async()=>setGatewayCallerScope('caller-a'));
  let reject!: (error:Error)=>void;bulk.mockImplementation(()=>new Promise((_,fail)=>{reject=fail;}));
  await click('Review installation-wide rejection');await type();await click('Confirm installation-wide rejection');
  await act(async()=>setGatewayCallerScope('caller-b'));await act(async()=>reject(new Error('late response lost')));
  await act(async()=>setGatewayCallerScope('caller-a'));await click('Review installation-wide rejection');await type();
  expect(button('Confirm installation-wide rejection').disabled).toBe(true);expect(bulk).toHaveBeenCalledOnce();
  await act(async()=>setGatewayCallerScope(''));
});
