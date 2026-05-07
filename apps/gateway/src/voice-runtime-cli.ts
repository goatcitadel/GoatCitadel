/* eslint-disable no-console -- CLI entrypoint intentionally writes structured output to stdout and stderr. */
import process from "node:process";
import { loadLocalEnvFile } from "./env-file.js";
import {
  installManagedVoiceRuntime,
  removeManagedVoiceModel,
  selectManagedVoiceModel,
} from "./voice-runtime/installer.js";
import { getManagedVoiceRuntimeStatus } from "./voice-runtime/status.js";
import { MANAGED_VOICE_MODELS } from "./voice-runtime/catalog.js";

loadLocalEnvFile();

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === "--help" || action === "-h") {
    printUsage();
    return;
  }

  if (action === "install") {
    const modelId = readFlag(args, "--model") ?? undefined;
    const activate = !args.includes("--no-activate");
    const status = await installManagedVoiceRuntime(undefined, {
      modelId,
      activate,
    });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (action === "status") {
    console.log(JSON.stringify(await getManagedVoiceRuntimeStatus(), null, 2));
    return;
  }

  if (action === "models") {
    console.log(
      JSON.stringify(
        { items: MANAGED_VOICE_MODELS.map(({ url: _u, sha256: _s, fileName: _f, ...item }) => item) },
        null,
        2,
      ),
    );
    return;
  }

  if (action === "select") {
    const modelId = args[0];
    if (!modelId) {
      throw new Error("Missing model id for voice select.");
    }
    console.log(JSON.stringify(await selectManagedVoiceModel(undefined, modelId), null, 2));
    return;
  }

  if (action === "remove") {
    const modelId = args[0];
    if (!modelId) {
      throw new Error("Missing model id for voice remove.");
    }
    console.log(JSON.stringify(await removeManagedVoiceModel(undefined, modelId), null, 2));
    return;
  }

  throw new Error(`Unknown voice command: ${action}`);
}

function readFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return args[index + 1] ?? null;
}

function printUsage(): void {
  console.log(`Usage:
  goat voice install [--model <modelId>] [--no-activate]
  goat voice status
  goat voice models
  goat voice select <modelId>
  goat voice remove <modelId>

Supported managed model ids:
  ${MANAGED_VOICE_MODELS.map((item) => item.id).join(", ")}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
