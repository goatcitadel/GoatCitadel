import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  WINDOWS_HELPER_ERROR_CODE,
  WINDOWS_HELPER_OPCODE,
  WINDOWS_HELPER_STDERR_MAX_BYTES,
  WINDOWS_HELPER_STDOUT_MAX_BYTES,
  WindowsHelperProcessError,
  WindowsHelperProtocolError,
  decodeWindowsProtectedCreateKeysetResponse,
  decodeWindowsProtectedInspectResponse,
  decodeWindowsProtectedRevokeKeysetResponse,
  decodeWindowsHelperRequest,
  decodeWindowsHelperResponse,
  encodeWindowsHelperInspectRequest,
  encodeWindowsProtectedCreateKeysetRequest,
  encodeWindowsProtectedRevokeKeysetRequest,
  validateWindowsProtectedRequestPayload,
  type WindowsProtectedCreateKeysetRequest,
  type WindowsProtectedCreateKeysetResult,
  type WindowsProtectedInspect,
  type WindowsProtectedRevokeKeysetRequest,
  type WindowsProtectedRevokeKeysetResult,
  type WindowsHelperProcessResult,
  type WindowsHelperRequestOpcode,
  type WindowsHelperResponse,
} from "./windows-helper-protocol.js";

export const WINDOWS_SERVICE_CLIENT_ARGUMENT = "--service-stdio";
export const WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS = 50_000;
export const WINDOWS_SERVICE_CLIENT_TERMINATION_GRACE_MS = 2_000;

export const WINDOWS_SERVICE_CLIENT_EXIT_CODE = Object.freeze({
  SUCCESS: 0,
  USAGE_INVALID: 2,
  PROTOCOL_INVALID: 3,
  OPERATION_UNAVAILABLE: 4,
  IO_FAILED: 5,
} as const);

export interface WindowsServiceClientRunOptions {
  /** Tests may shorten the deadline, but callers cannot exceed the fixed cap. */
  timeoutMs?: number;
}

export class WindowsServiceClientExitError extends Error {
  public readonly result: WindowsHelperProcessResult;

  public constructor(result: WindowsHelperProcessResult) {
    super(`Windows protected service client exited without a valid GCPW response (exit=${String(result.exitCode)})`);
    this.name = "WindowsServiceClientExitError";
    this.result = result;
  }
}

function validateRunInputs(
  executablePath: string,
  requestFrame: Uint8Array,
  options: WindowsServiceClientRunOptions,
): number {
  if (typeof executablePath !== "string" || !isAbsolute(executablePath) || executablePath.includes("\0")) {
    throw new WindowsHelperProcessError(
      "spawn_failed",
      "Windows protected service client executable path must be absolute",
    );
  }
  if (!(requestFrame instanceof Uint8Array)) {
    throw new WindowsHelperProtocolError("request frame must be a byte array");
  }
  if (requestFrame.byteLength > WINDOWS_HELPER_STDOUT_MAX_BYTES) {
    throw new WindowsHelperProtocolError("request frame exceeds the ordinary GCPW frame limit");
  }

  const timeoutMs = options.timeoutMs ?? WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS) {
    throw new WindowsHelperProcessError(
      "timed_out",
      `timeout must be an integer from 1 through ${String(WINDOWS_SERVICE_CLIENT_PROCESS_TIMEOUT_MS)}`,
    );
  }
  return timeoutMs;
}

