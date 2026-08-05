import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadLocalEnvFile } from "./env-file.js";
import {
  installManagedVoiceRuntime,
  removeManagedVoiceModel,
  selectManagedVoiceModel,
} from "./voice-runtime/installer.js";
import { getManagedVoiceRuntimeStatus } from "./voice-runtime/status.js";
import { MANAGED_VOICE_MODELS } from "./voice-runtime/catalog.js";

type ManagedVoiceRuntimeModel = (typeof MANAGED_VOICE_MODELS)[number];

export interface VoiceRuntimeCliDeps {
  loadLocalEnvFile: typeof loadLocalEnvFile;
  installManagedVoiceRuntime: typeof installManagedVoiceRuntime;
  removeManagedVoiceModel: typeof removeManagedVoiceModel;
  selectManagedVoiceModel: typeof selectManagedVoiceModel;
  getManagedVoiceRuntimeStatus: typeof getManagedVoiceRuntimeStatus;
  models: readonly ManagedVoiceRuntimeModel[];
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaultVoiceRuntimeCliDeps: VoiceRuntimeCliDeps = {
  loadLocalEnvFile,
  installManagedVoiceRuntime,
  removeManagedVoiceModel,
  selectManagedVoiceModel,
  getManagedVoiceRuntimeStatus,
  models: MANAGED_VOICE_MODELS,
  log: console.log.bind(console),
  error: console.error.bind(console),
};

export async function runVoiceRuntimeCli(
  argv = process.argv.slice(2),
  deps: VoiceRuntimeCliDeps = defaultVoiceRuntimeCliDeps,
): Promise<void> {
  deps.loadLocalEnvFile();
  const [action, ...args] = argv;
  if (!action || action === "--help" || action === "-h") {
    printVoiceRuntimeUsage(deps);
    return;
  }

  if (action === "install") {
    const modelId = readVoiceRuntimeFlag(args, "--model") ?? undefined;
    const activate = !args.includes("--no-activate");
    const status = await deps.installManagedVoiceRuntime(undefined, {
      modelId,
      activate,
    });
    deps.log(JSON.stringify(status, null, 2));
    return;
  }

  if (action === "status") {
    deps.log(JSON.stringify(await deps.getManagedVoiceRuntimeStatus(), null, 2));
    return;
  }

  if (action === "models") {
    deps.log(
      JSON.stringify({ items: deps.models.map(({ url: _u, sha256: _s, fileName: _f, ...item }) => item) }, null, 2),
    );
    return;
  }

  if (action === "select") {
    const modelId = args[0];
    if (!modelId) {
      throw new Error("Missing model id for voice select.");
    }
    deps.log(JSON.stringify(await deps.selectManagedVoiceModel(undefined, modelId), null, 2));
    return;
  }

  if (action === "remove") {
    const modelId = args[0];
    if (!modelId) {
      throw new Error("Missing model id for voice remove.");
    }
    deps.log(JSON.stringify(await deps.removeManagedVoiceModel(undefined, modelId), null, 2));
    return;
  }

  throw new Error(`Unknown voice command: ${action}`);
}

export async function runVoiceRuntimeCliMain(
  argv = process.argv.slice(2),
  deps: VoiceRuntimeCliDeps = defaultVoiceRuntimeCliDeps,
): Promise<void> {
  try {
    await runVoiceRuntimeCli(argv, deps);
  } catch (error) {
    deps.error((error as Error).message);
    process.exitCode = 1;
  }
}

export function readVoiceRuntimeFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return args[index + 1] ?? null;
}

export function printVoiceRuntimeUsage(
  deps: Pick<VoiceRuntimeCliDeps, "log" | "models"> = defaultVoiceRuntimeCliDeps,
): void {
  deps.log(`Usage:
  goat voice install [--model <modelId>] [--no-activate]
  goat voice status
  goat voice models
  goat voice select <modelId>
  goat voice remove <modelId>

Supported managed model ids:
  ${deps.models.map((item) => item.id).join(", ")}`);
}

function isDirectVoiceRuntimeCli(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  return import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectVoiceRuntimeCli()) {
  void runVoiceRuntimeCliMain().catch((error: unknown) => {
    defaultVoiceRuntimeCliDeps.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
