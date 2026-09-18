import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { readRemoteWorkerCellProvisioningCheckpoint } from "../../../packages/contracts/src/remote-worker-cell-provisioning.js";
import { REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION } from "../../../packages/contracts/src/remote-worker-runtime-bundle.js";
import { REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, remoteWorkerRuntimeInstallRequestSha256 } from "../../../packages/contracts/src/remote-worker-runtime-install.js";
import { readRemoteWorkerRuntimeInstallOutcome } from "../../../packages/contracts/src/remote-worker-runtime-install-outcome.js";

const hash = (domain: string, bytes: Uint8Array) => createHash("sha256").update(`${domain}\0`).update(bytes).digest();
function seal(bytes: Buffer) {
  hash("goatcitadel.worker-runtime-install-local-intent.v1", bytes.subarray(0, 224)).copy(bytes, 224);
  bytes.copy(bytes, 288, 224, 256);
  hash("goatcitadel.worker-runtime-install-local-outcome.v1", bytes.subarray(0, 320)).copy(bytes, 320);
  return bytes;
}
function fixture() {
  const history = objectInventoryHistoryFixture(), first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const request = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "11".repeat(32),
    journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
    checkpointSha256: history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
      { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
      { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
    ] } };
  const bytes = Buffer.alloc(352); bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256);
  for (const [offset, value] of [[8, request.nonce], [40, remoteWorkerRuntimeInstallRequestSha256(request)],
    [72, request.checkpointSha256], [104, request.journalIdentityHex], [128, request.preparedSha256],
    [160, history.plan.assignmentBindingSha256], [192, history.plan.profileSha256]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeUInt32LE(1, 268); bytes.writeUInt32LE(2, 272); bytes.writeBigUInt64LE(120n, 280); seal(bytes);
  return { history, request, bytes, read: (value: Buffer = bytes, supplied = request, retained = history) =>
    readRemoteWorkerRuntimeInstallOutcome(value.toString("hex"), supplied, retained) };
}

import { exchangeWorkerRuntimeInstallation, selectWorkerRuntimeInstallation } from "./worker-runtime-install-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
const context = {} as RouteContext;
function delivery() {
 const f=fixture(), lease={registryWorkspaceId:f.history.registryWorkspaceId,assignmentId:f.history.assignmentId,
 assignmentGeneration:f.history.assignmentGeneration,leaseRevision:f.history.leaseRevision,leaseToken:"private-fixture-lease"};
 const outcomeHex=f.bytes.toString("hex"), result={schemaVersion:"goatcitadel.remote-worker-runtime-install-exchange.v1",
 registryWorkspaceId:lease.registryWorkspaceId,assignmentId:lease.assignmentId,assignmentGeneration:lease.assignmentGeneration,leaseRevision:lease.leaseRevision,
 nonce:f.request.nonce,requestSha256:remoteWorkerRuntimeInstallRequestSha256(f.request),
 record:{outcomeHex,outcomeSha256:outcomeHex.slice(-64),leaseRevision:lease.leaseRevision,recordedAt:"2026-09-16T00:00:00.000Z"}};
 const reply={status:200,body:{schemaVersion:"goatcitadel.remote-worker-assignment-execution-response.v1",operation:"assignment.settlement.submit",
 disposition:"runtime_install",registryWorkspaceId:lease.registryWorkspaceId,runtimeInstall:result}};
 return {...f,lease,outcomeHex,result,reply};
}
describe("protected installation delivery",()=>{
 beforeEach(()=>vi.clearAllMocks());
 it.each(["valid", "challenge", "scope", "lease", "request", "cancel"])("selects only fresh canonical installation input: %s", async mode => {
  const f = delivery(), stop = new AbortController();
  vi.mocked(callProtectedRoute).mockImplementation(async call => {
   if (mode === "cancel") stop.abort();
   return { status: 200, body: { ...f.reply.body, disposition: "runtime_install_selection",
    runtimeInstallSelection: { schemaVersion: "goatcitadel.remote-worker-runtime-install-selection.v1",
     challenge: mode === "challenge" ? "cd".repeat(32) : (call.payload.submission as { challenge: string }).challenge,
     history: { ...f.history, assignmentId: mode === "scope" ? "foreign" : f.history.assignmentId,
      leaseRevision: mode === "lease" ? 999 : f.history.leaseRevision },
     request: mode === "request" ? { ...f.request, checkpointSha256: "ff".repeat(32) } : f.request } } };
  });
  if (mode !== "valid") await expect(selectWorkerRuntimeInstallation(context, f.lease, stop.signal)).rejects.toThrow();
  else {
   expect((await selectWorkerRuntimeInstallation(context, f.lease)).request).toEqual(f.request);
   await selectWorkerRuntimeInstallation(context, f.lease);
   const calls = vi.mocked(callProtectedRoute).mock.calls;
   expect(calls[0]![0].idempotencyKey).not.toBe(calls[1]![0].idempotencyKey);
  }
 });
 it("delivers exact independently decoded evidence and recovers by lookup",async()=>{
  const f=delivery(); vi.mocked(callProtectedRoute).mockResolvedValue(f.reply);
  expect((await exchangeWorkerRuntimeInstallation(context,f.lease,f.request,f.history,f.outcomeHex)).record?.outcomeHex).toBe(f.outcomeHex);
  expect((await exchangeWorkerRuntimeInstallation(context,f.lease,f.request,f.history,null)).record?.outcomeHex).toBe(f.outcomeHex);
  const calls=vi.mocked(callProtectedRoute).mock.calls;
  expect(calls[1]![0].payload.submission).toMatchObject({kind:"runtime.install.lookup"});
  expect(calls[0]![0].idempotencyKey).not.toContain(f.lease.leaseToken);
 });
 it("rejects invalid seals, uncertain intents and foreign leases before transport",async()=>{
  const f=delivery();
  for(const value of [f.outcomeHex.slice(0,512), f.outcomeHex.slice(0,-2)+"ff"])
   await expect(exchangeWorkerRuntimeInstallation(context,f.lease,f.request,f.history,value)).rejects.toThrow();
  await expect(exchangeWorkerRuntimeInstallation(context,{...f.lease,assignmentId:"foreign"},f.request,f.history,null)).rejects.toThrow();
  expect(callProtectedRoute).not.toHaveBeenCalled();
 });
 it.each(["scope","lease","missing","seal","lost","cancel"])("stops without retry on %s",async mode=>{
  const f=delivery(), abort=new AbortController();
  vi.mocked(callProtectedRoute).mockImplementation(async()=>{
   if(mode==="lost") throw Error("lost receipt");
   if(mode==="cancel") abort.abort();
   const result: Record<string,unknown>={...f.result};
   if(mode==="scope")result.assignmentId="foreign";
   if(mode==="lease")result.leaseRevision=99;
   if(mode==="missing")result.record=null;
   if(mode==="seal")result.record={...f.result.record,outcomeHex:f.outcomeHex.slice(0,200)+"ff"+f.outcomeHex.slice(202)};
   return {...f.reply,body:{...f.reply.body,runtimeInstall:result}};
  });
  await expect(exchangeWorkerRuntimeInstallation(context,f.lease,f.request,f.history,f.outcomeHex,abort.signal)).rejects.toThrow();
  expect(callProtectedRoute).toHaveBeenCalledTimes(1);
 });
});
