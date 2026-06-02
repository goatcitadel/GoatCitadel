import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../../config.js";

export const CODE_MODE_SANDBOX_RUNNER_ID = "goatcitadel.best-effort-host";
export const CODE_MODE_SANDBOX_RUNNER_VERSION = "0.2.0";
export const CODE_MODE_SANDBOX_ISOLATION_PROFILE = "best_effort_host/temp_only/no_network";
export const CODE_MODE_HOSTILE_SANDBOX_CANARIES = [
  "outside_root_read_denied",
  "outside_root_write_denied",
  "network_denied",
  "env_secret_absent",
  "symlink_path_traversal_denied",
  "process_job_limits_enforced",
  "artifact_hash_integrity",
  "fail_closed_required_mode",
] as const satisfies NonNullable<CodeModeSandboxMetadata["hostileSandboxClaim"]>["requiredCanaries"];
export const CODE_MODE_HOSTILE_SANDBOX_PLATFORMS = ["linux", "darwin", "win32"] as const;

export type CodeModeSandboxPlatform = CodeModeSandboxMetadata["platform"];
export type CodeModeHostileSandboxClaimMetadata = NonNullable<CodeModeSandboxMetadata["hostileSandboxClaim"]>;
export type CodeModeHostileSandboxPlatformProof = CodeModeHostileSandboxClaimMetadata["platformProof"][number];

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
  transport: "node_ipc" | "stdio_jsonrpc";
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
    hostileSandboxClaim: buildHostileSandboxClaimMetadata(input.platform),
    failClosedReason:
      available || !input.config.required ? undefined : buildFailClosedReason(input.platform, checksFailed),
    advisoryUnsandboxedReason:
      available || input.config.required ? undefined : buildAdvisoryUnsandboxedReason(input.platform, checksFailed),
  };
}

export function buildHostileSandboxClaimMetadata(
  platform: CodeModeSandboxMetadata["platform"],
  proofs: CodeModeHostileSandboxPlatformProof[] = [],
): CodeModeHostileSandboxClaimMetadata {
  const platformProof = CODE_MODE_HOSTILE_SANDBOX_PLATFORMS.map((candidate) => {
    const proof = proofs.find((item) => item.platform === candidate);
    return (
      proof ?? {
        platform: candidate,
        status: "missing" as const,
        checksPassed: [],
        checksFailed: [...CODE_MODE_HOSTILE_SANDBOX_CANARIES],
      }
    );
  });
  const publicClaimAllowed = platformProof.every(
    (proof) =>
      proof.status === "pass" &&
      proof.checksFailed.length === 0 &&
      CODE_MODE_HOSTILE_SANDBOX_CANARIES.every((canary) => proof.checksPassed.includes(canary)),
  );
  const claimStatus = publicClaimAllowed
    ? "promoted"
    : platformProof.some((proof) => proof.status === "fail")
      ? "blocked"
      : "not_promoted";
  const currentPlatformProof = platformProof.find((proof) => proof.platform === platform);
  const proofBlockers = platformProof
    .filter((proof) => proof.status !== "pass")
    .map((proof) => `${proof.platform} hostile sandbox proof is ${proof.status}.`);
  return {
    claimStatus,
    publicClaimAllowed,
    requiredCanaries: [...CODE_MODE_HOSTILE_SANDBOX_CANARIES],
    platformProof: [...platformProof],
    blockers: publicClaimAllowed
      ? []
      : [
          ...(currentPlatformProof?.status === "pass"
            ? []
            : [`Current platform hostile sandbox proof is ${currentPlatformProof?.status ?? "missing"}.`]),
          "Native hostile-code sandboxing is not promoted until Linux Firejail, macOS Seatbelt, and Windows AppContainer all pass the same adversarial canaries.",
          "Docker may add isolation, but it is not sufficient for the hostile-code claim.",
          ...proofBlockers,
        ],
    governance: [
      "Code Mode v1 remains governed trusted-code execution with explicit approval and immutable artifact checks.",
      "Fail-closed required mode must stay separate from any public hostile-code sandbox claim.",
    ],
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
    transport: "node_ipc",
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

function buildAdvisoryUnsandboxedReason(platform: CodeModeSandboxPlatform, checksFailed: string[]): string {
  const reason = checksFailed.join(", ");
  return `Host isolation unavailable on ${platform}; running advisory trusted-code mode: ${reason}.`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
