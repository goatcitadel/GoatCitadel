import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../../config.js";

export const CODE_MODE_SANDBOX_RUNNER_ID = "goatcitadel.best-effort-host";
export const CODE_MODE_SANDBOX_RUNNER_VERSION = "0.2.0";
export const CODE_MODE_SANDBOX_ISOLATION_PROFILE = "best_effort_host/temp_only/no_network";

export type CodeModeSandboxPlatform = CodeModeSandboxMetadata["platform"];

export type CommandResolver = (command: string, platform: CodeModeSandboxPlatform) => string | undefined;

export interface CodeModeSandboxAdapterDependencies {
  platform: CodeModeSandboxPlatform;
  resolveCommand: CommandResolver;
  osRelease: string;
}

export interface CodeModeSandboxLaunchInput {
  runId: string;
  nodePath: string;
  harnessPath: string;
  runTempRoot: string;
  heapMb: number;
  env: NodeJS.ProcessEnv;
}

export interface CodeModeSandboxLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  enforcedWorkspaceRoot: string;
  generatedArtifacts: string[];
  advisoryUnsandboxed: boolean;
}

export interface CodeModeHostSandboxAdapter {
  readonly adapterId: string;
  readonly platform: CodeModeSandboxPlatform;
  probe(config: CodeModeSandboxConfig): CodeModeSandboxMetadata;
  prepareLaunch(input: CodeModeSandboxLaunchInput): Promise<CodeModeSandboxLaunchSpec>;
}

export function normalizeSandboxPlatform(value: NodeJS.Platform | string): CodeModeSandboxPlatform {
  if (value === "linux" || value === "darwin" || value === "win32") {
    return value;
  }
  return "unknown";
}

export function buildSandboxMetadata(input: {
  platform: CodeModeSandboxPlatform;
  config: CodeModeSandboxConfig;
  checksPassed: string[];
  checksFailed: string[];
}): CodeModeSandboxMetadata {
  const checksPassed = dedupe(input.checksPassed);
  const checksFailed = dedupe(input.checksFailed);
  const available = checksFailed.length === 0;
  return {
    runnerId: CODE_MODE_SANDBOX_RUNNER_ID,
    runnerVersion: CODE_MODE_SANDBOX_RUNNER_VERSION,
    platform: input.platform,
    isolationProfile: CODE_MODE_SANDBOX_ISOLATION_PROFILE,
    required: input.config.required,
    available,
    checksPassed,
    checksFailed,
    failClosedReason: available ? undefined : buildFailClosedReason(input.platform, checksFailed),
  };
}

export function buildCommonProbeChecks(config: CodeModeSandboxConfig): {
  checksPassed: string[];
  checksFailed: string[];
} {
  const checksPassed: string[] = [];
  const checksFailed: string[] = [];
  if (config.mode === "best_effort_host") {
    checksPassed.push("mode_best_effort_host");
  } else {
    checksFailed.push("unsupported_mode");
  }
  if (config.bestEffortHostEnabled) {
    checksPassed.push("best_effort_host_enabled");
  } else {
    checksFailed.push("best_effort_host_disabled");
  }
  return { checksPassed, checksFailed };
}

export function assertLaunchable(metadata: CodeModeSandboxMetadata): void {
  if (!metadata.available) {
    throw new Error(metadata.failClosedReason ?? "Code Mode sandbox is unavailable.");
  }
}

export function buildAdvisoryUnsandboxedLaunchSpec(input: CodeModeSandboxLaunchInput): CodeModeSandboxLaunchSpec {
  return {
    executable: input.nodePath,
    args: [`--max-old-space-size=${input.heapMb}`, input.harnessPath],
    cwd: input.runTempRoot,
    env: input.env,
    shell: false,
    enforcedWorkspaceRoot: input.runTempRoot,
    generatedArtifacts: [],
    advisoryUnsandboxed: true,
  };
}

export function rejectUnsafeProfilePath(value: string): void {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("Code Mode sandbox path contains unsafe profile characters.");
  }
}

function buildFailClosedReason(platform: CodeModeSandboxPlatform, checksFailed: string[]): string {
  const reason = checksFailed.join(", ");
  return `Code Mode sandbox failed closed on ${platform}: ${reason}.`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