export async function runWindowsServiceClientOneShot(
  executablePath: string,
  requestFrame: Uint8Array,
  options: WindowsServiceClientRunOptions = {},
): Promise<WindowsHelperProcessResult> {
  const timeoutMs = validateRunInputs(executablePath, requestFrame, options);

  return await new Promise<WindowsHelperProcessResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let spawned = false;
    let stdinError: Error | undefined;
    let terminalCause: Error | undefined;
    let terminalReason: "process_error" | "timed_out" | "stdout_limit" | "stderr_limit" | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executablePath, [WINDOWS_SERVICE_CLIENT_ARGUMENT], {
        cwd: undefined,
        env: {},
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new WindowsHelperProcessError("spawn_failed", "Windows protected service client could not be started", {
          cause: error,
        }),
      );
      return;
    }

    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
    };

    const stop = (reason: "process_error" | "timed_out" | "stdout_limit" | "stderr_limit", cause?: Error): void => {
      if (terminalReason !== undefined || settled) return;
      terminalReason = reason;
      terminalCause = cause;
      child.stdin.destroy();

      let killAccepted = false;
      try {
        killAccepted = child.kill("SIGKILL");
      } catch (error) {
        terminalCause = error instanceof Error ? error : new Error(String(error));
      }

      terminationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimers();
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
        reject(
          new WindowsHelperProcessError(
            "termination_failed",
            killAccepted
              ? "Windows protected service client did not close after forced termination"
              : "Windows protected service client could not be forcibly terminated",
            terminalCause === undefined ? undefined : { cause: terminalCause },
          ),
        );
      }, WINDOWS_SERVICE_CLIENT_TERMINATION_GRACE_MS);
    };

    const timer = setTimeout(() => stop("timed_out"), timeoutMs);

    child.once("spawn", () => {
      spawned = true;
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > WINDOWS_HELPER_STDOUT_MAX_BYTES) {
        stop("stdout_limit");
        return;
      }
      stdoutChunks.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > WINDOWS_HELPER_STDERR_MAX_BYTES) {
        stop("stderr_limit");
        return;
      }
      stderrChunks.push(bytes);
    });
    child.stdout.once("error", (error) => stop("process_error", error));
    child.stderr.once("error", (error) => stop("process_error", error));

    child.once("error", (error) => {
      if (settled) return;
      if (!spawned) {
        clearTimers();
        settled = true;
        reject(
          new WindowsHelperProcessError("spawn_failed", "Windows protected service client could not be started", {
            cause: error,
          }),
        );
        return;
      }
      stop("process_error", error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;

      if (terminalReason !== undefined) {
        const messages = {
          process_error: "Windows protected service client failed after it started",
          timed_out: "Windows protected service client exceeded its fixed deadline",
          stdout_limit: "Windows protected service client exceeded the stdout limit",
          stderr_limit: "Windows protected service client exceeded the stderr limit",
        } as const;
        reject(
          new WindowsHelperProcessError(
            terminalReason,
            messages[terminalReason],
            terminalCause === undefined ? undefined : { cause: terminalCause },
          ),
        );
        return;
      }

      if (stdinError !== undefined) {
        reject(
          new WindowsHelperProcessError(
            "stdin_failed",
            "Windows protected service client did not accept the complete GCPW request frame",
            { cause: stdinError },
          ),
        );
        return;
      }

      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
      });
    });

    child.stdin.on("error", (error) => {
      // Wait for close so the child cannot be orphaned, then fail closed even
      // if it emitted protocol bytes without accepting the complete request.
      stdinError = error;
    });
    child.stdin.end(Buffer.from(requestFrame));
  });
}

function tryDecodeLocallyValidRequestOpcode(requestFrame: Uint8Array): WindowsHelperRequestOpcode | undefined {
  try {
    const request = decodeWindowsHelperRequest(requestFrame);
    validateWindowsProtectedRequestPayload(request.opcode, request.payload);
    return request.opcode;
  } catch (error) {
    if (error instanceof WindowsHelperProtocolError) return undefined;
    throw error;
  }
}

function expectedExitCode(response: WindowsHelperResponse): number {
  if (response.kind === "success") return WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS;
  if (response.code === WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID) {
    return WINDOWS_SERVICE_CLIENT_EXIT_CODE.PROTOCOL_INVALID;
  }
  if (response.code === WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE) {
    return WINDOWS_SERVICE_CLIENT_EXIT_CODE.OPERATION_UNAVAILABLE;
  }
  return WINDOWS_SERVICE_CLIENT_EXIT_CODE.IO_FAILED;
}

