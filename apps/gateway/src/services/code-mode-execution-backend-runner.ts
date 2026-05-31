import type { CodeModeRunExecutionBackendRef, CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeAiderAdapterConfig, CodeModeDockerBackendConfig, CodeModeSandboxConfig } from "../config.js";
import {
  executeCodeModeAiderAdapter,
  type CodeModeAiderExecutionInput,
  type CodeModeAiderExecutionResult,
} from "./code-mode-aider-execution.js";
import {
  CODE_MODE_AIDER_ADAPTER_ID,
  CODE_MODE_DOCKER_BACKEND_ID,
  CODE_MODE_HOST_BACKEND_ID,
  buildCodeModeRunExecutionBackendRef,
} from "./code-mode-execution-backends.js";
import { prepareCodeModeDockerLaunch, type CodeModeDockerLaunchOptions } from "./code-mode-docker-launch.js";
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
  readonly mode: "child_harness" | "aider_audit";
  prepareLaunch(input: CodeModeExecutionBackendLaunchInput): Promise<PreparedCodeModeSandboxLaunch>;
  executeAiderAdapter?(
    input: Omit<CodeModeAiderExecutionInput, "aiderAdapter" | "dockerBackend">,
  ): Promise<CodeModeAiderExecutionResult>;
}

export type PrepareHostCodeModeLaunch = typeof prepareCodeModeSandboxLaunch;
export type PrepareDockerCodeModeLaunch = typeof prepareCodeModeDockerLaunch;
export type ExecuteAiderCodeModeAdapter = typeof executeCodeModeAiderAdapter;

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
  dockerLaunch?: CodeModeDockerLaunchOptions & { enabled: boolean };
  dockerBackendConfig?: CodeModeDockerBackendConfig;
  prepareDockerLaunch?: PrepareDockerCodeModeLaunch;
  aiderAdapter?: CodeModeAiderAdapterConfig;
  executeAiderAdapter?: ExecuteAiderCodeModeAdapter;
}): CodeModeExecutionBackendRunner {
  const executionBackend = input.executionBackend ?? buildCodeModeRunExecutionBackendRef(input.sandbox);
  if (executionBackend.backendId === CODE_MODE_DOCKER_BACKEND_ID) {
    const dockerLaunch = input.dockerLaunch;
    if (!dockerLaunch?.enabled) {
      throw new CodeModeExecutionBackendUnavailableError(buildUnavailableBackendMessage(executionBackend));
    }
    return {
      backend: executionBackend,
      mode: "child_harness",
      prepareLaunch: async (launchInput) => ({
        metadata: launchInput.sandbox,
        launch: await (input.prepareDockerLaunch ?? prepareCodeModeDockerLaunch)(launchInput, dockerLaunch),
      }),
    };
  }
  if (executionBackend.backendId === CODE_MODE_AIDER_ADAPTER_ID) {
    const aiderAdapter = input.aiderAdapter;
    const dockerBackendConfig = input.dockerBackendConfig;
    if (!aiderAdapter?.enabled || !aiderAdapter.image?.trim() || !dockerBackendConfig?.enabled) {
      throw new CodeModeExecutionBackendUnavailableError(buildUnavailableBackendMessage(executionBackend));
    }
    return {
      backend: executionBackend,
      mode: "aider_audit",
      prepareLaunch: async () => {
        throw new CodeModeExecutionBackendUnavailableError(
          "Aider Code Mode adapter does not launch the child harness; use executeAiderAdapter instead.",
        );
      },
      executeAiderAdapter: async (adapterInput) =>
        (input.executeAiderAdapter ?? executeCodeModeAiderAdapter)({
          ...adapterInput,
          aiderAdapter,
          dockerBackend: dockerBackendConfig,
        }),
    };
  }
  if (executionBackend.backendId !== CODE_MODE_HOST_BACKEND_ID) {
    throw new CodeModeExecutionBackendUnavailableError(buildUnavailableBackendMessage(executionBackend));
  }
  return {
    backend: executionBackend,
    mode: "child_harness",
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
    return "Aider Code Mode adapter is not callable with the current Docker and adapter configuration.";
  }
  return `Code Mode execution backend ${executionBackend.backendId} is not callable.`;
}
