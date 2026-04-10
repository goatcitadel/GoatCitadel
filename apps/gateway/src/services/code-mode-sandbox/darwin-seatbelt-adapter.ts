import fs from "node:fs/promises";
import path from "node:path";
import type { CodeModeSandboxConfig } from "../../config.js";
import {
  assertLaunchable,
  buildCommonProbeChecks,
  buildSandboxMetadata,
  rejectUnsafeProfilePath,
  type CodeModeHostSandboxAdapter,
  type CodeModeSandboxAdapterDependencies,
  type CodeModeSandboxLaunchInput,
  type CodeModeSandboxLaunchSpec,
} from "./types.js";

export class DarwinSeatbeltSandboxAdapter implements CodeModeHostSandboxAdapter {
  public readonly adapterId = "darwin-seatbelt";
  public readonly platform = "darwin" as const;

  public constructor(private readonly dependencies: CodeModeSandboxAdapterDependencies) {}

  public probe(config: CodeModeSandboxConfig) {
    const checks = buildCommonProbeChecks(config);
    checks.checksPassed.push("darwin_adapter_present");

    const sandboxExecPath = this.dependencies.resolveCommand("sandbox-exec", this.platform);
    if (sandboxExecPath) {
      checks.checksPassed.push(
        "darwin_sandbox_exec_present",
        "darwin_sandbox_exec_deprecated_but_available",
        "network_isolation_enforced",
        "temp_workspace_enforced",
        "privilege_reduction_enforced",
      );
    } else {
      checks.checksFailed.push("darwin_sandbox_exec_missing");
    }

    return buildSandboxMetadata({
      platform: this.platform,
      config,
      checksPassed: checks.checksPassed,
      checksFailed: checks.checksFailed,
    });
  }

  public async prepareLaunch(input: CodeModeSandboxLaunchInput): Promise<CodeModeSandboxLaunchSpec> {
    const sandboxExecPath = this.dependencies.resolveCommand("sandbox-exec", this.platform);
    assertLaunchable(
      buildSandboxMetadata({
        platform: this.platform,
        config: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: Boolean(sandboxExecPath),
        },
        checksPassed: sandboxExecPath ? ["darwin_sandbox_exec_present"] : [],
        checksFailed: sandboxExecPath ? [] : ["darwin_sandbox_exec_missing"],
      }),
    );
    if (!sandboxExecPath) {
      throw new Error("Code Mode macOS sandbox is unavailable: darwin_sandbox_exec_missing.");
    }

    await fs.mkdir(input.runTempRoot, { recursive: true });
    const profilePath = path.join(input.runTempRoot, "code-mode-seatbelt.sb");
    await fs.writeFile(profilePath, buildSeatbeltProfile(input), "utf8");

    return {
      executable: sandboxExecPath,
      args: ["-f", profilePath, input.nodePath, `--max-old-space-size=${input.heapMb}`, input.harnessPath],
      cwd: input.runTempRoot,
      env: input.env,
      shell: false,
      enforcedWorkspaceRoot: input.runTempRoot,
      generatedArtifacts: [profilePath],
      advisoryUnsandboxed: false,
    };
  }
}

function buildSeatbeltProfile(input: CodeModeSandboxLaunchInput): string {
  rejectUnsafeProfilePath(input.runTempRoot);
  rejectUnsafeProfilePath(input.harnessPath);
  rejectUnsafeProfilePath(input.nodePath);
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read* ${literal(input.nodePath)})`,
    `(allow file-read* ${literal(input.harnessPath)})`,
    '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library"))',
    `(allow file-read* (subpath ${quoteSeatbeltString(input.runTempRoot)}))`,
    `(allow file-write* (subpath ${quoteSeatbeltString(input.runTempRoot)}))`,
    '(allow file-write* (literal "/dev/null"))',
    "",
  ].join("\n");
}

function literal(value: string): string {
  return `(literal ${quoteSeatbeltString(value)})`;
}

function quoteSeatbeltString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
