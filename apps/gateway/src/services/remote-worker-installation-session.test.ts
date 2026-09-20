import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  encodeRemoteWorkerControllerAttestation,
  hashRemoteWorkerControllerPublicKey,
  encodeRemoteWorkerInstallCapacityChallenge,
  hashRemoteWorkerInstallCapacityCapture,
  remoteWorkerCellCanonicalSha256,
} from "@goatcitadel/contracts";
import { RemoteWorkerInstallationCapacityOwner } from "./remote-worker-installation-capacity-owner.js";
import {
  RemoteWorkerInstallationSessionOwner,
  type RemoteWorkerInstallationSession,
} from "./remote-worker-installation-session.js";

function fixture() {
  const stop = new AbortController(),
    nativeStop = new AbortController(),
    digest = "11".repeat(32);
  const responseHex = "00".repeat(1312);
  const binding = {
    connectionNonceHex: digest,
    installationNonce: "22".repeat(32),
    requestSha256: "33".repeat(32),
    captureSha256: hashRemoteWorkerInstallCapacityCapture(Buffer.from(responseHex, "hex")),
    byteLength: 1312,
  };
  const window = {
    nonce: "44".repeat(32),
    connectionNonceHex: digest,
    poolSnapshotSha256: digest,
    hostCaptureSha256: digest,
    membersSha256: digest,
    referencesSha256: remoteWorkerCellCanonicalSha256([]),
  };
  const endpoint = { connectionNonceHex: digest, signal: nativeStop.signal, verify: vi.fn(async () => {}) };
  // This proves scoped registration with the real lifetime owner. Canonical
  // full-pool byte reconstruction remains the separate storage fixture's job.
  const validate = vi.fn(async (input: { capture: { binding: typeof binding } }) => ({
    binding: input.capture.binding,
    baselineSha256: digest,
  }));
  const reservations = new RemoteWorkerInstallationCapacityOwner(
    { remoteWorkerRuntimeInstalls: { validatePoolCaptureForAssignment: validate } } as never,
    { verify: async () => {} },
  );
  const owner = new RemoteWorkerInstallationSessionOwner(reservations);
  const input = {
    registryWorkspaceId: "default",
    assignmentId: "assignment",
    assignmentGeneration: 1,
    leaseRevision: 1,
    leaseTokenSha256: "55".repeat(32),
    protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
    nonce: binding.installationNonce,
    requestSha256: binding.requestSha256,
    window,
    referencesJson: "[]",
    wallLimitMs: 10000,
    signal: stop.signal,
  } as unknown as Parameters<typeof owner.run>[0];
  const capture = (session: RemoteWorkerInstallationSession) =>
    session.runCapture(responseHex, binding, async (reservation) => {
      await reservation.verify(encodeRemoteWorkerInstallCapacityChallenge(binding, 1));
      return "terminal";
    });
  return { stop, nativeStop, responseHex, binding, window, endpoint, validate, reservations, owner, input, capture };
}
describe("registered native installation session", () => {
  function signedFixture() {
    const f = fixture(),
      pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const publicPointHex = `04${Buffer.from(jwk.x!, "base64url").toString("hex")}${Buffer.from(jwk.y!, "base64url").toString("hex")}`;
    const enrollment = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex) };
    const baseline = {
      request: { nonce: f.input.nonce },
      requestSha256: f.input.requestSha256,
      history: { plan: { assignmentBindingSha256: "aa".repeat(32) } },
      pool: { fixture: "canonical pool" },
    };
    f.window.poolSnapshotSha256 = remoteWorkerCellCanonicalSha256(baseline.pool);
    const readPin = vi.fn(async () => ({ ...enrollment }));
    const readBaseline = vi.fn(async () => structuredClone(baseline));
    const owner = new RemoteWorkerInstallationSessionOwner(f.reservations, {
      remoteWorkerRuntimeInstalls: {
        readControllerEnrollmentForAssignment: readPin,
        readPoolAdmissionMaterialForAssignment: readBaseline,
      },
    } as never);
    const challenge = vi.fn(async (nonce: string, ordinal: number) => {
      const bytes = Buffer.from(
        encodeRemoteWorkerControllerAttestation({
          keySha256: enrollment.keySha256,
          controllerInstanceHex: "ab".repeat(32),
          authoritySha256: baseline.history.plan.assignmentBindingSha256,
          challengeNonceHex: nonce,
          ordinal,
          installationNonce: f.input.nonce,
          requestSha256: f.input.requestSha256,
          window: f.window,
        }),
      );
      return {
        statementHex: bytes.toString("hex"),
        signatureHex: sign("sha256", bytes, { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("hex"),
      };
    });
    const transport = { signal: f.nativeStop.signal, challenge };
    return { ...f, owner, enrollment, baseline, readPin, readBaseline, transport, challenge };
  }
  it("resolves the approved controller pin and checks signed authority throughout reservation and finish", async () => {
    const f = signedFixture();
    await expect(
      f.owner.runSigned(f.input, f.transport, (session) =>
        session.runCapture(f.responseHex, f.binding, async (reservation) => {
          await reservation.verify(encodeRemoteWorkerInstallCapacityChallenge(f.binding, 1));
          return reservation.finish(async () => "joined");
        }),
      ),
    ).resolves.toBe("joined");
    expect(f.challenge.mock.calls.length).toBeGreaterThan(5);
    expect(f.readPin).toHaveBeenCalledTimes(1 + 2 * f.challenge.mock.calls.length);
    expect(f.readBaseline).toHaveBeenCalledTimes(f.readPin.mock.calls.length);
  });
  it.each(["missing-pin", "changed-pin", "changed-baseline", "pool", "signature", "revoked"])(
    "refuses signed admission on %s",
    async (mode) => {
      const f = signedFixture(),
        operation = vi.fn(f.capture);
      if (mode === "missing-pin") f.readPin.mockRejectedValue(new Error("not enrolled"));
      if (mode === "changed-pin")
        f.readPin
          .mockResolvedValueOnce({ ...f.enrollment })
          .mockResolvedValue({ ...f.enrollment, keySha256: "ff".repeat(32) });
      if (mode === "changed-baseline")
        f.readBaseline
          .mockResolvedValueOnce(structuredClone(f.baseline))
          .mockResolvedValue({ ...f.baseline, requestSha256: "ff".repeat(32) });
      if (mode === "pool") f.window.poolSnapshotSha256 = "ff".repeat(32);
      if (mode === "signature")
        f.challenge.mockImplementation(async () => ({ statementHex: "00".repeat(396), signatureHex: "00".repeat(64) }));
      if (mode === "revoked")
        f.readPin.mockResolvedValueOnce({ ...f.enrollment }).mockRejectedValue(new Error("revoked"));
      await expect(f.owner.runSigned(f.input, f.transport, operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(f.validate).not.toHaveBeenCalled();
    },
  );
  it("cancels an enrollment read that ignores abort without admitting an operation", async () => {
    const f = signedFixture(),
      operation = vi.fn(f.capture);
    f.readPin.mockImplementation(() => new Promise(() => {}));
    const running = f.owner.runSigned(f.input, f.transport, operation);
    f.stop.abort();
    await expect(running).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
  it("joins explicit terminal shutdown without rechecking a released native window", async () => {
    const f = fixture();
    await expect(
      f.owner.run(f.input, f.endpoint, (session) =>
        session.runCapture(f.responseHex, f.binding, async (reservation) => {
          await reservation.verify(encodeRemoteWorkerInstallCapacityChallenge(f.binding, 1));
          return reservation.finish(async () => {
            f.endpoint.verify.mockRejectedValue(new Error("native window released by verified finish"));
            await expect(f.owner.run(f.input, { ...f.endpoint }, f.capture)).rejects.toThrow();
            expect(session.signal.aborted).toBe(false);
            return "joined";
          });
        }),
      ),
    ).resolves.toBe("joined");
    expect(f.validate).toHaveBeenCalledTimes(3);
  });
  it.each(["caller", "endpoint", "rebind", "join-failure"])(
    "does not hide %s failure after terminal authorization",
    async (mode) => {
      const f = fixture();
      await expect(
        f.owner.run(f.input, f.endpoint, (session) =>
          session.runCapture(f.responseHex, f.binding, async (reservation) => {
            await reservation.verify(encodeRemoteWorkerInstallCapacityChallenge(f.binding, 1));
            return reservation.finish(async () => {
              if (mode === "caller") f.stop.abort();
              if (mode === "endpoint") f.nativeStop.abort();
              if (mode === "rebind") f.endpoint.connectionNonceHex = "99".repeat(32);
              if (mode === "join-failure") throw new Error("helper failed");
            });
          }),
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses a window from a different authenticated connection", async () => {
    const f = fixture();
    f.endpoint.connectionNonceHex = "99".repeat(32);
    await expect(f.owner.run(f.input, f.endpoint, f.capture)).rejects.toThrow();
    expect(f.endpoint.verify).not.toHaveBeenCalled();
  });
  it.each(["connection", "signal"])("refuses endpoint %s rebinding during registration", async (field) => {
    const f = fixture();
    f.endpoint.verify.mockImplementationOnce(async () => {
      if (field === "connection") f.endpoint.connectionNonceHex = "99".repeat(32);
      else f.endpoint.signal = new AbortController().signal;
    });
    await expect(f.owner.run(f.input, f.endpoint, f.capture)).rejects.toThrow();
    expect(f.validate).not.toHaveBeenCalled();
  });
  it("binds one response to independent window evidence and closes after terminal work", async () => {
    const f = fixture();
    let leaked!: RemoteWorkerInstallationSession;
    await expect(
      f.owner.run(f.input, f.endpoint, async (session) => {
        leaked = session;
        return f.capture(session);
      }),
    ).resolves.toBe("terminal");
    expect(leaked.signal.aborted).toBe(true);
    expect(f.validate).toHaveBeenCalledTimes(3);
    expect(f.endpoint.verify).toHaveBeenCalledWith(f.window, expect.any(AbortSignal));
    await expect(f.capture(leaked)).rejects.toThrow();
    await expect(f.owner.run(f.input, f.endpoint, f.capture)).rejects.toThrow();
  });
  it.each(["connectionNonceHex", "installationNonce", "requestSha256", "captureSha256", "byteLength"] as const)(
    "refuses altered %s before canonical validation",
    async (field) => {
      const f = fixture();
      const changed = { ...f.binding, [field]: field === "byteLength" ? 1313 : "99".repeat(32) };
      await expect(
        f.owner.run(f.input, f.endpoint, (session) => session.runCapture(f.responseHex, changed, async () => "bad")),
      ).rejects.toThrow();
      expect(f.validate).not.toHaveBeenCalled();
    },
  );
  it("checks independent reference hashes before touching the endpoint", async () => {
    const f = fixture();
    await expect(f.owner.run({ ...f.input, referencesJson: "[{}]" }, f.endpoint, f.capture)).rejects.toThrow();
    expect(f.endpoint.verify).not.toHaveBeenCalled();
  });
  it("freezes registered window and selection before endpoint awaits", async () => {
    const f = fixture();
    f.endpoint.verify.mockImplementationOnce(async () => {
      f.window.poolSnapshotSha256 = "99".repeat(32);
      (f.input as { nonce: string }).nonce = "99".repeat(32);
    });
    await f.owner.run(f.input, f.endpoint, f.capture);
    expect(f.validate.mock.calls[0]![0]).toMatchObject({
      nonce: f.binding.installationNonce,
      capture: { window: { poolSnapshotSha256: "11".repeat(32) } },
    });
  });
  it.each(["caller", "endpoint", "custody"])("refuses lost %s authority", async (failure) => {
    const f = fixture();
    await expect(
      f.owner.run(f.input, f.endpoint, async (session) => {
        if (failure === "caller") f.stop.abort();
        if (failure === "endpoint") f.nativeStop.abort();
        if (failure === "custody") f.endpoint.verify.mockRejectedValue(new Error("custody revoked"));
        return f.capture(session);
      }),
    ).rejects.toThrow();
    expect(f.validate).not.toHaveBeenCalled();
  });
  it("poisons a second capture and refuses a swallowed failure", async () => {
    const f = fixture();
    await expect(
      f.owner.run(f.input, f.endpoint, async (session) => {
        await f.capture(session);
        await expect(f.capture(session)).rejects.toThrow();
        return "swallowed";
      }),
    ).rejects.toThrow();
  });
  it("refuses a session with no completed capture", async () => {
    const f = fixture();
    await expect(f.owner.run(f.input, f.endpoint, async () => "unused")).rejects.toThrow();
  });
  it("retains the original deadline while registration is awaiting endpoint verification", async () => {
    const f = fixture();
    f.endpoint.verify.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 65));
    });
    const operation = vi.fn(f.capture);
    await expect(f.owner.run({ ...f.input, wallLimitMs: 40 }, f.endpoint, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
  });
  it("blocks concurrent registrations for the same assignment and releases on failure", async () => {
    const f = fixture();
    await expect(
      f.owner.run(f.input, f.endpoint, async () => {
        await expect(f.owner.run(f.input, { ...f.endpoint }, f.capture)).rejects.toThrow();
        throw new Error("failed");
      }),
    ).rejects.toThrow(/failed/u);
    await expect(f.owner.run(f.input, { ...f.endpoint }, f.capture)).resolves.toBe("terminal");
  });
  it("drains an unawaited capture before releasing registration", async () => {
    const f = fixture();
    let release!: () => void, returned!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      didReturn = new Promise<void>((resolve) => {
        returned = resolve;
      });
    f.validate.mockImplementation(async (input) => {
      await blocked;
      return { binding: input.capture.binding, baselineSha256: "11".repeat(32) };
    });
    let finished = false;
    const run = f.owner.run(f.input, f.endpoint, async (session) => {
      void f.capture(session).catch(() => {
        /* Preserve the intentionally detached capture; assert the owner rejection below. */
      });
      await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce());
      returned();
      return "incomplete";
    });
    void run.catch(() => {
      finished = true;
    });
    await didReturn;
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(f.owner.run(f.input, { ...f.endpoint }, f.capture)).rejects.toThrow();
    release();
    await expect(run).rejects.toThrow();
    await expect(f.owner.run(f.input, { ...f.endpoint }, f.capture)).resolves.toBe("terminal");
  });
});
