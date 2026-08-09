import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP,
  WINDOWS_HELPER_ERROR_CODE,
  WINDOWS_HELPER_ERROR_OPCODE,
  WINDOWS_HELPER_OPCODE,
  WINDOWS_HELPER_ORDINARY_MAX_BYTES,
  WINDOWS_HELPER_PE_MACHINE,
  WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP,
  WINDOWS_HELPER_SECRET_MAX_BYTES,
  WINDOWS_HELPER_STDERR_MAX_BYTES,
  WINDOWS_HELPER_STDOUT_MAX_BYTES,
  WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP,
  WindowsHelperProcessError,
  WindowsHelperProtocolError,
  decodeWindowsHelperRequest,
  buildWindowsProtectedAdmissionEvidenceSigningBytes,
  encodeWindowsHelperFrame,
  encodeWindowsHelperInspectRequest,
  encodeWindowsHelperRequest,
  encodeWindowsProtectedCreateKeysetRequest,
  encodeWindowsProtectedRevokeKeysetRequest,
  encodeWindowsProtectedSignAdmissionEvidenceRequest,
} from "./windows-helper-protocol.js";
import {
  WINDOWS_SERVICE_CLIENT_ARGUMENT,
  WINDOWS_SERVICE_CLIENT_EXIT_CODE,
  WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS,
  WINDOWS_SERVICE_CLIENT_TERMINATION_GRACE_MS,
  WindowsServiceClientExitError,
  createWindowsProtectedKeyset,
  inspectWindowsProtectedService,
  revokeWindowsProtectedKeyset,
  runWindowsServiceClient,
  runWindowsServiceClientOneShot,
  signWindowsProtectedAdmissionEvidence,
} from "./windows-service-client.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinChunks: Buffer[];
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  emitSpawn: () => void;
  emitError: (error: Error) => void;
  emitClose: (exitCode: number | null, signal?: NodeJS.Signals | null) => void;
}

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinChunks: Buffer[] = [];
  const kill = vi.fn(() => true);
  const unref = vi.fn();
  stdin.on("data", (chunk: Buffer | string) => {
    stdinChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
  });

  const child = {
    stdin,
    stdout,
    stderr,
    kill,
    unref,
    once: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.once(event, listener);
      return child;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return child;
    },
  } as unknown as ChildProcessWithoutNullStreams;

  return {
    child,
    stdin,
    stdout,
    stderr,
    stdinChunks,
    kill,
    unref,
    emitSpawn: () => emitter.emit("spawn"),
    emitError: (error) => emitter.emit("error", error),
    emitClose: (exitCode, signal = null) => emitter.emit("close", exitCode, signal),
  };
}

function inspectPayload(): Buffer {
  const payload = Buffer.alloc(320);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(WINDOWS_HELPER_PE_MACHINE.X64, 2);
  payload.writeUInt32LE(WINDOWS_HELPER_ORDINARY_MAX_BYTES, 4);
  payload.writeUInt32LE(WINDOWS_HELPER_SECRET_MAX_BYTES, 8);
  payload.writeUInt32LE(0, 12);
  payload.writeBigUInt64LE(WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP, 16);
  payload.writeBigUInt64LE(WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP, 24);
  payload.writeUInt16LE(1, 32);
  payload.writeUInt16LE(0, 34);
  payload.writeBigUInt64LE(WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP, 40);
  payload.fill(0x5a, 48, 80);
  payload.writeUInt32LE(256, 116);
  payload.writeUInt32LE(16, 120);
  return payload;
}

function errorResponse(code: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(code, 0);
  return encodeWindowsHelperFrame(WINDOWS_HELPER_ERROR_OPCODE, payload);
}

const mutationOperationId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const mutationExpectedState = Buffer.alloc(32, 0x5a);
const mutationReceipt = Buffer.alloc(32, 0x44);
const mutationCreateRequest = {
  operationId: mutationOperationId,
  expectedStateSha256: mutationExpectedState,
  requestedGeneration: 7n,
  predecessorGeneration: 6n,
};
const mutationRevokeRequest = {
  operationId: mutationOperationId,
  expectedStateSha256: mutationExpectedState,
  generation: 7n,
  reason: "suspected_compromise" as const,
  expectedKeysetReceiptSha256: mutationReceipt,
};
const mutationSignRequest = {
  operationId: mutationOperationId,
  expectedStateSha256: mutationExpectedState,
  expectedGeneration: 7n,
  expectedKeysetReceiptSha256: mutationReceipt,
  envelope: {
    operationId: mutationOperationId,
    evidenceNonceSha256: Buffer.alloc(32, 0x10),
    workerGeneration: 7n,
    contextSha256: Buffer.alloc(32, 0x20),
    runtimeManifestSha256: Buffer.alloc(32, 0x30),
    workerPublicKeySpkiSha256: Buffer.alloc(32, 0x40),
    downloadVerificationReceiptSha256: Buffer.alloc(32, 0x50),
    installedTreeAttestationSha256: Buffer.alloc(32, 0x60),
    installedTreeVerificationReceiptSha256: Buffer.alloc(32, 0x70),
  },
};
const mutationSignPrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const mutationSignSpki = createPublicKey(mutationSignPrivateKey).export({ format: "der", type: "spki" });

