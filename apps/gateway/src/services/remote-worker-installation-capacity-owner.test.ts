import { describe, expect, it, vi } from "vitest";
import { encodeRemoteWorkerInstallCapacityChallenge } from "@goatcitadel/contracts";
import { RemoteWorkerInstallationCapacityOwner, type RemoteWorkerInstallationReservation } from "./remote-worker-installation-capacity-owner.js";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";

function fixture() {
  const digest = "11".repeat(32), stop = new AbortController();
  const binding = { connectionNonceHex: digest, installationNonce: "22".repeat(32), requestSha256: "33".repeat(32), captureSha256: "44".repeat(32), byteLength: 1312 };
  const capture = { responseHex: "00".repeat(1312), referencesJson: "[]", binding,
    window: { nonce: "55".repeat(32), connectionNonceHex: digest, poolSnapshotSha256: digest,
      hostCaptureSha256: digest, membersSha256: digest, referencesSha256: digest } };
  // Lifetime tests intentionally control the canonical validator. Full byte
  // reconstruction and real fences have a separate file-backed storage proof.
  const validated = { binding: { ...binding }, baselineSha256: "66".repeat(32) };
  const validate = vi.fn(async (_input: unknown) => validated);
  const window = { verify: vi.fn(async () => {}) }, policy = { verify: vi.fn(async () => {}) };
  const storage = { remoteWorkerRuntimeInstalls: { validatePoolCaptureForAssignment: validate } } as unknown as ConstructorParameters<typeof RemoteWorkerInstallationCapacityOwner>[0];
  const owner = new RemoteWorkerInstallationCapacityOwner(storage, policy);
  const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "77".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
    nonce: binding.installationNonce, requestSha256: binding.requestSha256, capture, window, signal: stop.signal, wallLimitMs: 10000
  } as unknown as Parameters<typeof owner.run>[0];
  return { owner, storage, input, binding, window, policy, validated, validate, stop,
    challenge: (ordinal = 1) => encodeRemoteWorkerInstallCapacityChallenge(binding, ordinal) };
}

