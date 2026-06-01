import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeSandboxConfig } from "../config.js";
import { resolveCurrentCodeModeSandboxMetadata } from "./code-mode-sandbox-runner.js";
import { defaultCommandResolver } from "./code-mode-sandbox/command-resolution.js";
import { UnavailableSandboxAdapter } from "./code-mode-sandbox/unavailable-adapter.js";
import {
  assertLaunchable,
  buildAdvisoryUnsandboxedLaunchSpec,
  buildCommonProbeChecks,
  buildSandboxMetadata,
  normalizeSandboxPlatform,
  rejectUnsafeProfilePath,
  type CodeModeSandboxLaunchInput,
} from "./code-mode-sandbox/types.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalPathExt === undefined) {
    delete process.env.PATHEXT;
  } else {
    process.env.PATHEXT = originalPathExt;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("code-mode sandbox loop22 coverage", () => {
  it("resolves absolute, POSIX-style, and Windows PATHEXT command candidates", async () => {
    const binDir = await makeTempDir();
    const absoluteTool = path.join(binDir, "absolute-tool");
    const posixTool = path.join(binDir, "firejail");
    const windowsTool = path.join(binDir, "sandbox-tool.CMD");
    await fs.writeFile(absoluteTool, "", "utf8");
    await fs.writeFile(posixTool, "", "utf8");
    await fs.writeFile(windowsTool, "", "utf8");
    process.env.PATH = binDir;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(defaultCommandResolver(absoluteTool, "linux")).toBe(absoluteTool);
    expect(defaultCommandResolver(path.join(binDir, "missing-absolute"), "linux")).toBeUndefined();
    expect(defaultCommandResolver("firejail", "linux")).toBe(posixTool);
    expect(defaultCommandResolver("sandbox-tool", "win32")).toBe(windowsTool);
    expect(defaultCommandResolver("sandbox-tool.CMD", "win32")).toBe(windowsTool);
    expect(defaultCommandResolver("missing-tool", "win32")).toBeUndefined();
  });

  it("reports unavailable host adapters and preserves fail-closed metadata truth", async () => {
    const config = sandboxConfig({ mode: "none", required: true, bestEffortHostEnabled: false });
    const checks = buildCommonProbeChecks(config);
    expect(checks).toEqual({
      checksPassed: [],
      checksFailed: ["unsupported_mode", "best_effort_host_disabled"],
    });

    const adapter = new UnavailableSandboxAdapter("unknown");
    const metadata = adapter.probe(config);
    expect(metadata).toMatchObject({
      platform: "unknown",
      available: false,
      checksFailed: ["unsupported_mode", "best_effort_host_disabled", "unknown_adapter_unavailable"],
    });
    expect(() => assertLaunchable(metadata)).toThrow("Code Mode sandbox failed closed on unknown");
    await expect(adapter.prepareLaunch(launchInput(await makeTempDir()))).rejects.toThrow(
      "unknown_adapter_unavailable",
    );
  });

  it("builds advisory launches and rejects unsafe profile paths without host dependencies", async () => {
    const runTempRoot = await makeTempDir();
    const input = launchInput(runTempRoot);

    expect(buildAdvisoryUnsandboxedLaunchSpec(input)).toEqual({
      transport: "node_ipc",
      executable: input.nodePath,
      args: ["--max-old-space-size=512", input.harnessPath],
      cwd: runTempRoot,
      env: input.env,
      shell: false,
      enforcedWorkspaceRoot: runTempRoot,
      generatedArtifacts: [],
      advisoryUnsandboxed: true,
    });
    expect(normalizeSandboxPlatform("sunos")).toBe("unknown");
    expect(() => rejectUnsafeProfilePath("safe/path")).not.toThrow();
    expect(() => rejectUnsafeProfilePath("bad\npath")).toThrow("unsafe profile characters");
  });

  it("probes current-platform metadata through the runner facade", () => {
    const metadata = resolveCurrentCodeModeSandboxMetadata(
      sandboxConfig({ mode: "best_effort_host", required: false, bestEffortHostEnabled: true }),
    );
    expect(metadata.runnerId).toBe("goatcitadel.best-effort-host");
    expect(metadata.platform).toBe(normalizeSandboxPlatform(process.platform));
  });

  it("dedupes sandbox probe checks before building fail-closed reasons", () => {
    const metadata = buildSandboxMetadata({
      platform: "linux",
      config: sandboxConfig({ mode: "best_effort_host", required: true, bestEffortHostEnabled: true }),
      checksPassed: ["mode_best_effort_host", "mode_best_effort_host"],
      checksFailed: ["linux_firejail_missing", "linux_firejail_missing"],
    });

    expect(metadata.checksPassed).toEqual(["mode_best_effort_host"]);
    expect(metadata.checksFailed).toEqual(["linux_firejail_missing"]);
    expect(metadata.failClosedReason).toBe("Code Mode sandbox failed closed on linux: linux_firejail_missing.");
  });
});

function sandboxConfig(config: {
  mode: string;
  required: boolean;
  bestEffortHostEnabled: boolean;
}): CodeModeSandboxConfig {
  return config as CodeModeSandboxConfig;
}

function launchInput(runTempRoot: string): CodeModeSandboxLaunchInput {
  return {
    runId: "loop22-run",
    nodePath: process.execPath,
    harnessPath: path.join(runTempRoot, "harness.mjs"),
    runTempRoot,
    heapMb: 512,
    env: { NODE_ENV: "test" },
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-code-mode-loop22-"));
  tempDirs.push(dir);
  return dir;
}