function createSuccessPayload(): Buffer {
  const payload = Buffer.alloc(320);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(1, 2);
  mutationOperationId.copy(payload, 8);
  payload.writeBigUInt64LE(7n, 24);
  payload.writeBigUInt64LE(6n, 32);
  mutationExpectedState.copy(payload, 40);
  payload.fill(0x61, 72, 136);
  payload.fill(0x71, 136, 232);
  Buffer.from("302a300506032b6570032100", "hex").copy(payload, 232);
  payload.fill(0x81, 244, 276);
  Buffer.from("302a300506032b6570032100", "hex").copy(payload, 276);
  payload.fill(0x91, 288, 320);
  return payload;
}

function revokeSuccessPayload(): Buffer {
  const payload = Buffer.alloc(200);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(1, 2);
  mutationOperationId.copy(payload, 8);
  payload.writeBigUInt64LE(7n, 24);
  payload.writeUInt32LE(2, 32);
  mutationExpectedState.copy(payload, 40);
  payload.fill(0x62, 72, 136);
  payload.fill(0x72, 136, 200);
  return payload;
}

function signSuccessPayload(): Buffer {
  const frame = encodeWindowsProtectedSignAdmissionEvidenceRequest(mutationSignRequest);
  const body = frame.subarray(16);
  const envelope = body.subarray(96);
  const payload = Buffer.alloc(320);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(1, 2);
  mutationOperationId.copy(payload, 8);
  payload.writeBigUInt64LE(7n, 24);
  createHash("sha256").update(envelope).digest().copy(payload, 32);
  mutationReceipt.copy(payload, 64);
  createHash("sha256").update(mutationSignSpki).digest().copy(payload, 96);
  mutationSignSpki.copy(payload, 128);
  sign(null, buildWindowsProtectedAdmissionEvidenceSigningBytes(envelope), mutationSignPrivateKey).copy(payload, 172);
  mutationExpectedState.copy(payload, 236);
  createHash("sha256").update(body).digest().copy(payload, 268);
  return payload;
}

function startOneShot(
  requestFrame: Uint8Array = encodeWindowsHelperInspectRequest(),
  options: { timeoutMs?: number } = {},
): { fake: FakeChild; result: ReturnType<typeof runWindowsServiceClientOneShot> } {
  const fake = createFakeChild();
  spawnMock.mockReturnValueOnce(fake.child);
  const result = runWindowsServiceClientOneShot(process.execPath, requestFrame, options);
  fake.emitSpawn();
  return { fake, result };
}