describe("installation reservation lifetime", () => {
  it("checks before finish and retains the assignment until helper shutdown joins", async () => {
    const f = fixture();
    await expect(f.owner.run(f.input, async reservation => {
      await reservation.verify(f.challenge());
      return reservation.finish(async () => {
        expect(f.validate).toHaveBeenCalledTimes(3);
        f.window.verify.mockRejectedValue(new Error("native exclusion released after finish"));
        await expect(f.owner.run({ ...f.input, window: { verify: async () => {} } }, async () => "overlap")).rejects.toThrow(/active reservation/u);
        expect(reservation.signal.aborted).toBe(false);
        return "joined";
      });
    })).resolves.toBe("joined");
    expect(f.validate).toHaveBeenCalledTimes(3);
  });
  it.each(["window", "policy", "storage"])("refuses finish before joining when %s authority is lost", async mode => {
    const f = fixture(), join = vi.fn(async () => "joined");
    await expect(f.owner.run(f.input, async reservation => {
      await reservation.verify(f.challenge());
      if (mode === "window") f.window.verify.mockRejectedValue(new Error("lost window"));
      if (mode === "policy") f.policy.verify.mockRejectedValue(new Error("denied"));
      if (mode === "storage") f.validate.mockRejectedValue(new Error("lost lease"));
      return reservation.finish(join);
    })).rejects.toThrow();
    expect(join).not.toHaveBeenCalled();
  });
  it.each(["repeat", "challenge", "cancel", "join-failure"])("poisons %s during terminal shutdown even if swallowed", async mode => {
    const f = fixture();
    await expect(f.owner.run(f.input, async reservation => {
      await reservation.verify(f.challenge());
      await expect(reservation.finish(async () => {
        if (mode === "repeat") await expect(reservation.finish(async () => {})).rejects.toThrow();
        if (mode === "challenge") await expect(reservation.verify(f.challenge(2))).rejects.toThrow();
        if (mode === "cancel") f.stop.abort();
        if (mode === "join-failure") throw new Error("helper failed");
      })).rejects.toThrow();
    })).rejects.toThrow();
  });
  it("refuses finish without a native challenge", async () => {
    const f = fixture(), join = vi.fn(async () => {});
    await expect(f.owner.run(f.input, reservation => reservation.finish(join))).rejects.toThrow();
    expect(join).not.toHaveBeenCalled();
  });
  it("drains an unawaited helper join before releasing the assignment", async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const joining = new Promise<void>(resolve => { entered = resolve; });
    let settled = false;
    const run = f.owner.run(f.input, async reservation => {
      await reservation.verify(f.challenge());
      void reservation.finish(async () => { entered(); await blocked; }).catch(() => {});
      await joining;
    });
    void run.catch(() => { settled = true; });
    await joining; await Promise.resolve();
    expect(settled).toBe(false);
    await expect(f.owner.run({ ...f.input, window: { verify: async () => {} } }, async () => {})).rejects.toThrow(/active reservation/u);
    release(); await expect(run).rejects.toThrow();
  });
  it("retains exact binding, rechecks each challenge and closes leaked handles", async () => {
    const f = fixture(); let leaked: RemoteWorkerInstallationReservation | undefined;
    await expect(f.owner.run(f.input, async reservation => {
      leaked = reservation;
      await reservation.verify(f.challenge()); await reservation.verify(f.challenge(2)); return "done";
    })).resolves.toBe("done");
    expect(f.validate).toHaveBeenCalledTimes(4);
    expect(f.window.verify).toHaveBeenCalledTimes(8); expect(f.policy.verify).toHaveBeenCalledTimes(8);
    expect(leaked!.signal.aborted).toBe(true);
    await expect(leaked!.verify(f.challenge(3))).rejects.toThrow();
    await expect(f.owner.run(f.input, async () => "replay")).rejects.toThrow(/consumed/u);
  });
  it.each(["window", "policy", "storage", "baseline", "binding", "cancel"])("refuses changed authority during a check: %s", async mode => {
    const f = fixture();
    await expect(f.owner.run(f.input, async reservation => {
      if (mode === "window") f.window.verify.mockRejectedValue(new Error("revoked window"));
      if (mode === "policy") f.policy.verify.mockRejectedValue(new Error("denied policy"));
      if (mode === "storage") f.validate.mockRejectedValue(new Error("revoked lease"));
      if (mode === "baseline") f.validated.baselineSha256 = "88".repeat(32);
      if (mode === "binding") f.validated.binding.captureSha256 = "88".repeat(32);
      if (mode === "cancel") f.stop.abort();
      await reservation.verify(f.challenge());
    })).rejects.toThrow();
  });
  it.each(["ordinal", "replay", "foreign", "trailing"])("rejects invalid challenge without another canonical read: %s", async mode => {
    const f = fixture();
    await expect(f.owner.run(f.input, async reservation => {
      if (mode === "replay") await reservation.verify(f.challenge());
      let bytes = f.challenge(mode === "ordinal" ? 2 : 1);
      if (mode === "foreign") bytes[0] ^= 1;
      if (mode === "trailing") bytes = Uint8Array.from([...bytes, 0]);
      const count = f.validate.mock.calls.length;
      await expect(reservation.verify(bytes)).rejects.toThrow();
      expect(f.validate).toHaveBeenCalledTimes(count);
    })).rejects.toThrow();
  });
  it("freezes command and bytes before asynchronous checks", async () => {
    const f = fixture(), original = f.challenge();
    f.window.verify.mockImplementationOnce(async () => { f.binding.installationNonce = "88".repeat(32); });
    await f.owner.run(f.input, async reservation => { await reservation.verify(original); });
    expect(f.validate.mock.calls.every(([input]) => (input as { nonce: string }).nonce === "22".repeat(32))).toBe(true);
  });
  it("poisons overlapping checks and drains the pending read before release", async () => {
    const f = fixture(); let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    await expect(f.owner.run(f.input, async reservation => {
      f.validate.mockImplementation(async () => { await blocked; return f.validated; });
      const pending = reservation.verify(f.challenge());
      await expect(reservation.verify(f.challenge())).rejects.toThrow(/serialized/u);
      unblock(); await expect(pending).rejects.toThrow();
    })).rejects.toThrow();
  });
  it("does not accept an operation with no completed native challenge", async () => {
    const f = fixture(); await expect(f.owner.run(f.input, async () => "unused")).rejects.toThrow(/without completed/u);
  });
  it("refuses concurrent assignment lifetimes and releases after failure", async () => {
    const f = fixture();
    await expect(f.owner.run(f.input, async () => {
      await expect(f.owner.run({ ...f.input, window: { verify: async () => {} } }, async () => "overlap")).rejects.toThrow(/active reservation/u);
      throw new Error("operation failed");
    })).rejects.toThrow(/operation failed/u);
    await f.owner.run({ ...f.input, window: { verify: async () => {} } }, async reservation => { await reservation.verify(f.challenge()); });
  });
  it.each([0, 60001])( "refuses wall limit %i before external checks", async wallLimitMs => {
    const f = fixture(); await expect(f.owner.run({ ...f.input, wallLimitMs }, async () => "bad")).rejects.toThrow();
    expect(f.validate).not.toHaveBeenCalled(); expect(f.window.verify).not.toHaveBeenCalled();
  });
  it("expires its live signal without extending the bounded window", async () => {
    const f = fixture();
    await expect(f.owner.run({ ...f.input, wallLimitMs: 50 }, async reservation => {
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(reservation.signal.aborted).toBe(true);
      await reservation.verify(f.challenge());
    })).rejects.toThrow();
    expect(f.validate).toHaveBeenCalledTimes(1);
  });
  it("drains an unawaited check without reporting a successful operation", async () => {
    const f = fixture(); let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let finished = false;
    let returned!: () => void;
    const operationReturned = new Promise<void>(resolve => { returned = resolve; });
    const run = f.owner.run(f.input, async reservation => {
      f.validate.mockImplementation(async () => { await blocked; return f.validated; });
      const check = reservation.verify(f.challenge()); void check.catch(() => {});
      await vi.waitFor(() => expect(f.validate).toHaveBeenCalledTimes(2));
      returned();
      return "not finished";
    });
    void run.catch(() => { finished = true; });
    await operationReturned; await Promise.resolve();
    expect(finished).toBe(false); unblock();
    await expect(run).rejects.toThrow();
  });
  it.each([true, false])("composes the reservation owner with policy present=%s", async present => {
    const f = fixture();
    const llm = {};
    const dependencies = { storage: f.storage, approvals: {}, llm, completionHost: { llmService: llm }, artifactRoot: "unused-install-reservation",
      ...(present ? { nativeInstallationPolicy: f.policy } : {}) } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owner = createRemoteWorkerExecutionOwners(dependencies).nativeInstallationReservations;
    const operation = vi.fn(async (reservation: RemoteWorkerInstallationReservation) => { await reservation.verify(f.challenge()); return "done"; });
    if (present) await expect(owner.run(f.input, operation)).resolves.toBe("done");
    else {
      await expect(owner.run(f.input, operation)).rejects.toThrow(/policy owner/u);
      expect(operation).not.toHaveBeenCalled(); expect(f.validate).not.toHaveBeenCalled();
    }
  });
});
