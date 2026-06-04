import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../../config.js";
import { runCodeModeHostileSandboxCanaries } from "./hostile-canary-runner.js";
import {
  buildHostileSandboxClaimMetadata,
  CODE_MODE_HOSTILE_SANDBOX_CANARIES,
  CODE_MODE_HOSTILE_SANDBOX_PLATFORMS,
  type CodeModeSandboxLaunchInput,
  type CodeModeSandboxLaunchSpec,
} from "./types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runCodeModeHostileSandboxCanaries", () => {
  it("records missing native proof while preserving required-mode fail-closed evidence", async () => {
    const tempRoot = await createTempRoot();

    const proof = await runCodeModeHostileSandboxCanaries(baseConfig(), {
      platform: "linux",
      resolveCommand: () => undefined,
      tempRoot,
      now: fixedNow,
    });

    expect(proof.currentPlatformProof).toMatchObject({
      platform: "linux",
      status: "missing",
      checksPassed: expect.arrayContaining(["fail_closed_required_mode"]),
      checksFailed: expect.arrayContaining(["outside_root_read_denied", "network_denied"]),
    });
    expect(proof.claim).toMatchObject({
      claimStatus: "not_promoted",
      publicClaimAllowed: false,
    });
  });

  it("fails canaries for an available native adapter that behaves like an unsandboxed launch", async () => {
    const tempRoot = await createTempRoot();

    const proof = await runCodeModeHostileSandboxCanaries(baseConfig(), {
      platform: "linux",
      resolveCommand: () => "/fake/firejail",
      tempRoot,
      now: fixedNow,
      prepareLaunch: fakePrepareLaunch,
    });

    expect(proof.currentPlatformProof).toMatchObject({
      platform: "linux",
      status: "fail",
      checksPassed: expect.arrayContaining([
        "env_secret_absent",
        "artifact_hash_integrity",
        "fail_closed_required_mode",
      ]),
      checksFailed: expect.arrayContaining([
        "outside_root_read_denied",
        "outside_root_write_denied",
        "network_denied",
        "symlink_path_traversal_denied",
        "process_job_limits_enforced",
      ]),
    });
    expect(proof.claim).toMatchObject({
      claimStatus: "blocked",
      publicClaimAllowed: false,
    });
    expect(JSON.stringify(proof)).not.toContain("goatcitadel-hostile-canary-synthetic-secret");
  });

  it("passes the current platform only when all current-platform canaries pass", async () => {
    const tempRoot = await createTempRoot();

    const proof = await runCodeModeHostileSandboxCanaries(baseConfig(), {
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: (command) => (command === "powershell.exe" ? "C:\\Windows\\powershell.exe" : undefined),
      tempRoot,
      now: fixedNow,
      prepareLaunch: fakePrepareLaunch,
      spawnLaunch: writePassingCanaryReport,
    });

    expect(proof.currentPlatformProof).toMatchObject({
      platform: "win32",
      status: "pass",
      checksPassed: [...CODE_MODE_HOSTILE_SANDBOX_CANARIES],
      checksFailed: [],
    });
    expect(proof.claim).toMatchObject({
      claimStatus: "not_promoted",
      publicClaimAllowed: false,
    });
    expect(proof.claim.blockers).toEqual(expect.arrayContaining(["linux hostile sandbox proof is missing."]));
  });

  it("aggregates external platform proofs before allowing the public claim", async () => {
    const tempRoot = await createTempRoot();
    const checkedAt = fixedNow().toISOString();

    const proof = await runCodeModeHostileSandboxCanaries(baseConfig(), {
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: (command) => (command === "powershell.exe" ? "C:\\Windows\\powershell.exe" : undefined),
      tempRoot,
      now: fixedNow,
      prepareLaunch: fakePrepareLaunch,
      spawnLaunch: writePassingCanaryReport,
      platformProofs: ["linux", "darwin"].map((platform) => ({
        platform: platform as "linux" | "darwin",
        status: "pass" as const,
        checksPassed: [...CODE_MODE_HOSTILE_SANDBOX_CANARIES],
        checksFailed: [],
        checkedAt,
      })),
    });

    expect(proof.claim).toMatchObject({
      claimStatus: "promoted",
      publicClaimAllowed: true,
      blockers: [],
    });
  });

  it("allows the public claim only when Linux, macOS, and Windows all pass", () => {
    const checkedAt = fixedNow().toISOString();
    const claim = buildHostileSandboxClaimMetadata(
      "linux",
      CODE_MODE_HOSTILE_SANDBOX_PLATFORMS.map((platform) => ({
        platform,
        status: "pass" as const,
        checksPassed: [...CODE_MODE_HOSTILE_SANDBOX_CANARIES],
        checksFailed: [],
        checkedAt,
      })),
    );

    expect(claim).toMatchObject({
      claimStatus: "promoted",
      publicClaimAllowed: true,
      blockers: [],
    });
  });
});

function baseConfig(): CodeModeSandboxConfig {
  return {
    mode: "best_effort_host",
    required: true,
    bestEffortHostEnabled: true,
  };
}

function fixedNow(): Date {
  return new Date("2026-06-01T12:00:00.000Z");
}

async function fakePrepareLaunch(
  _config: CodeModeSandboxConfig,
  input: CodeModeSandboxLaunchInput,
  options?: { metadata?: CodeModeSandboxMetadata },
): Promise<{ metadata: CodeModeSandboxMetadata; launch: CodeModeSandboxLaunchSpec }> {
  if (!options?.metadata?.available) {
    throw new Error(options?.metadata?.failClosedReason ?? "Code Mode sandbox failed closed.");
  }
  await fs.mkdir(input.runTempRoot, { recursive: true });
  return {
    metadata: options.metadata,
    launch: {
      transport: "node_ipc",
      executable: process.execPath,
      args: [input.harnessPath],
      cwd: input.runTempRoot,
      env: input.env,
      shell: false,
      enforcedWorkspaceRoot: input.runTempRoot,
      generatedArtifacts: [],
      advisoryUnsandboxed: false,
    },
  };
}

async function writePassingCanaryReport(
  launch: CodeModeSandboxLaunchSpec,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const reportPath = requiredEnv(launch.env, "GOATCITADEL_HOSTILE_CANARY_REPORT_PATH");
  const artifactPath = requiredEnv(launch.env, "GOATCITADEL_HOSTILE_CANARY_ARTIFACT_PATH");
  const artifactText = requiredEnv(launch.env, "GOATCITADEL_HOSTILE_CANARY_ARTIFACT_TEXT");
  await fs.writeFile(artifactPath, artifactText, "utf8");
  await fs.writeFile(
    reportPath,
    JSON.stringify({
      results: CODE_MODE_HOSTILE_SANDBOX_CANARIES.filter((canary) => canary !== "fail_closed_required_mode").map(
        (canary) => ({
          name: canary,
          passed: true,
        }),
      ),
    }),
    "utf8",
  );
  return { code: 0, stdout: "", stderr: "" };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing test env: ${key}`);
  }
  return value;
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-hostile-runner-test-"));
  tempRoots.push(root);
  return root;
}
