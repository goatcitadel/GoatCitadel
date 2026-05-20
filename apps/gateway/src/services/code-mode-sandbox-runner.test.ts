import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeSandboxConfig } from "../config.js";
import {
  assertCodeModeSandboxAvailable,
  prepareCodeModeSandboxLaunch,
  resolveCodeModeSandboxMetadata,
  type HostSandboxAdapterSelectionOptions,
} from "./code-mode-sandbox-runner.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("code-mode-sandbox-runner", () => {
  it("returns fail-closed metadata when best-effort host isolation is disabled", () => {
    const metadata = resolveCodeModeSandboxMetadata(baseConfig({ required: true, bestEffortHostEnabled: false }), {
      platform: "linux",
      resolveCommand: commandResolver({ firejail: "/usr/bin/firejail" }),
    });

    expect(metadata).toMatchObject({
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.2.0",
      isolationProfile: "best_effort_host/temp_only/no_network",
      platform: "linux",
      required: true,
      available: false,
    });
    expect(metadata.checksPassed).toContain("mode_best_effort_host");
    expect(metadata.checksPassed).toContain("linux_adapter_present");
    expect(metadata.checksPassed).toContain("linux_firejail_present");
    expect(metadata.checksFailed).toContain("best_effort_host_disabled");
    expect(metadata.failClosedReason).toContain("best_effort_host_disabled");
  });

  it("throws when required isolation is unavailable", () => {
    const metadata = resolveCodeModeSandboxMetadata(baseConfig({ required: true, bestEffortHostEnabled: true }), {
      platform: "linux",
      resolveCommand: commandResolver({}),
    });

    expect(metadata.checksFailed).toContain("linux_firejail_missing");
    expect(() => assertCodeModeSandboxAvailable(metadata)).toThrow(metadata.failClosedReason);
  });

  it("does not throw for advisory-only unavailable isolation metadata", () => {
    const metadata = resolveCodeModeSandboxMetadata(baseConfig({ required: false, bestEffortHostEnabled: true }), {
      platform: "darwin",
      resolveCommand: commandResolver({}),
    });

    expect(metadata).toMatchObject({ available: false, required: false });
    expect(metadata.checksFailed).toContain("darwin_sandbox_exec_missing");
    expect(metadata.failClosedReason).toBeUndefined();
    expect(metadata.advisoryUnsandboxedReason).toContain("Host isolation unavailable");
    expect(() => assertCodeModeSandboxAvailable(metadata)).not.toThrow();
  });

  it("returns an explicit unsandboxed advisory launch spec only when isolation is advisory", async () => {
    const root = await createTempRoot();
    const metadata = resolveCodeModeSandboxMetadata(baseConfig({ required: false, bestEffortHostEnabled: true }), {
      platform: "linux",
      resolveCommand: commandResolver({}),
    });

    const prepared = await prepareCodeModeSandboxLaunch(
      baseConfig({ required: false, bestEffortHostEnabled: true }),
      launchInput(root),
      {
        platform: "linux",
        resolveCommand: commandResolver({}),
        metadata,
      },
    );

    expect(prepared.metadata.available).toBe(false);
    expect(prepared.launch).toMatchObject({
      executable: process.execPath,
      args: [`--max-old-space-size=64`, path.join(root, "harness.mjs")],
      cwd: path.join(root, "run"),
      advisoryUnsandboxed: true,
    });
  });

  it("does not prepare an unsandboxed launch spec when required isolation is unavailable", async () => {
    const root = await createTempRoot();
    const metadata = resolveCodeModeSandboxMetadata(baseConfig({ required: true, bestEffortHostEnabled: true }), {
      platform: "linux",
      resolveCommand: commandResolver({}),
    });

    await expect(
      prepareCodeModeSandboxLaunch(baseConfig({ required: true, bestEffortHostEnabled: true }), launchInput(root), {
        platform: "linux",
        resolveCommand: commandResolver({}),
        metadata,
      }),
    ).rejects.toThrow(metadata.failClosedReason);
  });

  it("rejects stale available metadata before launch when availability downgrades", async () => {
    const root = await createTempRoot();
    const staleMetadata = resolveCodeModeSandboxMetadata(baseConfig({ required: true, bestEffortHostEnabled: true }), {
      platform: "linux",
      resolveCommand: commandResolver({ firejail: "/usr/bin/firejail" }),
    });

    await expect(
      prepareCodeModeSandboxLaunch(baseConfig({ required: true, bestEffortHostEnabled: true }), launchInput(root), {
        platform: "linux",
        resolveCommand: commandResolver({}),
        metadata: staleMetadata,
      }),
    ).rejects.toThrow("Code Mode sandbox posture changed before launch");
  });

  it("rejects stale available metadata before launch when the probed posture changes but stays available", async () => {
    const root = await createTempRoot();
    const approvedMetadata = {
      ...resolveCodeModeSandboxMetadata(baseConfig({ required: true, bestEffortHostEnabled: true }), {
        platform: "linux",
        resolveCommand: commandResolver({ firejail: "/usr/bin/firejail" }),
      }),
      runnerVersion: "0.1.0-approved",
    };

    await expect(
      prepareCodeModeSandboxLaunch(baseConfig({ required: true, bestEffortHostEnabled: true }), launchInput(root), {
        platform: "linux",
        resolveCommand: commandResolver({ firejail: "/usr/bin/firejail" }),
        metadata: approvedMetadata,
      }),
    ).rejects.toThrow("Code Mode sandbox posture changed before launch at runnerVersion");
  });

  it("selects the Linux firejail adapter and reports profile intent checks when available", async () => {
    const root = await createTempRoot();
    const options: HostSandboxAdapterSelectionOptions = {
      platform: "linux",
      resolveCommand: commandResolver({ firejail: "/usr/bin/firejail" }),
    };

    const metadata = resolveCodeModeSandboxMetadata(
      baseConfig({ required: true, bestEffortHostEnabled: true }),
      options,
    );
    const prepared = await prepareCodeModeSandboxLaunch(
      baseConfig({ required: true, bestEffortHostEnabled: true }),
      launchInput(root),
      {
        ...options,
        metadata,
      },
    );

    expect(metadata).toMatchObject({ platform: "linux", available: true });
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining([
        "linux_firejail_present",
        "linux_firejail_profile_intent_present",
        "linux_namespace_flags_intended",
        "linux_seccomp_flag_intended",
        "network_isolation_flag_intended",
        "temp_workspace_private_home_intended",
        "privilege_reduction_flags_intended",
      ]),
    );
    expect(prepared.launch.executable).toBe("/usr/bin/firejail");
    expect(prepared.launch.args).toEqual(expect.arrayContaining(["--net=none", "--seccomp", "--caps.drop=all"]));
    expect(prepared.launch.advisoryUnsandboxed).toBe(false);
    await expect(fs.stat(path.join(root, "run", "code-mode-firejail.profile"))).resolves.toBeTruthy();
  });

  it("selects the macOS seatbelt adapter and reports sandbox-exec caveats", async () => {
    const root = await createTempRoot();
    const options: HostSandboxAdapterSelectionOptions = {
      platform: "darwin",
      resolveCommand: commandResolver({ "sandbox-exec": "/usr/bin/sandbox-exec" }),
    };

    const metadata = resolveCodeModeSandboxMetadata(
      baseConfig({ required: true, bestEffortHostEnabled: true }),
      options,
    );
    const prepared = await prepareCodeModeSandboxLaunch(
      baseConfig({ required: true, bestEffortHostEnabled: true }),
      launchInput(root),
      {
        ...options,
        metadata,
      },
    );

    expect(metadata).toMatchObject({ platform: "darwin", available: true });
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining([
        "darwin_sandbox_exec_present",
        "darwin_sandbox_exec_deprecated_but_available",
        "network_isolation_enforced",
        "temp_workspace_enforced",
        "privilege_reduction_enforced",
      ]),
    );
    expect(prepared.launch.executable).toBe("/usr/bin/sandbox-exec");
    expect(prepared.launch.args.slice(0, 2)).toEqual(["-f", path.join(root, "run", "code-mode-seatbelt.sb")]);
  });

  it("selects the Windows AppContainer adapter but fails closed while Node IPC is not preserved", async () => {
    const root = await createTempRoot();
    const options: HostSandboxAdapterSelectionOptions = {
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: commandResolver({
        "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    };

    const metadata = resolveCodeModeSandboxMetadata(
      baseConfig({ required: true, bestEffortHostEnabled: true }),
      options,
    );
    expect(metadata).toMatchObject({ platform: "win32", available: false });
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining(["win32_powershell_present", "win32_appcontainer_prerequisites_available"]),
    );
    expect(metadata.checksFailed).toEqual(
      expect.arrayContaining([
        "win32_node_ipc_not_preserved",
        "network_isolation_not_enforced",
        "temp_workspace_not_enforced",
        "privilege_reduction_not_enforced",
        "windows_job_limits_not_enforced",
      ]),
    );
    await expect(
      prepareCodeModeSandboxLaunch(baseConfig({ required: true, bestEffortHostEnabled: true }), launchInput(root), {
        ...options,
        metadata,
      }),
    ).rejects.toThrow("win32_node_ipc_not_preserved");
    await expect(fs.stat(path.join(root, "run", "code-mode-appcontainer-launcher.ps1"))).rejects.toThrow();
  });

  it("falls back to advisory unsandboxed Windows launch only when sandbox is not required", async () => {
    const root = await createTempRoot();
    const options: HostSandboxAdapterSelectionOptions = {
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: commandResolver({
        "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    };

    const prepared = await prepareCodeModeSandboxLaunch(
      baseConfig({ required: false, bestEffortHostEnabled: true }),
      launchInput(root),
      options,
    );

    expect(prepared.metadata).toMatchObject({ platform: "win32", available: false, required: false });
    expect(prepared.metadata.checksFailed).toEqual(
      expect.arrayContaining([
        "win32_node_ipc_not_preserved",
        "network_isolation_not_enforced",
        "temp_workspace_not_enforced",
        "privilege_reduction_not_enforced",
        "windows_job_limits_not_enforced",
      ]),
    );
    expect(prepared.launch).toMatchObject({
      executable: process.execPath,
      advisoryUnsandboxed: true,
      enforcedWorkspaceRoot: path.join(root, "run"),
    });
  });

  it("reports unavailable metadata for unsupported platforms", () => {
    const metadata = resolveCodeModeSandboxMetadata(baseConfig({ required: true, bestEffortHostEnabled: true }), {
      platform: "freebsd",
    });

    expect(metadata).toMatchObject({ platform: "unknown", available: false });
    expect(metadata.checksFailed).toContain("unknown_adapter_unavailable");
  });
});

function baseConfig(overrides?: Partial<CodeModeSandboxConfig>): CodeModeSandboxConfig {
  return {
    mode: "best_effort_host",
    required: overrides?.required ?? true,
    bestEffortHostEnabled: overrides?.bestEffortHostEnabled ?? true,
  };
}

function commandResolver(commands: Record<string, string>) {
  return (command: string) => commands[command];
}

function launchInput(root: string) {
  return {
    runId: "run",
    nodePath: process.execPath,
    harnessPath: path.join(root, "harness.mjs"),
    runTempRoot: path.join(root, "run"),
    heapMb: 64,
    env: { GOATCITADEL_CODE_MODE: "1" },
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-code-mode-sandbox-"));
  tempRoots.push(root);
  return root;
}
