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
  signal?: AbortSignal;
  spawnCommand?: typeof spawn;
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
  bundle: CodeModeAiderArtifactBundle;
}

const AIDER_RUN_ROOT_SEGMENT = "aider-live";
const AIDER_CONTAINER_ROOT = "/goatcitadel/aider-run";
const AIDER_PATCH_CANDIDATES = ["aider.patch", "aider.git.patch"];

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
  const startedAt = new Date().toISOString();
  const spawned = (input.spawnCommand ?? spawn)(command.executable, command.args, {
    cwd: runRoot,
    env: buildDockerClientEnv(process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const execution = await waitForAiderChild(spawned, input.signal);
  const finishedAt = new Date().toISOString();
  const explicitPatch = await readAiderPatchIfPresent(runRoot, repositoryRoot);
  const sourcePatch =
    explicitPatch ??
    buildAiderSourcePatchIfChanged({
      relPath: toPatchRelPath(repositoryRootRelPath, sourceFilename),
      originalSource: input.source,
      currentSource: await fs.readFile(sourcePath, "utf8"),
    });
  const patch = explicitPatch ?? sourcePatch;
  const failed = execution.exitCode !== 0;
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
    ...(failed
      ? {
          error: {
            code: "AIDER_EXIT_NONZERO",
            message: `Aider adapter exited with code ${execution.exitCode}.`,
          },
        }
      : {}),
  });

  return {
    failed,
    outcome,
    result: bundle.result,
    error: failed ? `Aider adapter exited with code ${execution.exitCode}.` : undefined,
    errorCode: failed ? "AIDER_EXIT_NONZERO" : undefined,
    errorDetails: failed ? { exitCode: execution.exitCode } : undefined,
    stdout: execution.stdout,
    stderr: execution.stderr,
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

function waitForAiderChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (!child.killed) {
        child.kill();
      }
      finish(() => reject(new Error("Aider adapter execution was aborted.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() =>
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        }),
      ),
    );
    if (signal?.aborted) {
      onAbort();
    }
  });
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
