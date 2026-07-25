import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { CodeModeAiderAdapterOutcome } from "@goatcitadel/contracts";
import type { CodeModeAiderAdapterConfig, CodeModeDockerBackendConfig } from "../config.js";
import { buildDockerClientEnv, CODE_MODE_DOCKER_DEFAULT_COMMAND } from "./code-mode-docker-launch.js";
import {
  buildCodeModeAiderAdapterInvocationPlan,
  CODE_MODE_AIDER_MESSAGE_FILE,
} from "./code-mode-aider-adapter-plan.js";
import {
  persistCodeModeAiderArtifactBundle,
  type CodeModeAiderArtifactBundle,
  type CodeModeAiderArtifactPersister,
} from "./code-mode-aider-artifacts.js";
import { terminateProcessTree } from "./process-tree-killer.js";

export interface CodeModeAiderExecutionInput {
  runId: string;
  runTempRoot: string;
  language: "javascript" | "typescript";
  source: string;
  requestMarkdown: string;
  repositoryRootRelPath?: string;
  model?: string;
  aiderAdapter: CodeModeAiderAdapterConfig;
  dockerBackend: CodeModeDockerBackendConfig;
  persister: CodeModeAiderArtifactPersister;
  beforeDispatch?: () => Promise<void>;
  onDispatchFailed?: () => Promise<void>;
  signal?: AbortSignal;
  spawnCommand?: typeof spawn;
  terminateProcessTree?: typeof terminateProcessTree;
  timeoutMs?: number;
  outputCaptureLimitBytes?: number;
}

export interface CodeModeAiderExecutionResult {
  failed: boolean;
  outcome: CodeModeAiderAdapterOutcome;
  result: CodeModeAiderArtifactBundle["result"];
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  bundle: CodeModeAiderArtifactBundle;
}

const AIDER_RUN_ROOT_SEGMENT = "aider-live";
const AIDER_CONTAINER_ROOT = "/goatcitadel/aider-run";
const AIDER_PATCH_CANDIDATES = ["aider.patch", "aider.git.patch"];
const AIDER_RUN_TIMEOUT_MS = 15_000;
const AIDER_OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const AIDER_TERMINATE_GRACE_MS = 3000;
const AIDER_TERMINATE_CONFIRMATION_MS = 250;
const OUTPUT_TRUNCATION_MARKER = "\n...[truncated]\n";

