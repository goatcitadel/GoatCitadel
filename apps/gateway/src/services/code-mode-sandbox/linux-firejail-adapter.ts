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

export class LinuxFirejailSandboxAdapter implements CodeModeHostSandboxAdapter {
  public readonly adapterId = "linux-firejail";
  public readonly platform = "linux" as const;

  public constructor(private readonly dependencies: CodeModeSandboxAdapterDependencies) {}

  public probe(config: CodeModeSandboxConfig) {
    const checks = buildCommonProbeChecks(config);
    checks.checksPassed.push("linux_adapter_present");

    const firejailPath = this.dependencies.resolveCommand("firejail", this.platform);
    if (firejailPath) {
      checks.checksPassed.push(
        "linux_firejail_present",
        "linux_firejail_profile_intent_present",
        "linux_namespace_flags_intended",
        "linux_seccomp_flag_intended",
        "network_isolation_flag_intended",
        "temp_workspace_private_home_intended",
        "privilege_reduction_flags_intended",
      );
    } else {
      checks.checksFailed.push("linux_firejail_missing");
    }

    return buildSandboxMetadata({
      platform: this.platform,
      config,
      checksPassed: checks.checksPassed,
      checksFailed: checks.checksFailed,
    });
  }

  public async prepareLaunch(input: CodeModeSandboxLaunchInput): Promise<CodeModeSandboxLaunchSpec> {
    const firejailPath = this.dependencies.resolveCommand("firejail", this.platform);
    assertLaunchable(
      buildSandboxMetadata({
        platform: this.platform,
        config: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: Boolean(firejailPath),
        },
        checksPassed: firejailPath ? ["linux_firejail_present"] : [],
        checksFailed: firejailPath ? [] : ["linux_firejail_missing"],
      }),
    );
    if (!firejailPath) {
      throw new Error("Code Mode Linux sandbox is unavailable: linux_firejail_missing.");
    }

    await fs.mkdir(input.runTempRoot, { recursive: true });
    const profilePath = path.join(input.runTempRoot, "code-mode-firejail.profile");
    await fs.writeFile(profilePath, buildFirejailProfile(input.runTempRoot), "utf8");

    return {
      transport: "node_ipc",
      executable: firejailPath,
      args: [
        "--quiet",
        `--profile=${profilePath}`,
        "--net=none",
        "--private-tmp",
        `--private=${input.runTempRoot}`,
        "--seccomp",
        "--caps.drop=all",
        "--nonewprivs",
        "--",
        input.nodePath,
        `--max-old-space-size=${input.heapMb}`,
        input.harnessPath,
      ],
      cwd: input.runTempRoot,
      env: input.env,
      shell: false,
      enforcedWorkspaceRoot: input.runTempRoot,
      generatedArtifacts: [profilePath],
      advisoryUnsandboxed: false,
    };
  }
}

// Test-only export for linux-firejail-adapter.security.test.ts.
export const __buildFirejailProfileForTests = buildFirejailProfile;

function buildFirejailProfile(runTempRoot: string): string {
  rejectUnsafeProfilePath(runTempRoot);
  const quotedRunTempRoot = quoteFirejailPath(runTempRoot);
  // SECURITY (codex finding #18): The previous profile used
  // `read-only /` + a writable run-temp dir. That blocked WRITES to the
  // host filesystem but permitted READS of the entire host fs. Because
  // the guest runs inside Node's `vm` (which the code itself documents
  // as not a security sandbox), a malicious Code Mode payload could
  // escape to Node APIs and `fs.readFileSync('/etc/passwd', '...')` to
  // exfiltrate host configuration, workspace data, or secrets.
  //
  // Launch uses `--private=${runTempRoot}` so Firejail backs the private
  // home with the generated run directory. The profile must not also emit
  // a bare `private` directive, because Firejail treats those as distinct
  // private modes. The remaining directives keep the launched process on a
  // no-network, reduced-privilege profile with the run root explicitly
  // writable. Code Mode remains a governed trusted-code surface, not
  // hostile-code sandboxing; `vm` is not a security boundary, and this is
  // not a claim that every system path is invisible to the guest.
  return [
    "# GoatCitadel Code Mode host sandbox profile.",
    "quiet",
    "private-dev",
    "private-tmp",
    "net none",
    "nonewprivs",
    "caps.drop all",
    "seccomp",
    `whitelist ${quotedRunTempRoot}`,
    `read-write ${quotedRunTempRoot}`,
    `noblacklist ${quotedRunTempRoot}`,
    "",
  ].join("\n");
}

function quoteFirejailPath(value: string): string {
  if (!/[\s"'\\]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
