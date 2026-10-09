// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { ApprovalCodeOutcome } from "./ApprovalCodeOutcome";
const read = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({ fetchCodeModeRun: read }));
const approval: ApprovalRequest = { kind:"code_mode.run",riskLevel:"danger",preview:{},createdAt:"2026-01-01",explanationStatus:"not_requested",approvalId:"approval",status:"approved",payload:{runId:"run",codeHash:"hash",wrapperManifestHash:"wrapper"},linkage:{workspaceId:"one"} };
const run = {runId:"run",approvalId:"approval",workspaceId:"one",codeHash:"hash",wrapperManifestHash:"wrapper",status:"failed",error:"Policy blocked execution"};
let root:Root,host:HTMLDivElement,client:QueryClient;
beforeEach(()=>{read.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);client=new QueryClient({defaultOptions:{queries:{retry:false}}});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();client.clear();});
async function render(){await act(async()=>root.render(<QueryClientProvider client={client}><ApprovalCodeOutcome approval={approval} workspaceId="one"/></QueryClientProvider>));}
it('keeps canonical failed code execution separate from approval success',async()=>{read.mockResolvedValue(run);await render();await vi.waitFor(()=>expect(host.textContent).toContain('Code work: failed'));expect(host.textContent).toContain('Policy blocked execution');expect(host.textContent).toContain('Approval does not by itself confirm completion');});
it('withholds a mismatched code artifact outcome',async()=>{read.mockResolvedValue({...run,codeHash:'changed',status:'completed'});await render();await vi.waitFor(()=>expect(host.textContent).toContain('does not match'));expect(host.textContent).not.toContain('Code work: completed');});