export async function runWindowsServiceClient(
  executablePath: string,
  requestFrame: Uint8Array,
  options: WindowsServiceClientRunOptions = {},
): Promise<WindowsHelperResponse> {
  const requestOpcode = tryDecodeLocallyValidRequestOpcode(requestFrame);
  const result = await runWindowsServiceClientOneShot(executablePath, requestFrame, options);

  if (result.signal !== null || result.stdout.byteLength === 0) {
    throw new WindowsServiceClientExitError(result);
  }
  if (result.stderr.byteLength !== 0) {
    throw new WindowsHelperProtocolError("Windows protected service client emitted stderr bytes");
  }

  const response = decodeWindowsHelperResponse(result.stdout, requestOpcode ?? WINDOWS_HELPER_OPCODE.INSPECT);
  if (
    requestOpcode === undefined &&
    (response.kind !== "error" || response.code !== WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID)
  ) {
    throw new WindowsHelperProtocolError("invalid local GCPW input did not return protocol_invalid");
  }
  if (requestOpcode !== undefined) {
    const isCallable =
      requestOpcode === WINDOWS_HELPER_OPCODE.INSPECT ||
      requestOpcode === WINDOWS_HELPER_OPCODE.CREATE_KEYSET ||
      requestOpcode === WINDOWS_HELPER_OPCODE.REVOKE_LOCAL_KEYSET;
    if (response.kind === "success" && !isCallable) {
      throw new WindowsHelperProtocolError("protected service client returned success for an unavailable opcode");
    }
    if (response.kind === "success") {
      if (requestOpcode === WINDOWS_HELPER_OPCODE.INSPECT) {
        decodeWindowsProtectedInspectResponse(result.stdout);
      } else {
        const request = decodeWindowsHelperRequest(requestFrame);
        if (requestOpcode === WINDOWS_HELPER_OPCODE.CREATE_KEYSET) {
          decodeWindowsProtectedCreateKeysetResponse(result.stdout, {
            operationId: request.payload.subarray(0, 16),
            expectedStateSha256: request.payload.subarray(16, 48),
            requestedGeneration: request.payload.readBigUInt64LE(52),
            predecessorGeneration: request.payload.readBigUInt64LE(60),
          });
        } else {
          const reasons = ["operator_requested", "suspected_compromise", "retired"] as const;
          const reason = reasons[request.payload.readUInt32LE(60) - 1];
          if (reason === undefined) throw new WindowsHelperProtocolError("revoke reason is invalid");
          decodeWindowsProtectedRevokeKeysetResponse(result.stdout, {
            operationId: request.payload.subarray(0, 16),
            expectedStateSha256: request.payload.subarray(16, 48),
            generation: request.payload.readBigUInt64LE(52),
            reason,
            expectedKeysetReceiptSha256: request.payload.subarray(68, 100),
          });
        }
      }
    } else {
      if (response.code === WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID) {
        throw new WindowsHelperProtocolError("locally valid GCPW input returned protocol_invalid");
      }
      if (response.code === WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE && isCallable) {
        throw new WindowsHelperProtocolError(
          "protected service client returned operation_unavailable for a callable operation",
        );
      }
    }
  }

  const requiredExitCode = expectedExitCode(response);
  if (result.exitCode !== requiredExitCode) {
    throw new WindowsHelperProtocolError(
      `Windows protected service client exit ${String(result.exitCode)} does not match GCPW response disposition ${String(requiredExitCode)}`,
    );
  }
  return response;
}

export async function inspectWindowsProtectedService(
  executablePath: string,
  options: WindowsServiceClientRunOptions = {},
): Promise<WindowsProtectedInspect> {
  const frame = encodeWindowsHelperInspectRequest();
  const result = await runWindowsServiceClientOneShot(executablePath, frame, options);
  if (
    result.exitCode !== WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS ||
    result.signal !== null ||
    result.stderr.byteLength !== 0
  ) {
    throw new WindowsServiceClientExitError(result);
  }
  return decodeWindowsProtectedInspectResponse(result.stdout);
}

export async function createWindowsProtectedKeyset(
  executablePath: string,
  input: WindowsProtectedCreateKeysetRequest,
  options: WindowsServiceClientRunOptions = {},
): Promise<WindowsProtectedCreateKeysetResult> {
  const frame = encodeWindowsProtectedCreateKeysetRequest(input);
  const result = await runWindowsServiceClientOneShot(executablePath, frame, options);
  if (
    result.exitCode !== WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS ||
    result.signal !== null ||
    result.stderr.byteLength !== 0
  ) {
    throw new WindowsServiceClientExitError(result);
  }
  return decodeWindowsProtectedCreateKeysetResponse(result.stdout, input);
}

export async function revokeWindowsProtectedKeyset(
  executablePath: string,
  input: WindowsProtectedRevokeKeysetRequest,
  options: WindowsServiceClientRunOptions = {},
): Promise<WindowsProtectedRevokeKeysetResult> {
  const frame = encodeWindowsProtectedRevokeKeysetRequest(input);
  const result = await runWindowsServiceClientOneShot(executablePath, frame, options);
  if (
    result.exitCode !== WINDOWS_SERVICE_CLIENT_EXIT_CODE.SUCCESS ||
    result.signal !== null ||
    result.stderr.byteLength !== 0
  ) {
    throw new WindowsServiceClientExitError(result);
  }
  return decodeWindowsProtectedRevokeKeysetResponse(result.stdout, input);
}