function startValidated(requestFrame: Uint8Array = encodeWindowsHelperInspectRequest()): {
  fake: FakeChild;
  result: ReturnType<typeof runWindowsServiceClient>;
} {
  const fake = createFakeChild();
  spawnMock.mockReturnValueOnce(fake.child);
  const result = runWindowsServiceClient(process.execPath, requestFrame);
  fake.emitSpawn();
  return { fake, result };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("protected Windows service-client runner", () => {
  it("uses the sole exact service argument, empty environment, no shell, and exact stdin bytes", async () => {
    const request = encodeWindowsHelperInspectRequest();
    const { fake, result } = startOneShot(request);

    expect(spawnMock).toHaveBeenCalledWith(process.execPath, ["--service-stdio"], {
      cwd: undefined,
      env: {},
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(WINDOWS_SERVICE_CLIENT_ARGUMENT).toBe("--service-stdio");
    expect(Buffer.concat(fake.stdinChunks)).toEqual(request);

    fake.stdout.write(Buffer.from([0x01, 0x02]));
    fake.emitClose(0);
    await expect(result).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from([0x01, 0x02]),
      stderr: Buffer.alloc(0),
    });
  });

  it("freezes the 50-second parent deadline, 2-second close watchdog, and exit matrix", () => {
    expect(WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS).toBe(50_000);
    expect(WINDOWS_SERVICE_CLIENT_TERMINATION_GRACE_MS).toBe(2_000);
    expect(WINDOWS_SERVICE_CLIENT_EXIT_CODE).toEqual({
      SUCCESS: 0,
      USAGE_INVALID: 2,
      PROTOCOL_INVALID: 3,
      OPERATION_UNAVAILABLE: 4,
      IO_FAILED: 5,
    });
  });

  it("requires an absolute NUL-free path, byte request, ordinary bound, and capped integer timeout", async () => {
    const request = encodeWindowsHelperInspectRequest();
    await expect(runWindowsServiceClientOneShot("relative.exe", request)).rejects.toMatchObject({
      reason: "spawn_failed",
    });
    await expect(runWindowsServiceClientOneShot(`${process.execPath}\0suffix`, request)).rejects.toMatchObject({
      reason: "spawn_failed",
    });
    await expect(runWindowsServiceClientOneShot(process.execPath, "not bytes" as never)).rejects.toBeInstanceOf(
      WindowsHelperProtocolError,
    );
    await expect(
      runWindowsServiceClientOneShot(process.execPath, Buffer.alloc(WINDOWS_HELPER_STDOUT_MAX_BYTES + 1)),
    ).rejects.toThrow(/ordinary GCPW frame limit/);

    for (const timeoutMs of [0, 1.5, WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS + 1]) {
      await expect(runWindowsServiceClientOneShot(process.execPath, request, { timeoutMs })).rejects.toMatchObject({
        reason: "timed_out",
      });
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("maps synchronous and pre-spawn failures to spawn_failed", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("CreateProcess failed");
    });
    await expect(runWindowsServiceClientOneShot(process.execPath, encodeWindowsHelperInspectRequest())).rejects.toEqual(
      expect.objectContaining({ reason: "spawn_failed" }),
    );

    const fake = createFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const result = runWindowsServiceClientOneShot(process.execPath, encodeWindowsHelperInspectRequest());
    fake.emitError(new Error("ENOENT"));
    await expect(result).rejects.toEqual(expect.objectContaining({ reason: "spawn_failed" }));
  });

  it("waits for close and maps post-spawn process and stdin failures", async () => {
    const processFailure = startOneShot();
    processFailure.fake.emitError(new Error("child process failed"));
    expect(processFailure.fake.kill).toHaveBeenCalledWith("SIGKILL");
    processFailure.fake.emitClose(null, "SIGKILL");
    await expect(processFailure.result).rejects.toEqual(expect.objectContaining({ reason: "process_error" }));

    const stdinFailure = startOneShot();
    stdinFailure.fake.stdin.emit("error", new Error("EPIPE"));
    stdinFailure.fake.emitClose(5);
    await expect(stdinFailure.result).rejects.toEqual(expect.objectContaining({ reason: "stdin_failed" }));
  });

  it("maps stdout and stderr stream failures without an unhandled error", async () => {
    for (const streamName of ["stdout", "stderr"] as const) {
      const streamFailure = startOneShot();
      expect(() => streamFailure.fake[streamName].emit("error", new Error(`${streamName} failed`))).not.toThrow();
      expect(streamFailure.fake.kill).toHaveBeenCalledWith("SIGKILL");
      streamFailure.fake.emitClose(null, "SIGKILL");
      await expect(streamFailure.result).rejects.toEqual(expect.objectContaining({ reason: "process_error" }));
    }
  });

  it("kills and rejects stdout and stderr overflow without retaining the over-cap chunk", async () => {
    const stdoutOverflow = startOneShot();
    stdoutOverflow.fake.stdout.write(Buffer.alloc(WINDOWS_HELPER_STDOUT_MAX_BYTES + 1));
    expect(stdoutOverflow.fake.kill).toHaveBeenCalledWith("SIGKILL");
    stdoutOverflow.fake.emitClose(null, "SIGKILL");
    await expect(stdoutOverflow.result).rejects.toEqual(expect.objectContaining({ reason: "stdout_limit" }));

    const stderrOverflow = startOneShot();
    stderrOverflow.fake.stderr.write(Buffer.alloc(WINDOWS_HELPER_STDERR_MAX_BYTES + 1));
    expect(stderrOverflow.fake.kill).toHaveBeenCalledWith("SIGKILL");
    stderrOverflow.fake.emitClose(null, "SIGKILL");
    await expect(stderrOverflow.result).rejects.toEqual(expect.objectContaining({ reason: "stderr_limit" }));
  });

  it("accepts exact stdout/stderr bounds", async () => {
    const { fake, result } = startOneShot();
    fake.stdout.write(Buffer.alloc(WINDOWS_HELPER_STDOUT_MAX_BYTES, 0xa5));
    fake.stderr.write(Buffer.alloc(WINDOWS_HELPER_STDERR_MAX_BYTES, 0x5a));
    fake.emitClose(5);

    await expect(result).resolves.toMatchObject({
      exitCode: 5,
      signal: null,
      stdout: expect.objectContaining({ byteLength: WINDOWS_HELPER_STDOUT_MAX_BYTES }),
      stderr: expect.objectContaining({ byteLength: WINDOWS_HELPER_STDERR_MAX_BYTES }),
    });
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("enforces the deadline and preserves the original timeout reason when forced close succeeds", async () => {
    vi.useFakeTimers();
    const { fake, result } = startOneShot(encodeWindowsHelperInspectRequest(), { timeoutMs: 10 });
    const outcome = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
    fake.emitClose(null, "SIGKILL");

    await expect(outcome).resolves.toEqual(expect.objectContaining({ reason: "timed_out" }));
  });

  it("rejects termination_failed and detaches only after the checked two-second watchdog", async () => {
    vi.useFakeTimers();
    const { fake, result } = startOneShot(encodeWindowsHelperInspectRequest(), { timeoutMs: 1 });
    const outcome = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
    expect(fake.unref).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WINDOWS_SERVICE_CLIENT_TERMINATION_GRACE_MS - 1);
    expect(fake.unref).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toEqual(expect.objectContaining({ reason: "termination_failed" }));
    expect(fake.unref).toHaveBeenCalledTimes(1);
    expect(fake.stdin.destroyed).toBe(true);
    expect(fake.stdout.destroyed).toBe(true);
    expect(fake.stderr.destroyed).toBe(true);
  });
});

describe("protected Windows service-client GCPW disposition", () => {
  it("accepts exact INSPECT success bytes only with exit zero and no stderr", async () => {
    const { fake, result } = startValidated();
    const payload = inspectPayload();
    fake.stdout.write(encodeWindowsHelperFrame(WINDOWS_HELPER_OPCODE.INSPECT | 0x80, payload));
    fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);

    await expect(result).resolves.toEqual({
      kind: "success",
      requestOpcode: WINDOWS_HELPER_OPCODE.INSPECT,
      payload,
    });
  });

  it("accepts the exact bound error-code/exit parity", async () => {
    const cases = [
      [WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE, WINDOWS_SERVICE_CLIENT_EXIT_CODE.OPERATION_UNAVAILABLE],
      [WINDOWS_HELPER_ERROR_CODE.IO_FAILED, WINDOWS_SERVICE_CLIENT_EXIT_CODE.IO_FAILED],
    ] as const;

    for (const [code, exitCode] of cases) {
      const request =
        code === WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE
          ? encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.ACQUIRE_KEY_FOR_SIGNING, Buffer.from([0x00, 0x7f, 0xff]))
          : encodeWindowsHelperInspectRequest();
      const { fake, result } = startValidated(request);
      fake.stdout.write(errorResponse(code));
      fake.emitClose(exitCode);
      await expect(result).resolves.toEqual({ kind: "error", code });
    }
  });

  it("requires malformed local GCPW to return exact code 1 with exit 3", async () => {
    const malformed = encodeWindowsHelperInspectRequest();
    malformed[7] = 1;
    const accepted = startValidated(malformed);
    accepted.fake.stdout.write(errorResponse(WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID));
    accepted.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.PROTOCOL_INVALID);
    await expect(accepted.result).resolves.toEqual({
      kind: "error",
      code: WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID,
    });

    const rejected = startValidated(malformed);
    rejected.fake.stdout.write(errorResponse(WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE));
    rejected.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.OPERATION_UNAVAILABLE);
    await expect(rejected.result).rejects.toThrow(/invalid local GCPW input/);
  });

  it("rejects response/exit mismatches, success for a mutation, and unavailable INSPECT", async () => {
    const mismatch = startValidated();
    mismatch.fake.stdout.write(errorResponse(WINDOWS_HELPER_ERROR_CODE.IO_FAILED));
    mismatch.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);
    await expect(mismatch.result).rejects.toThrow(/does not match GCPW response disposition/);

    const mutation = encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.ACQUIRE_KEY_FOR_SIGNING, Buffer.from([1]));
    const mutationSuccess = startValidated(mutation);
    mutationSuccess.fake.stdout.write(encodeWindowsHelperFrame(WINDOWS_HELPER_OPCODE.ACQUIRE_KEY_FOR_SIGNING | 0x80));
    mutationSuccess.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);
    await expect(mutationSuccess.result).rejects.toThrow(/unavailable opcode/);

    const unavailableInspect = startValidated();
    unavailableInspect.fake.stdout.write(errorResponse(WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE));
    unavailableInspect.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.OPERATION_UNAVAILABLE);
    await expect(unavailableInspect.result).rejects.toThrow(/callable operation/);

    const invalidForValidInput = startValidated();
    invalidForValidInput.fake.stdout.write(errorResponse(WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID));
    invalidForValidInput.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.PROTOCOL_INVALID);
    await expect(invalidForValidInput.result).rejects.toThrow(/locally valid GCPW input/);
  });

  it("rejects stderr, signal termination, empty stdout, and malformed response bytes", async () => {
    const withStderr = startValidated();
    withStderr.fake.stdout.write(encodeWindowsHelperFrame(WINDOWS_HELPER_OPCODE.INSPECT | 0x80, inspectPayload()));
    withStderr.fake.stderr.write("platform detail");
    withStderr.fake.emitClose(0);
    await expect(withStderr.result).rejects.toThrow(/stderr bytes/);

    const signaled = startValidated();
    signaled.fake.emitClose(null, "SIGKILL");
    await expect(signaled.result).rejects.toBeInstanceOf(WindowsServiceClientExitError);

    const empty = startValidated();
    empty.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.IO_FAILED);
    await expect(empty.result).rejects.toBeInstanceOf(WindowsServiceClientExitError);

    const malformed = startValidated();
    malformed.fake.stdout.write(Buffer.from([0x47]));
    malformed.fake.emitClose(0);
    await expect(malformed.result).rejects.toBeInstanceOf(WindowsHelperProtocolError);

    const wrongInspectPayload = startValidated();
    wrongInspectPayload.fake.stdout.write(encodeWindowsHelperFrame(0x81, Buffer.alloc(31)));
    wrongInspectPayload.fake.emitClose(0);
    await expect(wrongInspectPayload.result).rejects.toThrow(/protected response payload length/);
  });
});

