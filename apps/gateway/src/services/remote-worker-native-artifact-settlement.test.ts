import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteWorkerArtifactManifestSha256, remoteWorkerNativeFileReceiptSha256, type RemoteWorkerArtifactManifest } from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerArtifactUploadRecord } from "@goatcitadel/storage";
import { nativeArtifactFixture } from "../../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import { RemoteWorkerNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement.js";
import { RemoteWorkerNativeArtifactStore } from "./remote-worker-native-artifact-store.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { createRemoteWorkerNativeFileReconciler } from "./remote-worker-native-file-reconciliation.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-native-settle-")) throw new Error("Unexpected owned test root");
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture(text = "native-result") {
  const f = nativeArtifactFixture(text), signal = new AbortController(), root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-native-settle-")); roots.push(root);
  const cas = new RemoteWorkerArtifactStore(root);
  await cas.installBlob({ executionWorkspaceId: "execution", blobSha256: f.receipt.files[0]!.contentSha256, bytes: f.bytes, signal: signal.signal });
  const retained = { receipt: f.receipt, receiptSha256: remoteWorkerNativeFileReceiptSha256(f.receipt), leaseRevision: 1, recordedAt: new Date().toISOString() };
  const controls = { revoked: false, fault: "", recoveries: [] as Uint8Array[] };
  const check = () => { signal.signal.throwIfAborted(); if (controls.revoked) throw new Error("revoked"); };
  const native = { authorizeReceipt: vi.fn(async () => { check(); return { retained,
    active: { assignment: { manifest: { deadlineAt: new Date(Date.parse(retained.recordedAt) + 900_000).toISOString() } } } }; }),
  recover: vi.fn(async () => {
    check(); const bytes = await cas.readBlob({ executionWorkspaceId: "execution", blobSha256: f.receipt.files[0]!.contentSha256, signal: signal.signal });
    controls.recoveries.push(bytes); return { retained, files: [{ selection: f.receipt.files[0]!.selection, bytes }] };
  }) };
  let state: { upload: RemoteWorkerArtifactUploadRecord | null; manifest: RemoteWorkerArtifactManifest | undefined; revision: number; parts: string[] } =
    { upload: null, manifest: undefined, revision: 0, parts: [] };
  const artifacts = {
    openUpload: vi.fn(async (input: Parameters<AsyncStorage["remoteWorkerArtifacts"]["openUpload"]>[0]) => {
      state.upload ??= { identity: f.identity, uploadId: "native-upload", uploadAttempt: 1, uploadState: "open", uploadRevision: 1,
        declaredFileCount: input.declaredFileCount, declaredTotalBytes: input.declaredTotalBytes, maxArtifactBytes: 1048576,
        stagingRootSha256: input.stagingRootSha256, committedManifestSha256: null, verificationGateState: null, verificationGateRevision: 0,
        cleanupState: "not_due", cleanupRevision: 0, expiresAt: input.expiresAt, createdAt: retained.recordedAt, updatedAt: retained.recordedAt };
      return structuredClone(state.upload);
    }),
    appendPart: vi.fn(async (input: Parameters<AsyncStorage["remoteWorkerArtifacts"]["appendPart"]>[0]) => {
      if (!state.parts.includes(input.idempotencyKey)) state.parts.push(input.idempotencyKey); return structuredClone(state.upload!);
    }),
    commitArtifact: vi.fn(async (input: Parameters<AsyncStorage["remoteWorkerArtifacts"]["commitArtifact"]>[0]) => {
      if (controls.fault === "commit") { controls.fault = ""; throw new Error("commit interrupted"); }
      state.manifest = input.manifest; state.upload!.committedManifestSha256 = remoteWorkerArtifactManifestSha256(input.manifest);
      state.upload!.uploadState = "committed"; state.upload!.verificationGateState = "pending"; return structuredClone(state.upload!);
    }),
    getUpload: vi.fn(async () => structuredClone(state.upload!)),
    openGatewayVerification: vi.fn(async () => { expect(state.revision).toBe(0); state.revision = 1; return { verificationId: "native-verification" }; }),
    advanceGatewayVerification: vi.fn(async (input: Parameters<AsyncStorage["remoteWorkerArtifacts"]["advanceGatewayVerification"]>[0]) => {
      expect(input.expectedAttemptRevision).toBe(state.revision); state.revision++;
      if (input.nextState === "running" && controls.fault === "tamper")
        await fs.writeFile(cas.resolvePath(cas.blobRelPath("execution", f.receipt.files[0]!.contentSha256)), "damaged during verification");
      if (input.nextState === "passed") {
        state.upload!.verificationGateState = "satisfied";
        if (controls.fault === "verify") { controls.fault = ""; throw new Error("verification interrupted"); }
        if (controls.fault === "revoke") controls.revoked = true;
      }
      return { verificationId: "native-verification", gateState: state.upload!.verificationGateState };
    }),
    getVerifiedManifest: vi.fn(async () => state.upload?.verificationGateState === "satisfied" ? state.manifest : undefined),
  };
  const storage = { remoteWorkerArtifacts: artifacts, runImmediateTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
    const before = structuredClone(state); try { return await work(); } catch (error) { state = before; throw error; }
  } };
  const makeOwner = () => new RemoteWorkerNativeArtifactSettlement(storage as unknown as ConstructorParameters<typeof RemoteWorkerNativeArtifactSettlement>[0],
    native as unknown as RemoteWorkerNativeArtifactStore, cas);
  const input = { registryWorkspaceId: "default", assignmentId: "native-artifact", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "99".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never,
    nonce: f.receipt.disclosure.nonce, requestSha256: f.receipt.disclosure.requestSha256, signal: signal.signal };
  return { ...f, controls, artifacts, native, cas, input, makeOwner, state: () => state };
}
describe("native artifact settlement", () => {
  it("reconciles an interrupted settlement through fresh owners and rejects later CAS corruption", async () => {
    const f = await fixture(), recordedAt = "2026-09-14T00:00:00.000Z";
    const lookup = { schemaVersion: "goatcitadel.remote-worker-runtime-result-exchange.v1", registryWorkspaceId: f.input.registryWorkspaceId,
      assignmentId: f.input.assignmentId, assignmentGeneration: 1, leaseRevision: 1, nonce: f.input.nonce, requestSha256: f.input.requestSha256,
      record: { resultSha256: f.receipt.resultSha256, byteLength: 1608, leaseRevision: 1, recordedAt }, accepted: null };
    const storage = { remoteWorkerRuntimeResults: { exchangePageForAssignment: async () => lookup },
      remoteWorkerNativeFileReceipts: { findForAssignment: async () => ({ receipt: f.receipt, receiptSha256: remoteWorkerNativeFileReceiptSha256(f.receipt), leaseRevision: 1, recordedAt }) } };
    const makeReconciler = () => createRemoteWorkerNativeFileReconciler(storage as unknown as AsyncStorage, f.makeOwner());
    const input = { ...f.input, submission: { kind: "runtime.files.reconcile" as const, nonce: f.input.nonce, requestSha256: f.input.requestSha256, challenge: "11".repeat(32) } };
    f.controls.fault = "verify"; await expect(makeReconciler().reconcile(input)).rejects.toThrow("interrupted");
    expect(f.state().upload?.verificationGateState).toBe("pending");
    const completed = await makeReconciler().reconcile(input); expect(completed.settlement?.receiptSha256).toBe(remoteWorkerNativeFileReceiptSha256(f.receipt));
    expect(await makeReconciler().reconcile(input)).toEqual(completed); expect(f.artifacts.commitArtifact).toHaveBeenCalledOnce();
    await fs.writeFile(f.cas.resolvePath(f.cas.blobRelPath("execution", f.receipt.files[0]!.contentSha256)), "damaged");
    await expect(makeReconciler().reconcile(input)).rejects.toThrow();
    for (const bytes of f.controls.recoveries) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it.each(["", "native-result"])("settles %j bytes and replays through a fresh owner without rerunning verification", async text => {
    const f = await fixture(text), first = await f.makeOwner().settle(f.input);
    expect(first.manifest.totalBytes).toBe(Buffer.byteLength(text)); expect(f.state().upload?.verificationGateState).toBe("satisfied");
    expect(await f.makeOwner().settle(f.input)).toEqual(first);
    expect(f.artifacts.commitArtifact).toHaveBeenCalledOnce(); expect(f.artifacts.openGatewayVerification).toHaveBeenCalledOnce();
    for (const bytes of f.controls.recoveries) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it.each(["commit", "verify"])("recovers from %s interruption without a false verification gate", async fault => {
    const f = await fixture(); f.controls.fault = fault;
    await expect(f.makeOwner().settle(f.input)).rejects.toThrow("interrupted");
    expect(f.state().upload?.verificationGateState).not.toBe("satisfied"); expect(f.state().revision).toBe(0);
    const settled = await f.makeOwner().settle(f.input); expect(settled.manifest.fileCount).toBe(1);
    expect(f.state().parts).toHaveLength(1); expect(f.state().upload?.verificationGateState).toBe("satisfied");
    for (const bytes of f.controls.recoveries) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it("uses bounded contiguous parts for a multi-part file", async () => {
    const f = await fixture("x".repeat(262145)); await f.makeOwner().settle(f.input);
    const parts = f.artifacts.appendPart.mock.calls.map(([input]) => input.part);
    expect(parts).toMatchObject([{ globalSequence: 1, filePartIndex: 0, partBytes: 262144, isFinalPart: false },
      { globalSequence: 2, filePartIndex: 1, partBytes: 1, isFinalPart: true }]);
    for (const bytes of f.controls.recoveries) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it("rehashes CAS during verification and rolls the gate back on corruption", async () => {
    const f = await fixture(); f.controls.fault = "tamper";
    await expect(f.makeOwner().settle(f.input)).rejects.toThrow();
    expect(f.state().upload?.verificationGateState).toBe("pending"); expect(f.state().revision).toBe(0);
    expect(f.artifacts.advanceGatewayVerification.mock.calls.some(([input]) => input.nextState === "passed")).toBe(false);
  });
  it("rolls verification back if authority is revoked during the final transaction", async () => {
    const f = await fixture(); f.controls.fault = "revoke";
    await expect(f.makeOwner().settle(f.input)).rejects.toThrow("revoked");
    expect(f.state().upload?.verificationGateState).toBe("pending"); expect(f.state().revision).toBe(0);
    for (const bytes of f.controls.recoveries) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it("refuses a different committed manifest", async () => {
    const f = await fixture(); await f.makeOwner().settle(f.input); f.state().upload!.committedManifestSha256 = "aa".repeat(32);
    await expect(f.makeOwner().settle(f.input)).rejects.toThrow("conflicts");
  });
  it("refuses missing or tampered CAS content even after the verifier previously passed", async () => {
    const f = await fixture(); await f.makeOwner().settle(f.input);
    await fs.writeFile(f.cas.resolvePath(f.cas.blobRelPath("execution", f.receipt.files[0]!.contentSha256)), "damage");
    await expect(f.makeOwner().settle(f.input)).rejects.toThrow(); expect(f.artifacts.openGatewayVerification).toHaveBeenCalledOnce();
  });
});
