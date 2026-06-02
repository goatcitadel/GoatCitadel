import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadGatewayConfig } from "./config.js";
import { runCodeModeHostileSandboxCanaries } from "./services/code-mode-sandbox/hostile-canary-runner.js";

interface CliOptions {
  output?: string;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  const rootDir = path.resolve(process.env.GOATCITADEL_ROOT_DIR?.trim() || process.cwd());
  const config = await loadGatewayConfig(rootDir);
  const proof = await runCodeModeHostileSandboxCanaries(config.assistant.capabilities.codeModeSandbox, {
    evidenceRef: options.output ? path.basename(options.output) : undefined,
  });
  await writeProof(options, proof);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  if (proof.sandboxAvailable && proof.currentPlatformProof.status !== "pass") {
    throw new Error(
      `Hostile Code Mode sandbox canaries failed on ${proof.platform}: ${proof.currentPlatformProof.checksFailed.join(", ")}.`,
    );
  }
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

async function writeProof(options: CliOptions, proof: unknown): Promise<void> {
  if (!options.output) {
    return;
  }
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
