import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadGatewayConfig } from "./config.js";
import {
  assertCodeModeSandboxAvailable,
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
  const proof = {
    generatedAt: new Date().toISOString(),
    rootDir,
    featureEnabled: config.assistant.features.codeModeV1Enabled,
    sandboxRequired: metadata.required,
    sandboxAvailable: metadata.available,
    metadata,
  };

  if (options.output) {
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(options.output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }

  if (!metadata.required) {
    throw new Error("Code Mode sandbox-required proof must run with GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED=true.");
  }
  assertCodeModeSandboxAvailable(metadata);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