describe("typed protected service operations", () => {
  it("preserves caller-owned CREATE bytes through stdin and decodes only the bound result", async () => {
    const fake = createFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const result = createWindowsProtectedKeyset(process.execPath, mutationCreateRequest);
    fake.emitSpawn();
    const exactFrame = encodeWindowsProtectedCreateKeysetRequest(mutationCreateRequest);
    expect(Buffer.concat(fake.stdinChunks)).toEqual(exactFrame);
    const decodedRequest = decodeWindowsHelperRequest(exactFrame);
    expect(decodedRequest.payload.subarray(0, 16)).toEqual(mutationOperationId);
    expect(decodedRequest.payload.subarray(16, 48)).toEqual(mutationExpectedState);
    fake.stdout.write(encodeWindowsHelperFrame(0x90, createSuccessPayload()));
    fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);
    await expect(result).resolves.toMatchObject({
      disposition: "created",
      operationId: mutationOperationId,
      requestedGeneration: 7n,
      predecessorGeneration: 6n,
      expectedStateSha256: mutationExpectedState,
    });
  });

  it("preserves caller-owned REVOKE bytes through stdin and decodes only the bound result", async () => {
    const fake = createFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const result = revokeWindowsProtectedKeyset(process.execPath, mutationRevokeRequest);
    fake.emitSpawn();
    const exactFrame = encodeWindowsProtectedRevokeKeysetRequest(mutationRevokeRequest);
    expect(Buffer.concat(fake.stdinChunks)).toEqual(exactFrame);
    const decodedRequest = decodeWindowsHelperRequest(exactFrame);
    expect(decodedRequest.payload.subarray(0, 16)).toEqual(mutationOperationId);
    expect(decodedRequest.payload.subarray(16, 48)).toEqual(mutationExpectedState);
    expect(decodedRequest.payload.subarray(68, 100)).toEqual(mutationReceipt);
    fake.stdout.write(encodeWindowsHelperFrame(0x93, revokeSuccessPayload()));
    fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);
    await expect(result).resolves.toMatchObject({
      disposition: "revoked",
      operationId: mutationOperationId,
      generation: 7n,
      reason: "suspected_compromise",
      expectedStateSha256: mutationExpectedState,
    });
  });

  it("passes canonical evidence only over stdin and returns a public, verified signature receipt", async () => {
    const fake = createFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const result = signWindowsProtectedAdmissionEvidence(process.execPath, mutationSignRequest);
    fake.emitSpawn();
    const exactFrame = encodeWindowsProtectedSignAdmissionEvidenceRequest(mutationSignRequest);
    expect(Buffer.concat(fake.stdinChunks)).toEqual(exactFrame);
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, ["--service-stdio"], expect.objectContaining({ env: {} }));
    fake.stdout.write(encodeWindowsHelperFrame(0x92, signSuccessPayload()));
    fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);
    await expect(result).resolves.toMatchObject({
      disposition: "signed",
      operationId: mutationOperationId,
      generation: 7n,
      keysetReceiptSha256: mutationReceipt,
      admissionEvidenceSpki: mutationSignSpki,
    });
  });

  it("uses the same bounded process owner for typed INSPECT", async () => {
    const fake = createFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const result = inspectWindowsProtectedService(process.execPath);
    fake.emitSpawn();
    expect(Buffer.concat(fake.stdinChunks)).toEqual(encodeWindowsHelperInspectRequest());
    fake.stdout.write(encodeWindowsHelperFrame(0x81, inspectPayload()));
    fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS);
    await expect(result).resolves.toMatchObject({
      protectedCallableOpcodeBitmap: WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP,
      stateSha256: Buffer.alloc(32, 0x5a),
    });
  });

  it("classifies malformed fixed mutation bodies locally before interpreting service disposition", async () => {
    const malformed = encodeWindowsProtectedCreateKeysetRequest(mutationCreateRequest);
    malformed[16 + 50] = 1;
    const accepted = startValidated(malformed);
    accepted.fake.stdout.write(errorResponse(WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID));
    accepted.fake.emitClose(WINDOWS_SERVICE_CLIENT_EXIT_CODE.PROTOCOL_INVALID);
    await expect(accepted.result).resolves.toEqual({
      kind: "error",
      code: WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID,
    });
  });
});

