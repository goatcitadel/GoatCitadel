import path from "node:path";
import { CODE_MODE_AIDER_ADAPTER_ID } from "./code-mode-execution-backends.js";

export const CODE_MODE_AIDER_DEFAULT_COMMAND = "aider";
export const CODE_MODE_AIDER_MESSAGE_FILE = "aider/request.md";

export interface CodeModeAiderAdapterPlanInput {
  runId: string;
  repositoryRootRelPath?: string;
  model?: string;
  command?: string;
}

export interface CodeModeAiderAdapterInvocationPlan {
  contractVersion: 1;
  adapterId: typeof CODE_MODE_AIDER_ADAPTER_ID;
  runId: string;
  repository: {
    rootRelPath: string;
  };
  command: {
    executable: string;
    argv: string[];
    argvRedacted: string[];
    cwdRelPath: string;
    messageFileRelPath: typeof CODE_MODE_AIDER_MESSAGE_FILE;
  };
  replay: {
    replaySafe: false;
    policy: "audit_only";
    reason: string;
  };
}

export function buildCodeModeAiderAdapterInvocationPlan(
  input: CodeModeAiderAdapterPlanInput,
): CodeModeAiderAdapterInvocationPlan {
  const runId = input.runId.trim();
  if (!runId) {
    throw new Error("Aider adapter runId is required.");
  }
  const repositoryRootRelPath = normalizeSafeRelativePath(input.repositoryRootRelPath ?? ".");
  const executable = normalizeExecutable(input.command ?? CODE_MODE_AIDER_DEFAULT_COMMAND);
  const argv = [
    executable,
    "--yes",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--message-file",
    CODE_MODE_AIDER_MESSAGE_FILE,
    ...(input.model?.trim() ? ["--model", input.model.trim()] : []),
  ];

  return {
    contractVersion: 1,
    adapterId: CODE_MODE_AIDER_ADAPTER_ID,
    runId,
    repository: {
      rootRelPath: repositoryRootRelPath,
    },
    command: {
      executable,
      argv,
      argvRedacted: argv,
      cwdRelPath: repositoryRootRelPath,
      messageFileRelPath: CODE_MODE_AIDER_MESSAGE_FILE,
    },
    replay: {
      replaySafe: false,
      policy: "audit_only",
      reason: "Aider workspace mutation replay requires a separate side-effect runner.",
    },
  };
}

function normalizeExecutable(value: string): string {
  const executable = value.trim();
  if (!executable) {
    throw new Error("Aider adapter command is required.");
  }
  if (/[\r\n\0]/.test(executable)) {
    throw new Error("Aider adapter command contains unsafe characters.");
  }
  return executable;
}

function normalizeSafeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized) {
    throw new Error("Aider adapter repository path is required.");
  }
  if (normalized.includes("\0") || normalized.includes("\r") || normalized.includes("\n")) {
    throw new Error("Aider adapter repository path contains unsafe characters.");
  }
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Aider adapter repository path must stay inside the Code Mode run workspace.");
  }
  return normalized === "./" ? "." : normalized.replace(/\/+$/u, "") || ".";
}
