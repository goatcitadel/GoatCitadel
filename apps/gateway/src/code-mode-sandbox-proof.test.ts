import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "./config.js";
import {
  assertCodeModeSandboxAvailable,
  prepareCodeModeSandboxLaunch,
  resolveCurrentCodeModeSandboxMetadata,
} from "./services/code-mode-sandbox-runner.js";
import { main, parseCliOptions } from "./code-mode-sandbox-proof.js";

vi.mock("./config.js", () => ({
  loadGatewayConfig: vi.fn(),
}));

vi.mock("./services/code-mode-sandbox-runner.js", () => ({
  assertCodeModeSandboxAvailable: vi.fn(),
  prepareCodeModeSandboxLaunch: vi.fn(),
  resolveCurrentCodeModeSandboxMetadata: vi.fn(),
}));

const loadGatewayConfigMock = vi.mocked(loadGatewayConfig);
const resolveCurrentCodeModeSandboxMetadataMock = vi.mocked(resolveCurrentCodeModeSandboxMetadata);
const assertCodeModeSandboxAvailableMock = vi.mocked(assertCodeModeSandboxAvailable);
const prepareCodeModeSandboxLaunchMock = vi.mocked(prepareCodeModeSandboxLaunch);

const originalRootDir = process.env.GOATCITADEL_ROOT_DIR;
const tempRoots: string[] = [];
let stdoutWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.env.GOATCITADEL_ROOT_DIR = undefined;
  prepareCodeModeSandboxLaunchMock.mockReset();
  loadGatewayConfigMock.mockResolvedValue({
    assistant: {
      features: { codeModeV1Enabled: true },
      capabilities: {
        codeModeSandbox: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: true,
        },
      },
    },
  } as Awaited<ReturnType<typeof loadGatewayConfig>>);
  resolveCurrentCodeModeSandboxMetadataMock.mockReturnValue(
    metadata({ platform: "win32", required: true, available: true }),
  );
});

afterEach(async () => {
  stdoutWrite.mockRestore();
  if (originalRootDir === undefined) {
    delete process.env.GOATCITADEL_ROOT_DIR;
  } else {
    process.env.GOATCITADEL_ROOT_DIR = originalRootDir;
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("code-mode-sandbox-proof", () => {
  it("parses output options in spaced and equals forms", () => {
    expect(parseCliOptions(["--output", "proof.json"])).toEqual({ output: "proof.json" });
    expect(parseCliOptions(["--output=proof.json"])).toEqual({ output: "proof.json" });
    expect(parseCliOptions(["--ignored", "--output", "proof.json"])).toEqual({ output: "proof.json" });
  });

  it("writes sandbox proof to stdout and asserts availability", async () => {
    process.env.GOATCITADEL_ROOT_DIR = "  ./apps/gateway  ";

    await main([]);

    expect(loadGatewayConfigMock).toHaveBeenCalledWith(path.resolve("./apps/gateway"));
    expect(resolveCurrentCodeModeSandboxMetadataMock).toHaveBeenCalledWith({
      mode: "best_effort_host",
      required: true,
      bestEffortHostEnabled: true,
    });
    expect(assertCodeModeSandboxAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({ required: true, available: true }),
    );
    const proof = JSON.parse(String(stdoutWrite.mock.calls.at(-1)?.[0]));
    expect(proof).toMatchObject({
      rootDir: path.resolve("./apps/gateway"),
      featureEnabled: true,
      sandboxRequired: true,
      sandboxAvailable: true,
    });
    expect(proof.generatedAt).toEqual(expect.any(String));
  });

  it("writes the proof file before enforcing fail-closed required sandbox checks", async () => {
    const root = await createTempRoot();
    const output = path.join(root, "nested", "proof.json");
    resolveCurrentCodeModeSandboxMetadataMock.mockReturnValue(metadata({ required: false, available: false }));

    await expect(main(["--output", output])).rejects.toThrow(
      "Code Mode sandbox-required proof must run with GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED=true.",
    );

    const written = JSON.parse(await fs.readFile(output, "utf8"));
    expect(written).toMatchObject({ sandboxRequired: false, sandboxAvailable: false });
    expect(assertCodeModeSandboxAvailableMock).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("propagates sandbox availability failures after persisting the requested proof", async () => {
    const root = await createTempRoot();
    const output = path.join(root, "proof.json");
    resolveCurrentCodeModeSandboxMetadataMock.mockReturnValue(
      metadata({ required: true, available: false, failClosedReason: "linux_firejail_missing" }),
    );
    assertCodeModeSandboxAvailableMock.mockImplementation(() => {
      throw new Error("linux_firejail_missing");
    });

    await expect(main([`--output=${output}`])).rejects.toThrow("linux_firejail_missing");

    const written = JSON.parse(await fs.readFile(output, "utf8"));
    expect(written).toMatchObject({ sandboxRequired: true, sandboxAvailable: false });
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

function metadata(overrides: Partial<CodeModeSandboxMetadata>): CodeModeSandboxMetadata {
  return {
    runnerId: "goatcitadel.best-effort-host",
    runnerVersion: "0.2.0",
    isolationProfile: "best_effort_host/temp_only/no_network",
    platform: "linux",
    required: true,
    available: true,
    checksPassed: ["linux_firejail_present"],
    checksFailed: [],
    ...overrides,
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-code-mode-proof-"));
  tempRoots.push(root);
  return root;
}