export async function executeCodeModeAiderAdapter(
  input: CodeModeAiderExecutionInput,
): Promise<CodeModeAiderExecutionResult> {
  const image = input.aiderAdapter.image?.trim();
  if (!input.aiderAdapter.enabled || !image) {
    throw new Error("Aider adapter execution requires an enabled adapter and configured image.");
  }
  if (!input.dockerBackend.enabled) {
    throw new Error("Aider adapter execution requires the Docker Code Mode backend to be enabled.");
  }

  const runRoot = path.join(input.runTempRoot, AIDER_RUN_ROOT_SEGMENT);
  const repositoryRootRelPath = normalizeAiderRepositoryRoot(input.repositoryRootRelPath);
  const repositoryRoot = path.join(runRoot, ...repositoryRootRelPath.split("/").filter((segment) => segment !== "."));
  const requestRelPathSegments = CODE_MODE_AIDER_MESSAGE_FILE.split("/");
  const requestPath = path.join(repositoryRoot, ...requestRelPathSegments);
  const sourceFilename = `input.${input.language === "typescript" ? "ts" : "js"}`;
  const sourcePath = path.join(repositoryRoot, sourceFilename);
  await fs.mkdir(path.dirname(requestPath), { recursive: true });
  await fs.writeFile(requestPath, input.requestMarkdown, "utf8");
  await fs.writeFile(sourcePath, input.source, "utf8");

  const invocationPlan = buildCodeModeAiderAdapterInvocationPlan({
    runId: input.runId,
    repositoryRootRelPath,
    command: input.aiderAdapter.command,
    model: input.model ?? input.aiderAdapter.model,
  });
  const command = buildAiderDockerCommand({
    runId: input.runId,
    runRoot,
    image,
    dockerCommand: input.dockerBackend.dockerCommand,
    invocationArgv: invocationPlan.command.argv,
    repositoryRootRelPath,
  });
  if (input.signal?.aborted) {
    const reason = formatAbortReason(input.signal);
    throw new Error(`Aider adapter execution was aborted before dispatch: ${reason}`);
  }
  try {
    await input.beforeDispatch?.();
  } catch (error) {
    // No process exists yet, so dispatch is known not to have occurred. Reset
    // any tentative durable boundary that the hook managed to persist before
    // it failed (for example, if a diagnostic sink threw after the write).
    await input.onDispatchFailed?.();
    throw error;
  }
  const startedAt = new Date().toISOString();
  let spawned: ChildProcess;
  try {
    spawned = (input.spawnCommand ?? spawn)(command.executable, command.args, {
      cwd: runRoot,
      env: buildDockerClientEnv(process.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await input.onDispatchFailed?.();
    throw error;
  }
  const execution = await waitForAiderChild(spawned, {
    runId: input.runId,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? AIDER_RUN_TIMEOUT_MS,
    outputCaptureLimitBytes: input.outputCaptureLimitBytes ?? AIDER_OUTPUT_CAPTURE_LIMIT_BYTES,
    terminate: input.terminateProcessTree ?? terminateProcessTree,
  });
  const finishedAt = new Date().toISOString();
  const failure = buildAiderFailureEvidence(execution);
  const mayReadMutableArtifacts = !failure || execution.mutableArtifactsSafe;
  const explicitPatch = mayReadMutableArtifacts ? await readAiderPatchIfPresent(runRoot, repositoryRoot) : undefined;
  const sourcePatch =
    mayReadMutableArtifacts && !explicitPatch
      ? buildAiderSourcePatchIfChanged({
          relPath: toPatchRelPath(repositoryRootRelPath, sourceFilename),
          originalSource: input.source,
          currentSource: await fs.readFile(sourcePath, "utf8"),
        })
      : undefined;
  const patch = explicitPatch ?? sourcePatch;
  const failed = Boolean(failure);
  const outcome: CodeModeAiderAdapterOutcome = failed ? "failed" : patch ? "patch_produced" : "no_changes";
  const bundle = await persistCodeModeAiderArtifactBundle(input.persister, {
    runId: input.runId,
    requestMarkdown: input.requestMarkdown,
    invocationPlan,
    outcome,
    ...(patch ? { patch } : {}),
    stdout: execution.stdout,
    stderr: execution.stderr,
    command: {
      exitCode: execution.exitCode,
      startedAt,
      finishedAt,
    },
    ...(failure
      ? {
          error: failure,
        }
      : {}),
  });

  return {
    failed,
    outcome,
    result: bundle.result,
    error: failure?.message,
    errorCode: failure?.code,
    errorDetails: failure?.details,
    stdout: execution.stdout,
    stderr: execution.stderr,
    stdoutTruncated: execution.stdoutTruncated,
    stderrTruncated: execution.stderrTruncated,
    bundle,
  };
}

function buildAiderDockerCommand(input: {
  runId: string;
  runRoot: string;
  image: string;
  dockerCommand?: string;
  invocationArgv: string[];
  repositoryRootRelPath: string;
}): { executable: string; args: string[] } {
  return {
    executable: input.dockerCommand?.trim() || CODE_MODE_DOCKER_DEFAULT_COMMAND,
    args: [
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      "--pull",
      "never",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--label",
      `goatcitadel.code-mode.aider-run=${input.runId}`,
      "--mount",
      `type=bind,src=${input.runRoot},dst=${AIDER_CONTAINER_ROOT},rw`,
      "--workdir",
      path.posix.join(AIDER_CONTAINER_ROOT, input.repositoryRootRelPath),
      "--env",
      "GOATCITADEL_CODE_MODE_AIDER=1",
      input.image,
      ...input.invocationArgv,
    ],
  };
}

interface AiderChildExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  mutableArtifactsSafe: boolean;
  failure?: {
    code: "AIDER_TIMEOUT" | "AIDER_ABORTED" | "AIDER_PROCESS_ERROR" | "AIDER_STREAM_ERROR";
    message: string;
    details: Record<string, unknown>;
  };
}

type AiderChildFailure = NonNullable<AiderChildExecution["failure"]>;

function waitForAiderChild(
  child: ChildProcess,
  options: {
    runId: string;
    signal: AbortSignal | undefined;
    timeoutMs: number;
    outputCaptureLimitBytes: number;
    terminate: typeof terminateProcessTree;
  },
): Promise<AiderChildExecution> {
  return new Promise((resolve) => {
    const stdout = createBoundedCapture(options.outputCaptureLimitBytes);
    const stderr = createBoundedCapture(options.outputCaptureLimitBytes);
    let settled = false;
    let pendingTermination:
      | {
          failure: AiderChildFailure;
          exitCode: number;
          timer: NodeJS.Timeout;
        }
      | undefined;
    const timeoutMs = Math.max(1, Math.round(options.timeoutMs));
    const timer = setTimeout(() => {
      requestTermination("Aider adapter timeout", {
        exitCode: -1,
        failure: {
          code: "AIDER_TIMEOUT",
          message: `Aider adapter timed out after ${timeoutMs}ms; process tree cleanup was requested.`,
          details: {
            runId: options.runId,
            timeoutMs,
            processTreeCleanup: "requested",
          },
        },
      });
    }, timeoutMs);
    timer.unref?.();
    const finish = (result: {
      exitCode: number;
      failure?: AiderChildExecution["failure"];
      mutableArtifactsSafe: boolean;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (pendingTermination) {
        clearTimeout(pendingTermination.timer);
        pendingTermination = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
      const stdoutResult = stdout.finish();
      const stderrResult = stderr.finish();
      resolve({
        exitCode: result.exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        mutableArtifactsSafe: result.mutableArtifactsSafe,
        ...(result.failure
          ? {
              failure: {
                ...result.failure,
                details: {
                  ...result.failure.details,
                  stdoutTruncated: stdoutResult.truncated,
                  stderrTruncated: stderrResult.truncated,
                },
              },
            }
          : {}),
      });
    };
    const requestTermination = (label: string, result: { exitCode: number; failure: AiderChildFailure }) => {
      if (settled || pendingTermination) {
        return;
      }
      terminate(label);
      const timeout = setTimeout(() => {
        finish({
          exitCode: result.exitCode,
          failure: {
            ...result.failure,
            details: {
              ...result.failure.details,
              processTreeCleanupConfirmed: false,
              mutableArtifactCapture: "skipped_process_tree_unconfirmed",
            },
          },
          mutableArtifactsSafe: false,
        });
      }, AIDER_TERMINATE_CONFIRMATION_MS);
      timeout.unref?.();
      pendingTermination = { ...result, timer: timeout };
    };
    const terminate = (label: string) => {
      options.terminate({
        child,
        label,
        context: {
          runId: options.runId,
        },
        graceMs: AIDER_TERMINATE_GRACE_MS,
      });
    };
    const onAbort = () => {
      const reason = formatAbortReason(options.signal);
      requestTermination("Aider adapter abort", {
        exitCode: -1,
        failure: {
          code: "AIDER_ABORTED",
          message: `Aider adapter execution was aborted; process tree cleanup was requested.`,
          details: {
            runId: options.runId,
            reason,
            processTreeCleanup: "requested",
          },
        },
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk);
    });
    child.stdout?.on("error", (error: Error) => {
      requestTermination("Aider adapter stdout stream error", {
        exitCode: -1,
        failure: {
          code: "AIDER_STREAM_ERROR",
          message: `Aider adapter stdout stream failed: ${error.message}`,
          details: {
            runId: options.runId,
            stream: "stdout",
            processTreeCleanup: "requested",
          },
        },
      });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
    });
    child.stderr?.on("error", (error: Error) => {
      requestTermination("Aider adapter stderr stream error", {
        exitCode: -1,
        failure: {
          code: "AIDER_STREAM_ERROR",
          message: `Aider adapter stderr stream failed: ${error.message}`,
          details: {
            runId: options.runId,
            stream: "stderr",
            processTreeCleanup: "requested",
          },
        },
      });
    });
    child.on("error", (error) => {
      requestTermination("Aider adapter process error", {
        exitCode: -1,
        failure: {
          code: "AIDER_PROCESS_ERROR",
          message: error.message,
          details: {
            runId: options.runId,
            processTreeCleanup: "requested",
          },
        },
      });
    });
    child.on("close", (code) => {
      if (pendingTermination) {
        const pending = pendingTermination;
        finish({
          exitCode: code ?? pending.exitCode,
          failure: {
            ...pending.failure,
            details: {
              ...pending.failure.details,
              processTreeCleanupConfirmed: true,
            },
          },
          mutableArtifactsSafe: true,
        });
        return;
      }
      finish({
        exitCode: code ?? 1,
        mutableArtifactsSafe: true,
      });
    });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

function buildAiderFailureEvidence(
  execution: AiderChildExecution,
): { code: string; message: string; details?: Record<string, unknown> } | undefined {
  if (execution.failure) {
    return execution.failure;
  }
  if (execution.exitCode === 0) {
    return undefined;
  }
  return {
    code: "AIDER_EXIT_NONZERO",
    message: `Aider adapter exited with code ${execution.exitCode}.`,
    details: {
      exitCode: execution.exitCode,
      stdoutTruncated: execution.stdoutTruncated,
      stderrTruncated: execution.stderrTruncated,
    },
  };
}

function createBoundedCapture(limitBytes: number): {
  append: (chunk: Buffer | string) => void;
  finish: () => { text: string; truncated: boolean };
} {
  const maxBytes = Math.max(1, Math.floor(limitBytes));
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (truncated) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        chunks.push(Buffer.from(OUTPUT_TRUNCATION_MARKER, "utf8"));
        truncated = true;
        return;
      }
      if (buffer.length <= remaining) {
        chunks.push(buffer);
        bytes += buffer.length;
        return;
      }
      chunks.push(buffer.subarray(0, remaining));
      chunks.push(Buffer.from(OUTPUT_TRUNCATION_MARKER, "utf8"));
      bytes = maxBytes;
      truncated = true;
    },
    finish() {
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        truncated,
      };
    },
  };
}

function formatAbortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }
  return "Abort signal was raised.";
}

async function readAiderPatchIfPresent(
  ...roots: string[]
): Promise<{ kind: "unified_diff" | "git_patch"; content: string; fileCount?: number } | undefined> {
  for (const root of roots) {
    for (const candidate of AIDER_PATCH_CANDIDATES) {
      const patchPath = path.join(root, candidate);
      try {
        const content = await fs.readFile(patchPath, "utf8");
        if (content.trim()) {
          const fileCount = countPatchFiles(content);
          return {
            kind: candidate.endsWith(".git.patch") ? "git_patch" : "unified_diff",
            content,
            ...(fileCount === undefined ? {} : { fileCount }),
          };
        }
      } catch {
        // Optional audit artifact: absence means the adapter may still have edited run-temp files.
      }
    }
  }
  return undefined;
}

function buildAiderSourcePatchIfChanged(input: {
  relPath: string;
  originalSource: string;
  currentSource: string;
}): { kind: "git_patch"; content: string; fileCount: number } | undefined {
  if (input.currentSource === input.originalSource) {
    return undefined;
  }
  const beforeLines = splitPatchLines(input.originalSource);
  const afterLines = splitPatchLines(input.currentSource);
  return {
    kind: "git_patch",
    fileCount: 1,
    content: [
      `diff --git a/${input.relPath} b/${input.relPath}`,
      `--- a/${input.relPath}`,
      `+++ b/${input.relPath}`,
      `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
      ...beforeLines.map((line) => `-${line}`),
      ...afterLines.map((line) => `+${line}`),
      "",
    ].join("\n"),
  };
}

function splitPatchLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline ? withoutFinalNewline.split("\n") : [""];
}

function toPatchRelPath(repositoryRootRelPath: string, sourceFilename: string): string {
  return repositoryRootRelPath === "." ? sourceFilename : path.posix.join(repositoryRootRelPath, sourceFilename);
}

function countPatchFiles(content: string): number | undefined {
  const matches = content.match(/^diff --git /gmu);
  return matches?.length;
}

function normalizeAiderRepositoryRoot(value: string | undefined): string {
  const normalized = (value?.trim() || ".").replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (!normalized || normalized === ".") {
    return ".";
  }
  if (path.posix.isAbsolute(normalized) || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Aider adapter repository path must stay inside the run-temp workspace.");
  }
  return normalized.replace(/\/+$/u, "") || ".";
}
