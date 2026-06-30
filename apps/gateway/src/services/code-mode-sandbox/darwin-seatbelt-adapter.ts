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
      transport: "node_ipc",
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

// Test-only export for darwin-seatbelt-adapter.security.test.ts.
export const __buildSeatbeltProfileForTests = buildSeatbeltProfile;

// Package-manager prefixes where a non-bundled Node keeps its linked dylibs and
// data (e.g. Homebrew's `icu4c` keg under `<prefix>/opt`). The narrowed system
// read scope intentionally drops bare `/usr`, which removes `/usr/local`. When
// Code Mode runs under such a Node — dev/source installs, where
// `process.execPath` resolves under one of these prefixes — dyld must still be
// able to read the runtime's dependency tree at startup or the harness never
// launches. We grant the owning prefix ONLY when the resolved Node actually
// lives under it, so a hardened install with a bundled/static Node keeps the
// tight profile.
const RUNTIME_DEPENDENCY_PREFIXES = ["/usr/local", "/opt/homebrew"] as const;

function runtimeDependencyReadGrant(nodePath: string): string | null {
  const match = RUNTIME_DEPENDENCY_PREFIXES.find(
    (prefix) => nodePath === prefix || nodePath.startsWith(`${prefix}/`),
  );
  return match ? `(allow file-read* (subpath ${quoteSeatbeltString(match)}))` : null;
}

function buildSeatbeltProfile(input: CodeModeSandboxLaunchInput): string {
  rejectUnsafeProfilePath(input.runTempRoot);
  rejectUnsafeProfilePath(input.harnessPath);
  rejectUnsafeProfilePath(input.nodePath);
  const dependencyGrant = runtimeDependencyReadGrant(input.nodePath);
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read* ${literal(input.nodePath)})`,
    `(allow file-read* ${literal(input.harnessPath)})`,
    // SECURITY (#145): restrict read scope to the runtime essentials Node needs to
    // start, instead of broad `/usr` + `/Library`. `/System` carries the OS
    // frameworks and the dyld shared cache; `/usr/lib` carries dyld and the system
    // dylibs; `/usr/share` carries ICU/zoneinfo/locale data. The broad `/Library`
    // tree (third-party + admin-installed software, incl. `/Library/Keychains` and
    // `/Library/Application Support`) and bare `/usr` (which re-exposes `/usr/local`
    // operator secrets/configs) are not needed by a minimal Node runtime, so they
    // are no longer readable from inside the sandbox. A Node that resolves under a
    // package-manager prefix gets that prefix granted conditionally below so dyld
    // can load its linked dylibs. `/bin` and `/sbin` are retained (OS binaries, no
    // secret value) pending macOS canary confirmation that they can also be
    // dropped; the hostile-canary proof lane is the verification path for any
    // further narrowing.
    '(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/bin") (subpath "/sbin"))',
    ...(dependencyGrant ? [dependencyGrant] : []),
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
