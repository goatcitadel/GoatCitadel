import type { CodeModeRunExecutionBackendRef, CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../config.js";
import {
  CODE_MODE_AIDER_ADAPTER_ID,
  CODE_MODE_DOCKER_BACKEND_ID,
  CODE_MODE_HOST_BACKEND_ID,
  buildCodeModeRunExecutionBackendRef,
} from "./code-mode-execution-backends.js";
import {
  prepareCodeModeSandboxLaunch,
  type CodeModeSandboxLaunchInput,
  type PreparedCodeModeSandboxLaunch,
} from "./code-mode-sandbox-runner.js";

export interface CodeModeExecutionBackendLaunchInput extends CodeModeSandboxLaunchInput {
  sandbox: CodeModeSandboxMetadata;
}

export interface CodeModeExecutionBackendRunner {
  readonly backend: CodeModeRunExecutionBackendRef;
  prepareLaunch(input: CodeModeExecutionBackendLaunchInput): Promise<PreparedCodeModeSandboxLaunch>;
}

export type PrepareHostCodeModeLaunch = typeof prepareCodeModeSandboxLaunch;

export class CodeModeExecutionBackendUnavailableError extends Error {
  public readonly code = "CODE_MODE_EXECUTION_BACKEND_UNAVAILABLE";

  public constructor(message: string) {
    super(message);
    this.name = "CodeModeExecutionBackendUnavailableError";
  }
}

export function createCodeModeExecutionBackendRunner(input: {
  sandbox: CodeModeSandboxMetadata;
  sandboxConfig: CodeModeSandboxConfig;
  executionBackend?: CodeModeRunExecutionBackendRef;
  prepareHostLaunch?: PrepareHostCodeModeLaunch;
}): CodeModeExecutionBackendRunner {
  const executionBackend = input.executionBackend ?? buildCodeModeRunExecutionBackendRef(input.sandbox);
  if (executionBackend.backendId !== CODE_MODE_HOST_BACKEND_ID) {
    throw new CodeModeExecutionBackendUnavailableError(buildUnavailableBackendMessage(executionBackend));
  }
  return {
    backend: executionBackend,
    prepareLaunch: async (launchInput) =>
      (input.prepareHostLaunch ?? prepareCodeModeSandboxLaunch)(
        input.sandboxConfig,
        {
          runId: launchInput.runId,
          nodePath: launchInput.nodePath,
          harnessPath: launchInput.harnessPath,
          runTempRoot: launchInput.runTempRoot,
          heapMb: launchInput.heapMb,
          env: launchInput.env,
        },
        { metadata: launchInput.sandbox },
      ),
  };
}

function buildUnavailableBackendMessage(executionBackend: CodeModeRunExecutionBackendRef): string {
  if (executionBackend.backendId === CODE_MODE_DOCKER_BACKEND_ID) {
    return "Docker Code Mode execution backend is preview-only and is not callable yet.";
  }
  if (executionBackend.backendId === CODE_MODE_AIDER_ADAPTER_ID) {
    return "Aider Code Mode adapter is preview-only and is not callable yet.";
  }
  return `Code Mode execution backend ${executionBackend.backendId} is not callable.`;
}
