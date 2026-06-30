import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxFirejailSandboxAdapter, __buildFirejailProfileForTests } from "./linux-firejail-adapter.js";

// Regression coverage for CODEX_FINDING #18: the Linux Code Mode sandbox
// previously used `read-only /` + a writable run-temp dir. That blocked
// writes to the host filesystem but permitted READS of the entire host
// fs. Because the guest runs inside Node's `vm` (not a security boundary),
// a malicious payload could escape and read host config / secrets. The
// launch now uses `--private=<run workspace>` plus profile hardening so the
// generated command does not combine Firejail's distinct private modes.

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("firejail profile (codex #18)", () => {
  it("uses launch-level private home and profile whitelisting without a bare private directive", () => {
    const profile = __buildFirejailProfileForTests("/tmp/run-1");
    expect(profile).not.toMatch(/^private$/m);
    expect(profile).toContain("whitelist /tmp/run-1");
  });

  it("does NOT use the permissive `read-only /` directive", () => {
    const profile = __buildFirejailProfileForTests("/tmp/run-1");
    expect(profile).not.toMatch(/^read-only \/$/m);
  });

  it("retains namespace and capability hardening directives", () => {
    const profile = __buildFirejailProfileForTests("/tmp/run-1");
    expect(profile).toContain("private-dev");
    expect(profile).toContain("private-tmp");
    expect(profile).toContain("net none");
    expect(profile).toContain("seccomp");
    expect(profile).toContain("rlimit-nproc 1");
    expect(profile).toContain("caps.drop all");
    expect(profile).toContain("nonewprivs");
  });

  it("launches the harness from inside the private run workspace", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-firejail-"));
    tempRoots.push(runTempRoot);
    const runHarnessPath = path.join(runTempRoot, "code-mode-harness.mjs");
    const sharedHarnessPath = path.join(path.dirname(runTempRoot), "code-mode-harness.mjs");
    const adapter = new LinuxFirejailSandboxAdapter({
      platform: "linux",
      osRelease: "6.8.0",
      resolveCommand: () => "/usr/bin/firejail",
    });

    const launch = await adapter.prepareLaunch({
      runId: "run-1",
      nodePath: "/usr/bin/node",
      harnessPath: runHarnessPath,
      runTempRoot,
      heapMb: 64,
      env: { GOATCITADEL_CODE_MODE: "1" },
    });

    expect(launch.args).toContain(`--private=${runTempRoot}`);
    expect(launch.args).toContain("--rlimit-nproc=1");
    expect(launch.args).toContain(runHarnessPath);
    expect(launch.args).not.toContain(sharedHarnessPath);
  });

  it("live-smokes the generated Firejail launch when Firejail is installed on Linux", async () => {
    if (process.platform !== "linux" || !hasFirejail()) {
      return;
    }

    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-firejail-live-"));
    tempRoots.push(runTempRoot);
    const harnessPath = path.join(runTempRoot, "code-mode-live-smoke.mjs");
    const proofPath = path.join(runTempRoot, "live-smoke-proof.json");
    await fs.writeFile(
      harnessPath,
      [
        "import fs from 'node:fs';",
        "const proofPath = process.env.GOATCITADEL_FIREJAIL_SMOKE_OUTPUT;",
        "if (!proofPath) throw new Error('missing smoke output path');",
        "fs.writeFileSync(proofPath, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
      ].join("\n"),
      "utf8",
    );

    const adapter = new LinuxFirejailSandboxAdapter({
      platform: "linux",
      osRelease: "6.8.0",
      resolveCommand: () => "firejail",
    });
    const launch = await adapter.prepareLaunch({
      runId: "run-live",
      nodePath: process.execPath,
      harnessPath,
      runTempRoot,
      heapMb: 64,
      env: {
        GOATCITADEL_CODE_MODE: "1",
        TZ: process.env.TZ ?? "UTC",
        GOATCITADEL_FIREJAIL_SMOKE_OUTPUT: proofPath,
      },
    });

    const result = await spawnLaunch(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
    });
    expect(result).toMatchObject({ code: 0 });
    const proof = JSON.parse(await fs.readFile(proofPath, "utf8")) as { cwd: string; argv: string[] };
    expect(path.resolve(proof.cwd)).toBe(path.resolve(runTempRoot));
    expect(proof.argv).toContain(harnessPath);
  });
});

function hasFirejail(): boolean {
  const result = spawnSync("firejail", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function spawnLaunch(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Firejail live smoke timed out"));
    }, 10_000);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