const GCPA_MAGIC = "GCPA";
const GCPA_VERSION = 1;
const GCPA_REQUEST_ID = 1;
const GCPA_HEADER_BYTES = 16;
const GCPA_RECOGNIZED_BITMAP = 0x0007_0007_000f_0002n;
const GCPA_CALLABLE_BITMAP = WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP;
const GCPA_KIND = Object.freeze({
  CLIENT_HELLO: 0x01,
  SERVER_HELLO: 0x81,
  CLIENT_REQUEST: 0x02,
  SERVER_RESULT: 0x82,
  ERROR: 0x7f,
} as const);

function sequence(start: number, length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_unused, index) => (start + index) & 0xff));
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function rawSid(subAuthorities: readonly number[]): Buffer {
  const bytes = Buffer.alloc(8 + subAuthorities.length * 4);
  bytes.writeUInt8(1, 0);
  bytes.writeUInt8(subAuthorities.length, 1);
  bytes.writeUIntBE(5, 2, 6);
  subAuthorities.forEach((value, index) => bytes.writeUInt32LE(value, 8 + index * 4));
  return bytes;
}

function sidProjection(sid: Uint8Array): Buffer {
  const bytes = Buffer.alloc(2 + sid.byteLength);
  bytes.writeUInt16LE(sid.byteLength, 0);
  Buffer.from(sid).copy(bytes, 2);
  return bytes;
}

interface ImageProjectionInput {
  volumeSerialNumber: bigint;
  fileId: Uint8Array;
  fileSize: bigint;
  digest: Uint8Array;
}

