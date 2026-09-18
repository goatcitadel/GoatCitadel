import { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerRuntimeInstallRequestSha256,
  encodeRemoteWorkerRuntimeInstallRequest } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { readWorkerRuntimeCleanup } from "./worker-runtime-cleanup-client.js";
import { selectWorkerRuntimeInstallation } from "./worker-runtime-install-client.js";
import { encodeWindowsAssignmentCleanupAdmission, readWindowsAssignmentCleanupOnLease, sendWindowsAssignmentCleanup, type WindowsAssignmentCleanupBinding } from "./worker-windows-assignment-cleanup.js";
import type { WindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
vi.mock("./worker-runtime-cleanup-client.js", () => ({ readWorkerRuntimeCleanup: vi.fn() }));
vi.mock("./worker-runtime-install-client.js", () => ({ selectWorkerRuntimeInstallation: vi.fn() }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
describe("assignment cleanup delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(selectWorkerRuntimeInstallation).mockResolvedValue({ schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION,
      challenge: "dd".repeat(32), history: runtimeResultPagesFixture(2).history, request: null });
  });
  it.each(["matching", "different", "mutated", "cancelled"])("reads cleanup inside the caller's lease with %s measurement history", async mode => {
    const f = runtimeResultPagesFixture(2), stop = new AbortController();
    const lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
      assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private" };
    const originalLease = { ...lease }, expectedHistory = { ...structuredClone(f.history) };
    if (mode === "different") expectedHistory.leaseRevision++;
    const exchange = { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history: f.history, expectations: [f.expectation] };
    const assertCurrent = vi.fn(async () => { stop.signal.throwIfAborted(); });
    vi.mocked(readWorkerRuntimeCleanup).mockImplementation(async (_context, binding) => {
      expect(Object.isFrozen(binding)).toBe(true); expect(binding).toEqual(originalLease);
      // Changes to caller-owned objects after admission cannot retarget the
      // installation lookup or change which history this measurement retained.
      lease.leaseRevision++;
      if (mode === "mutated") expectedHistory.leaseRevision++;
      if (mode === "cancelled") stop.abort();
      return exchange;
    });
    vi.mocked(selectWorkerRuntimeInstallation).mockImplementation(async (_context, binding) => {
      expect(binding).toEqual(originalLease);
      return { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION,
        challenge: "dd".repeat(32), history: f.history, request: null };
    });
    const pending = readWindowsAssignmentCleanupOnLease({ context: {} as WindowsWorkerAssignmentAuthority["context"],
      lease, signal: stop.signal, assertCurrent, expectedHistory });
    if (["matching", "mutated"].includes(mode)) {
      await expect(pending).resolves.toEqual({ exchange, installations: [] });
      expect(assertCurrent).toHaveBeenCalledTimes(3);
      expect(selectWorkerRuntimeInstallation).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toThrow();
      expect(selectWorkerRuntimeInstallation).not.toHaveBeenCalled();
    }
  });
  it.each(["current", "installed", "lookup", "installation", "history", "request", "binding", "revoked", "cancel"])("holds the lease through %s delivery", async mode => {
    const f = runtimeResultPagesFixture(2), stop = new AbortController(), events: string[] = [], frames: Buffer[] = [];
    let held = false, bound = false;
    const channel = new Duplex({ read() {}, write(bytes: Buffer, _encoding, done) {
      expect(held && bound).toBe(true); frames.push(Buffer.from(bytes)); events.push("write");
      if (frames.length === 3) {
        const ack = Buffer.alloc(80); frames[0]!.copy(ack, 0, 0, 76); ack.write("GCCLA001"); this.push(ack);
      }
      done();
    } });
    const lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
      assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private" };
    const check = vi.fn(async () => { expect(held).toBe(true); stop.signal.throwIfAborted(); if (mode === "revoked" && bound) throw new Error("revoked"); });
    const authority = { context: {}, signal: stop.signal,
      withStableLease: async (work: (value: typeof lease, check: () => Promise<void>) => Promise<unknown>) => {
        held = true; try { return await work(lease, check); } finally { held = false; }
      }, assertCurrent: vi.fn(async () => {}) } as unknown as WindowsWorkerAssignmentAuthority;
    vi.mocked(readWorkerRuntimeCleanup).mockImplementation(async (_context, actual) => {
      expect(held).toBe(true); expect(actual).toEqual(lease); events.push("lookup");
      if (mode === "lookup") throw new Error("lookup refused");
      return { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history: f.history, expectations: [f.expectation] };
    });
    const first = readRemoteWorkerCellProvisioningCheckpoint(f.history.records[0]!);
    const request = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "11".repeat(32),
      journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
      checkpointSha256: f.history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256: "55".repeat(32),
      runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
        { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
        { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
      ] } };
    vi.mocked(selectWorkerRuntimeInstallation).mockImplementation(async (_context, actual, signal) => {
      expect(held).toBe(true); expect(actual).toEqual(lease); expect(signal?.aborted).toBe(false); events.push("installation");
      if (mode === "installation") throw new Error("selection refused");
      return { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION, challenge: "dd".repeat(32),
        history: mode === "history" ? { ...f.history, leaseRevision: f.history.leaseRevision + 1 } : f.history,
        request: mode === "installed" ? request : mode === "request" ? { ...request, checkpointSha256: "99".repeat(32) } : null };
    });
    const peer = { timeoutMs: 1000, authorizePeer: vi.fn(async () => { expect(held).toBe(true); }),
      bindReceiver: vi.fn(async (binding: WindowsAssignmentCleanupBinding & { admissionHex: string }) => {
        expect(Object.isFrozen(binding)).toBe(true); expect(frames).toHaveLength(0); events.push("bind"); bound = true;
        expect(Object.isFrozen(binding.installations)).toBe(true);
        expect(binding.installations).toEqual(mode === "installed" ? [{ nonce: request.nonce,
          requestSha256: remoteWorkerRuntimeInstallRequestSha256(request),
          requestHex: Buffer.from(encodeRemoteWorkerRuntimeInstallRequest(request)).toString("hex") }] : []);
        if (mode === "installed") expect(Object.isFrozen(binding.installations[0])).toBe(true);
        const admission = Buffer.from(binding.admissionHex, "hex");
        expect(admission.length).toBe(mode === "installed" ? 416 : 80);
        expect(admission.subarray(0, 8).toString("ascii")).toBe("GCCADM01");
        expect(admission.subarray(8, 40).toString("hex")).toBe(binding.challenge);
        expect(admission.subarray(40, 72).toString("hex")).toBe(binding.setSha256);
        expect(admission.readUInt32LE(72)).toBe(binding.installations.length);
        expect(admission.readUInt32LE(76)).toBe(0);
        if (mode === "binding") throw new Error("binding refused"); if (mode === "cancel") stop.abort();
      }) };
    try {
      const pending = sendWindowsAssignmentCleanup(channel, authority, peer);
      if (["current", "installed"].includes(mode)) {
        await expect(pending).resolves.toMatchObject({ byteLength: 360 });
        expect(events.slice(0, 4)).toEqual(["lookup", "installation", "bind", "write"]);
      } else { await expect(pending).rejects.toThrow(); expect(frames).toHaveLength(0); }
      expect(held).toBe(false); expect(authority.assertCurrent).not.toHaveBeenCalled();
      expect(peer.bindReceiver).toHaveBeenCalledTimes(["lookup", "installation", "history", "request"].includes(mode) ? 0 : 1);
    } finally { channel.destroy(); }
  });

  it.each(["lookup", "installation", "peer", "binding", "transfer"])("cancels a late %s callback but holds the lease until it joins", async stage => {
    const f = runtimeResultPagesFixture(2), entered = deferred(), cancelled = deferred(), finish = deferred();
    const stop = new AbortController(); let held = false, settled = false, peerCalls = 0;
    const write = vi.fn((_bytes, _encoding, done: () => void) => done());
    const channel = new Duplex({ read() {}, write });
    const slow = async (signal: AbortSignal) => {
      entered.resolve();
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      cancelled.resolve(); await finish.promise;
    };
    const authority = { context: {}, signal: stop.signal,
      withStableLease: async (work: (lease: object, check: () => Promise<void>) => Promise<unknown>) => {
        held = true; try { return await work({}, async () => {}); } finally { held = false; }
      } } as unknown as WindowsWorkerAssignmentAuthority;
    vi.mocked(readWorkerRuntimeCleanup).mockImplementation(async (_context, _lease, signal) => {
      if (stage === "lookup") await slow(signal!);
      return { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history: f.history, expectations: [f.expectation] };
    });
    vi.mocked(selectWorkerRuntimeInstallation).mockImplementation(async (_context, _lease, signal) => {
      if (stage === "installation") await slow(signal!);
      return { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION,
        challenge: "dd".repeat(32), history: f.history, request: null };
    });
    const pending = sendWindowsAssignmentCleanup(channel, authority, { timeoutMs: 50,
      authorizePeer: async signal => { if (++peerCalls === (stage === "transfer" ? 2 : 1) && ["peer", "transfer"].includes(stage)) await slow(signal); },
      bindReceiver: async (_binding, signal) => { if (stage === "binding") await slow(signal); },
    }).finally(() => { settled = true; });
    const rejected = expect(pending).rejects.toThrow();
    try {
      await entered.promise; await cancelled.promise;
      expect(held).toBe(true); expect(settled).toBe(false); expect(write).not.toHaveBeenCalled();
    } finally { finish.resolve(); await rejected; channel.destroy(); }
    expect(held).toBe(false); expect(settled).toBe(true); expect(write).not.toHaveBeenCalled();
  });

  it("refuses an expired binding even when the timer has not run", async () => {
    const f = runtimeResultPagesFixture(2); let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const write = vi.fn((_bytes, _encoding, done: () => void) => done());
    const channel = new Duplex({ read() {}, write });
    const authority = { context: {}, signal: new AbortController().signal,
      withStableLease: async (work: (lease: object, check: () => Promise<void>) => Promise<unknown>) => work({}, async () => {}),
    } as unknown as WindowsWorkerAssignmentAuthority;
    vi.mocked(readWorkerRuntimeCleanup).mockResolvedValue({ schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA,
      challenge: "cc".repeat(32), history: f.history, expectations: [f.expectation] });
    let bindingSignal: AbortSignal | undefined;
    try {
      await expect(sendWindowsAssignmentCleanup(channel, authority, { timeoutMs: 1000, authorizePeer: async () => {},
        bindReceiver: async (_binding, signal) => { bindingSignal = signal; now = 1000; },
      })).rejects.toThrow("deadline expired");
      expect(bindingSignal?.aborted).toBe(true); expect(write).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); channel.destroy(); }
  });

  it.each([0, 60001, NaN, 1.5])("rejects invalid total lifetime %s before lease admission", async timeoutMs => {
    const withStableLease = vi.fn(), channel = new Duplex({ read() {}, write(_bytes, _encoding, done) { done(); } });
    const authority = { withStableLease } as unknown as WindowsWorkerAssignmentAuthority;
    try {
      await expect(sendWindowsAssignmentCleanup(channel, authority, { timeoutMs, authorizePeer: async () => {}, bindReceiver: async () => {} }))
        .rejects.toThrow("lifetime is invalid");
      expect(withStableLease).not.toHaveBeenCalled(); expect(readWorkerRuntimeCleanup).not.toHaveBeenCalled();
    } finally { channel.destroy(); }
  });
  it("bounds admission metadata and refuses unbound installation bytes", () => {
    const valid: WindowsAssignmentCleanupBinding = { challenge: "11".repeat(32), setSha256: "22".repeat(32), installations: [] };
    for (const change of [{ challenge: "00".repeat(32) }, { setSha256: "bad" }, { installations: new Array(1) },
      { installations: new Array(2) }, { installations: [{ nonce: "33".repeat(32), requestSha256: "44".repeat(32), requestHex: "00".repeat(272) }] }])
      expect(() => encodeWindowsAssignmentCleanupAdmission({ ...valid, ...change })).toThrow();
  });
});
