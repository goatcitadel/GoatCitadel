import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Storage } from "@goatcitadel/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuidanceService } from "./guidance-service.js";

const KILL_SWITCH_ENV = "GOATCITADEL_DISABLE_GUIDANCE_INJECTION";
const ORIGINAL_KILL_SWITCH = process.env[KILL_SWITCH_ENV];

let rootDir: string | undefined;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-guidance-service-"));
});

afterEach(async () => {
  if (ORIGINAL_KILL_SWITCH === undefined) {
    delete process.env[KILL_SWITCH_ENV];
  } else {
    process.env[KILL_SWITCH_ENV] = ORIGINAL_KILL_SWITCH;
  }

  if (rootDir) {
    await fs.rm(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  }
});

describe("GuidanceService", () => {
  it("only disables runtime guidance for explicit truthy kill switch values", async () => {
    const service = createService();
    await fs.writeFile(path.join(mustRootDir(), "GOATCITADEL.md"), "Global runtime guidance.\n", "utf8");

    process.env[KILL_SWITCH_ENV] = "debug";
    const accidentalValue = await service.resolveRuntimeGuidance("ws-1");
    expect(accidentalValue.globalFilesUsed).toEqual(["GOATCITADEL.md"]);
    expect(accidentalValue.systemInstruction).toContain("Global runtime guidance.");

    process.env[KILL_SWITCH_ENV] = "yes";
    const explicitDisable = await service.resolveRuntimeGuidance("ws-1");
    expect(explicitDisable.globalFilesUsed).toEqual([]);
    expect(explicitDisable.workspaceFilesUsed).toEqual([]);
    expect(explicitDisable.systemInstruction).toBeUndefined();
  });
});

function createService(): GuidanceService {
  return new GuidanceService({
    config: {
      rootDir: mustRootDir(),
    },
    normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
    publishRealtime: vi.fn(),
    storage: {
      workspaces: {
        get: vi.fn(),
      },
    } as unknown as Pick<Storage, "workspaces">,
  });
}

function mustRootDir(): string {
  if (!rootDir) {
    throw new Error("guidance service test root was not initialized");
  }
  return rootDir;
}
