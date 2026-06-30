import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import { loadGatewayConfig, type CodeModeSandboxConfig } from "./config.js";
import {
  assertCodeModeSandboxAvailable,
  prepareCodeModeSandboxLaunch,
  resolveCurrentCodeModeSandboxMetadata,
} from "./services/code-mode-sandbox-runner.js";

interface CliOptions {
  output?: string;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseCliOptions(args);
  const rootDir = path.resolve(process.env.GOATCITADEL_ROOT_DIR?.trim() || process.cwd());
  const config = await loadGatewayConfig(rootDir);
  const metadata = resolveCurrentCodeModeSandboxMetadata(config.assistant.capabilities.codeModeSandbox);
  const proof: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    rootDir,
    featureEnabled: config.assistant.features.codeModeV1Enabled,
    sandboxRequired: metadata.required,
    sandboxAvailable: metadata.available,
    metadata,
  };

  if (!metadata.required) {
    await writeProof(options, proof);
    throw new Error("Code Mode sandbox-required proof must run with GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED=true.");
  }
  try {
    assertCodeModeSandboxAvailable(metadata);
    if (metadata.platform === "linux" && metadata.available) {
      proof.liveLaunch = await runLinuxFirejailLiveSmoke(config.assistant.capabilities.codeModeSandbox, metadata);
    }
  } catch (error) {
    proof.liveLaunch =
      proof.liveLaunch ??
      (metadata.platform === "linux" && metadata.available
        ? {
            platform: "linux",
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }
        : undefined);
    await writeProof(options, proof);
    throw error;
  }

  await writeProof(options, proof);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--output") {
      options.output = args[index + 1];
      index += 1;
    } else if (item?.startsWith("--output=")) {
      options.output = item.slice("--output=".length);
    }
  }
  return options;
}

async function writeProof(options: CliOptions, proof: Record<string, unknown>): Promise<void> {
  if (!options.output) {
    return;
  }
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
}

async function runLinuxFirejailLiveSmoke(
  sandboxConfig: CodeModeSandboxConfig,
  metadata: CodeModeSandboxMetadata,
): Promise<Record<string, unknown>> {
  const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-code-mode-firejail-proof-"));
  try {
    const harnessPath = path.join(runTempRoot, "live-smoke-harness.mjs");
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
    const prepared = await prepareCodeModeSandboxLaunch(
      sandboxConfig,
      {
        runId: "code-mode-sandbox-proof",
        nodePath: process.execPath,
        harnessPath,
        runTempRoot,
        heapMb: 64,
        // Build a minimal synthetic env mirroring production's createMinimalSyntheticEnv.
        // Spreading process.env would carry host secrets and trip
        // assertCodeModeSyntheticLaunchEnv, failing the live proof in any
        // environment that has a secret-bearing key (e.g. GITHUB_TOKEN).
        env: {
          GOATCITADEL_CODE_MODE: "1",
          TZ: process.env.TZ ?? "UTC",
          GOATCITADEL_FIREJAIL_SMOKE_OUTPUT: proofPath,
        },
      },
      {
        platform: "linux",
        metadata,
      },
    );
    const result = await spawnLaunch(prepared.launch.executable, prepared.launch.args, {
      cwd: prepared.launch.cwd,
      env: prepared.launch.env,
    });
    if (result.code !== 0) {
      throw new Error(`Firejail live launch exited ${result.code}: ${result.stderr || result.stdout}`);
    }
    const smokeProof = JSON.parse(await fs.readFile(proofPath, "utf8")) as { cwd?: string; argv?: string[] };
    if (path.resolve(smokeProof.cwd ?? "") !== path.resolve(runTempRoot)) {
      throw new Error(`Firejail live launch cwd mismatch: ${smokeProof.cwd ?? "missing"}`);
    }
    if (!smokeProof.argv?.includes(harnessPath)) {
      throw new Error("Firejail live launch did not execute the generated harness path.");
    }
    return {
      platform: "linux",
      status: "passed",
      cwd: smokeProof.cwd,
      generatedArtifacts: prepared.launch.generatedArtifacts.map((artifact) => path.basename(artifact)),
    };
  } finally {
    await fs.rm(runTempRoot, { recursive: true, force: true });
  }
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
      reject(new Error("Firejail live launch timed out."));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
