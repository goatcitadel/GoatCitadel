import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVoiceRuntimeFlag, runVoiceRuntimeCliMain, type VoiceRuntimeCliDeps } from "./voice-runtime-cli.js";

const originalExitCode = process.exitCode;

describe("voice runtime CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  function createDeps(): VoiceRuntimeCliDeps {
    return {
      loadLocalEnvFile: vi.fn(),
      installManagedVoiceRuntime: vi.fn(async () => ({ installed: true }) as never),
      removeManagedVoiceModel: vi.fn(async () => ({ removed: true }) as never),
      selectManagedVoiceModel: vi.fn(async () => ({ selectedModelId: "base.en" }) as never),
      getManagedVoiceRuntimeStatus: vi.fn(async () => ({ mode: "managed" }) as never),
      models: [
        {
          id: "base.en",
          label: "Base English",
          description: "Small test model",
          url: "https://example.test/base.bin",
          sha256: "secret-checksum",
          fileName: "ggml-base.en.bin",
        },
      ],
      log: vi.fn(),
      error: vi.fn(),
    };
  }

  async function runCli(args: string[], deps = createDeps()) {
    await runVoiceRuntimeCliMain(args, deps);
    return deps;
  }

  it("prints usage for help commands without touching the runtime", async () => {
    const deps = await runCli(["--help"]);

    expect(deps.loadLocalEnvFile).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("goat voice install"));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("base.en"));
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.installManagedVoiceRuntime).not.toHaveBeenCalled();
  });

  it("installs the managed runtime with model and activation flags", async () => {
    const deps = await runCli(["install", "--model", "base.en", "--no-activate"]);

    expect(deps.installManagedVoiceRuntime).toHaveBeenCalledWith(undefined, {
      modelId: "base.en",
      activate: false,
    });
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string)).toEqual({
      installed: true,
    });
    expect(readVoiceRuntimeFlag(["--model", "base.en"], "--model")).toBe("base.en");
    expect(readVoiceRuntimeFlag(["--model"], "--model")).toBeNull();
    expect(readVoiceRuntimeFlag([], "--model")).toBeNull();
  });

  it("prints status and sanitized model catalog output", async () => {
    const status = await runCli(["status"]);
    expect(status.getManagedVoiceRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(JSON.parse((status.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string)).toEqual({
      mode: "managed",
    });

    const models = await runCli(["models"]);
    const payload = JSON.parse((models.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    expect(payload.items).toEqual([
      {
        id: "base.en",
        label: "Base English",
        description: "Small test model",
      },
    ]);
  });

  it("selects and removes managed voice models", async () => {
    const selected = await runCli(["select", "base.en"]);
    expect(selected.selectManagedVoiceModel).toHaveBeenCalledWith(undefined, "base.en");
    expect(JSON.parse((selected.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string)).toEqual({
      selectedModelId: "base.en",
    });

    const removed = await runCli(["remove", "base.en"]);
    expect(removed.removeManagedVoiceModel).toHaveBeenCalledWith(undefined, "base.en");
    expect(JSON.parse((removed.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string)).toEqual({
      removed: true,
    });
  });

  it("reports missing and unknown commands through the CLI error boundary", async () => {
    const missingSelect = await runCli(["select"]);
    expect(missingSelect.error).toHaveBeenCalledWith("Missing model id for voice select.");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    const missingRemove = await runCli(["remove"]);
    expect(missingRemove.error).toHaveBeenCalledWith("Missing model id for voice remove.");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    const unknown = await runCli(["bogus"]);
    expect(unknown.error).toHaveBeenCalledWith("Unknown voice command: bogus");
    expect(process.exitCode).toBe(1);
  });
});