function imageProjection(input: ImageProjectionInput): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeBigUInt64LE(input.volumeSerialNumber, 0);
  Buffer.from(input.fileId).copy(bytes, 8);
  bytes.writeBigUInt64LE(input.fileSize, 24);
  Buffer.from(input.digest).copy(bytes, 32);
  return bytes;
}

interface TokenProjectionInput {
  userSid: Uint8Array;
  logonSid: Uint8Array;
  logonSidAttributes: number;
  authenticationIdLowPart: number;
  authenticationIdHighPart: number;
  sessionId: number;
  elevationType: number;
  integrityRid: number;
  administratorsSidAttributes: number;
  hasRestrictedSids: boolean;
}

function tokenProjection(input: TokenProjectionInput): Buffer {
  const fixed = Buffer.alloc(32);
  fixed.writeUInt32LE(input.logonSidAttributes, 0);
  fixed.writeUInt32LE(input.authenticationIdLowPart, 4);
  fixed.writeInt32LE(input.authenticationIdHighPart, 8);
  fixed.writeUInt32LE(input.sessionId, 12);
  fixed.writeUInt32LE(input.elevationType, 16);
  fixed.writeUInt32LE(input.integrityRid, 20);
  fixed.writeUInt32LE(input.administratorsSidAttributes, 24);
  fixed.writeUInt8(input.hasRestrictedSids ? 1 : 0, 28);
  fixed.writeUInt8(0, 29);
  fixed.writeUInt16LE(0, 30);
  return Buffer.concat([sidProjection(input.userSid), sidProjection(input.logonSid), fixed]);
}

function encodeGcpaFrame(kind: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(GCPA_HEADER_BYTES);
  header.write(GCPA_MAGIC, 0, "ascii");
  header.writeUInt16LE(GCPA_VERSION, 4);
  header.writeUInt8(kind, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32LE(GCPA_REQUEST_ID, 8);
  header.writeUInt32LE(payload.byteLength, 12);
  return Buffer.concat([header, Buffer.from(payload)]);
}

const fixture = (() => {
  const serviceImage = imageProjection({
    volumeSerialNumber: 0x1122_3344_5566_7788n,
    fileId: sequence(0x00, 16),
    fileSize: 0x0102_0304_0506_0708n,
    digest: sequence(0x10, 32),
  });
  const clientImage = imageProjection({
    volumeSerialNumber: 0x8877_6655_4433_2211n,
    fileId: sequence(0xf0, 16),
    fileSize: 0x1020_3040_5060_7080n,
    digest: sequence(0xc0, 32),
  });
  const token = tokenProjection({
    userSid: rawSid([21, 1000, 2000, 3000, 4000]),
    logonSid: rawSid([5, 0x1122_3344, 0x5566_7788]),
    logonSidAttributes: 0xc000_0007,
    authenticationIdLowPart: 0x89ab_cdef,
    authenticationIdHighPart: -2,
    sessionId: 7,
    elevationType: 2,
    integrityRid: 0x3000,
    administratorsSidAttributes: 7,
    hasRestrictedSids: false,
  });
  return {
    serviceImage,
    clientImage,
    token,
    servicePid: 0x1020_3040,
    serviceCreationFileTime: 0x0102_0304_0506_0708n,
    clientPid: 0x5060_7080,
    clientCreationFileTime: 0x1112_1314_1516_1718n,
    serviceStartNonce: sequence(0x01, 32),
    connectionNonce: sequence(0x21, 32),
    clientNonce: sequence(0x41, 32),
    operationId: sequence(0x61, 16),
    opcode: WINDOWS_HELPER_OPCODE.INSPECT,
    schema: 1,
    body: Buffer.alloc(0),
    bodyDigest: sha256(Buffer.alloc(0)),
    expectedStateDigest: Buffer.alloc(32),
  };
})();

function authenticatedRequestBindingInput(): Buffer {
  const processFacts = Buffer.alloc(24);
  processFacts.writeUInt32LE(fixture.servicePid, 0);
  processFacts.writeBigUInt64LE(fixture.serviceCreationFileTime, 4);
  processFacts.writeUInt32LE(fixture.clientPid, 12);
  processFacts.writeBigUInt64LE(fixture.clientCreationFileTime, 16);
  const requestFacts = Buffer.alloc(4);
  requestFacts.writeUInt8(fixture.opcode, 0);
  requestFacts.writeUInt8(fixture.schema, 1);
  requestFacts.writeUInt16LE(0, 2);

  return Buffer.concat([
    Buffer.from("goatcitadel.remote-worker.provisioner.gcpa.request.v1\0", "ascii"),
    fixture.serviceImage,
    fixture.clientImage,
    fixture.token,
    fixture.token,
    processFacts,
    fixture.serviceStartNonce,
    fixture.connectionNonce,
    fixture.clientNonce,
    fixture.operationId,
    requestFacts,
    fixture.bodyDigest,
    fixture.expectedStateDigest,
  ]);
}

function clientHelloFrame(): Buffer {
  return encodeGcpaFrame(GCPA_KIND.CLIENT_HELLO, fixture.clientNonce);
}

function serverHelloFrame(): Buffer {
  const payload = Buffer.alloc(112);
  fixture.serviceStartNonce.copy(payload, 0);
  fixture.connectionNonce.copy(payload, 32);
  fixture.clientNonce.copy(payload, 64);
  payload.writeBigUInt64LE(GCPA_RECOGNIZED_BITMAP, 96);
  payload.writeBigUInt64LE(GCPA_CALLABLE_BITMAP, 104);
  return encodeGcpaFrame(GCPA_KIND.SERVER_HELLO, payload);
}

function clientRequestFrame(): Buffer {
  const payload = Buffer.alloc(184 + fixture.body.byteLength);
  fixture.serviceStartNonce.copy(payload, 0);
  fixture.connectionNonce.copy(payload, 32);
  fixture.clientNonce.copy(payload, 64);
  fixture.operationId.copy(payload, 96);
  payload.writeUInt8(fixture.opcode, 112);
  payload.writeUInt8(fixture.schema, 113);
  payload.writeUInt16LE(0, 114);
  payload.writeUInt32LE(fixture.body.byteLength, 116);
  fixture.bodyDigest.copy(payload, 120);
  fixture.expectedStateDigest.copy(payload, 152);
  fixture.body.copy(payload, 184);
  return encodeGcpaFrame(GCPA_KIND.CLIENT_REQUEST, payload);
}

function mutationClientRequestFrame(opcode: number, body: Uint8Array): Buffer {
  const bodyBytes = Buffer.from(body);
  const payload = Buffer.alloc(184 + bodyBytes.byteLength);
  fixture.serviceStartNonce.copy(payload, 0);
  fixture.connectionNonce.copy(payload, 32);
  fixture.clientNonce.copy(payload, 64);
  bodyBytes.copy(payload, 96, 0, 16);
  payload.writeUInt8(opcode, 112);
  payload.writeUInt8(1, 113);
  payload.writeUInt16LE(0, 114);
  payload.writeUInt32LE(bodyBytes.byteLength, 116);
  sha256(bodyBytes).copy(payload, 120);
  bodyBytes.copy(payload, 152, 16, 48);
  bodyBytes.copy(payload, 184);
  return encodeGcpaFrame(GCPA_KIND.CLIENT_REQUEST, payload);
}

function serverResultFrame(binding: Uint8Array, result: Uint8Array): Buffer {
  const payload = Buffer.alloc(84 + result.byteLength);
  fixture.operationId.copy(payload, 0);
  Buffer.from(binding).copy(payload, 16);
  sha256(result).copy(payload, 48);
  payload.writeUInt32LE(result.byteLength, 80);
  Buffer.from(result).copy(payload, 84);
  return encodeGcpaFrame(GCPA_KIND.SERVER_RESULT, payload);
}

function boundErrorFrame(binding: Uint8Array): Buffer {
  const payload = Buffer.alloc(52);
  payload.writeUInt32LE(WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE, 0);
  fixture.operationId.copy(payload, 4);
  Buffer.from(binding).copy(payload, 20);
  return encodeGcpaFrame(GCPA_KIND.ERROR, payload);
}

describe("shared literal GCPW/GCPA and projection vectors", () => {
  it("freezes SID, image, and token projections including signed HighPart", () => {
    const userSid = rawSid([21, 1000, 2000, 3000, 4000]);
    const logonSid = rawSid([5, 0x1122_3344, 0x5566_7788]);
    expect(sidProjection(userSid).toString("hex")).toBe("1c00010500000000000515000000e8030000d0070000b80b0000a00f0000");
    expect(sidProjection(logonSid).toString("hex")).toBe("14000103000000000005050000004433221188776655");
    expect(fixture.token.byteLength).toBe(84);
    expect(fixture.token.toString("hex")).toBe(
      "1c00010500000000000515000000e8030000d0070000b80b0000a00f0000" +
        "14000103000000000005050000004433221188776655" +
        "070000c0efcdab89feffffff0700000002000000003000000700000000000000",
    );
    expect(fixture.token.readInt32LE(60)).toBe(-2);

    expect(fixture.serviceImage.toString("hex")).toBe(
      "8877665544332211000102030405060708090a0b0c0d0e0f0807060504030201" +
        "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
    );
    expect(fixture.clientImage.toString("hex")).toBe(
      "1122334455667788f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff8070605040302010" +
        "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf",
    );
  });

  it("freezes the 554-byte authenticated-request projection and digest", () => {
    const input = authenticatedRequestBindingInput();
    const domain = Buffer.from("goatcitadel.remote-worker.provisioner.gcpa.request.v1\0", "ascii");
    expect(input.byteLength).toBe(554);
    expect(input.subarray(0, domain.byteLength)).toEqual(domain);
    expect(sha256(input).toString("hex")).toBe("190bb99f3ab87246f65baf791109960f1ef3b9cf8ae1b302fe326f21d196174a");
  });

  it("freezes literal CLIENT_HELLO and SERVER_HELLO frames", () => {
    expect(clientHelloFrame().toString("hex")).toBe(
      "47435041010001000100000020000000" + "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60",
    );
    expect(serverHelloFrame().toString("hex")).toBe(
      "47435041010081000100000070000000" +
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" +
        "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40" +
        "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60" +
        "02000f000700070002000d0000000000",
    );
  });

  it("freezes the literal empty INSPECT CLIENT_REQUEST and every fixed offset", () => {
    const request = clientRequestFrame();
    expect(request.toString("hex")).toBe(
      "474350410100020001000000b8000000" +
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" +
        "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40" +
        "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60" +
        "6162636465666768696a6b6c6d6e6f70" +
        "0101000000000000" +
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" +
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(request.byteLength).toBe(GCPA_HEADER_BYTES + 184);
    expect(request.readUInt32LE(12)).toBe(184);
    expect(request.subarray(16, 48)).toEqual(fixture.serviceStartNonce);
    expect(request.subarray(48, 80)).toEqual(fixture.connectionNonce);
    expect(request.subarray(80, 112)).toEqual(fixture.clientNonce);
    expect(request.subarray(112, 128)).toEqual(fixture.operationId);
    expect(request.readUInt8(128)).toBe(WINDOWS_HELPER_OPCODE.INSPECT);
    expect(request.readUInt8(129)).toBe(1);
    expect(request.readUInt16LE(130)).toBe(0);
    expect(request.readUInt32LE(132)).toBe(0);
    expect(request.subarray(136, 168)).toEqual(fixture.bodyDigest);
    expect(request.subarray(168, 200)).toEqual(Buffer.alloc(32));
  });

  it("freezes caller-owned CREATE and REVOKE bytes at every GCPA authority offset", () => {
    const createBody = decodeWindowsHelperRequest(
      encodeWindowsProtectedCreateKeysetRequest(mutationCreateRequest),
    ).payload;
    const revokeBody = decodeWindowsHelperRequest(
      encodeWindowsProtectedRevokeKeysetRequest(mutationRevokeRequest),
    ).payload;
    for (const [opcode, body] of [
      [WINDOWS_HELPER_OPCODE.CREATE_KEYSET, createBody],
      [WINDOWS_HELPER_OPCODE.REVOKE_LOCAL_KEYSET, revokeBody],
    ] as const) {
      const frame = mutationClientRequestFrame(opcode, body);
      expect(frame.readUInt32LE(12)).toBe(184 + body.byteLength);
      expect(frame.subarray(16 + 96, 16 + 112)).toEqual(body.subarray(0, 16));
      expect(frame.readUInt8(16 + 112)).toBe(opcode);
      expect(frame.readUInt8(16 + 113)).toBe(1);
      expect(frame.readUInt16LE(16 + 114)).toBe(0);
      expect(frame.readUInt32LE(16 + 116)).toBe(body.byteLength);
      expect(frame.subarray(16 + 120, 16 + 152)).toEqual(sha256(body));
      expect(frame.subarray(16 + 152, 16 + 184)).toEqual(body.subarray(16, 48));
      expect(frame.subarray(16 + 184)).toEqual(body);
    }
  });

  it("freezes literal SERVER_RESULT and bound ERROR frames", () => {
    const binding = sha256(authenticatedRequestBindingInput());
    const result = inspectPayload();
    const resultHash = sha256(result);
    const frame = serverResultFrame(binding, result);
    expect(frame.subarray(0, 16).toString("hex")).toBe("47435041010082000100000094010000");
    expect(frame.subarray(16, 32)).toEqual(fixture.operationId);
    expect(frame.subarray(32, 64)).toEqual(binding);
    expect(frame.subarray(64, 96)).toEqual(resultHash);
    expect(frame.readUInt32LE(96)).toBe(320);
    expect(frame.subarray(100)).toEqual(result);
    expect(boundErrorFrame(binding).toString("hex")).toBe(
      "4743504101007f000100000034000000" +
        "02000000" +
        "6162636465666768696a6b6c6d6e6f70" +
        "190bb99f3ab87246f65baf791109960f1ef3b9cf8ae1b302fe326f21d196174a",
    );
  });

  it("freezes the cross-protocol INSPECT and all GCPW error output bytes", () => {
    expect(encodeWindowsHelperInspectRequest().toString("hex")).toBe("47435057010001000100000000000000");
    const protectedInspect = encodeWindowsHelperFrame(0x81, inspectPayload());
    expect(protectedInspect.subarray(0, 16).toString("hex")).toBe("47435057010081000100000040010000");
    expect(protectedInspect.subarray(16, 48).toString("hex")).toBe(
      "0100648600002000002000000000000002000f00070007000200000000000000",
    );
    expect(protectedInspect.readBigUInt64LE(56)).toBe(WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP);
    expect(errorResponse(WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID).toString("hex")).toBe(
      "4743505701007f00010000000400000001000000",
    );
    expect(errorResponse(WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE).toString("hex")).toBe(
      "4743505701007f00010000000400000002000000",
    );
    expect(errorResponse(WINDOWS_HELPER_ERROR_CODE.IO_FAILED).toString("hex")).toBe(
      "4743505701007f00010000000400000003000000",
    );
  });
});

describe("process error type", () => {
  it("retains the shared bounded-runner error owner", () => {
    const error = new WindowsHelperProcessError("timed_out", "deadline");
    expect(error).toBeInstanceOf(WindowsHelperProcessError);
    expect(error.reason).toBe("timed_out");
  });
});
