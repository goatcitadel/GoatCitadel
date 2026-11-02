import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentProfile } from "@goatcitadel/contracts";
import {
  composeCapabilitySkillsAndPlugins,
  type CapabilitySkillsAndPluginsOwners,
} from "./capability-skills-plugins-composition.js";

const roots: string[] = [];

beforeEach(() => {
  // A source checkout: whatever the developer's shell names, the built-in plugins come from the install root.
  vi.stubEnv("GOATCITADEL_APP_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * The two tabs wired as GatewayService wires them, over a temp install root with no plugin records. Only what wiring
 * and a list read is real; every other owner is a stand-in that listing never calls.
 */
function wire(deploymentProfile: DeploymentProfile, skipSetting: boolean) {
  const isFeatureEnabled = vi.fn(async (_flag: "settingsApprovalSkipEnabled") => skipSetting);
  const owners = {
    config: {
      rootDir: tempDir("gc-plugins-wiring-"),
      assistant: { dataDir: "data", deploymentProfile },
      toolPolicy: { tools: {}, hooks: {} },
    },
    features: { isFeatureEnabled },
    records: { systemSettings: { get: vi.fn(async () => undefined), compareAndSet: vi.fn() } },
    changePlanAdapters: { register: vi.fn() },
    isClosing: () => true,
  } as unknown as CapabilitySkillsAndPluginsOwners;
  return { plugins: composeCapabilitySkillsAndPlugins(owners).capabilityPlugins, isFeatureEnabled };
}

describe("the Plugins list, as composed", () => {
  it.each([
    ["local_dev", true, true],
    ["trusted_local", true, true],
    ["remote_hardened", false, false],
  ] as const)(
    "answers the skip and the folder rule by the %s install's profile, with the skip setting on",
    async (profile, skip, folders) => {
      const { plugins, isFeatureEnabled } = wire(profile, true);

      const listed = await plugins.list();

      expect(listed).toMatchObject({ operatorApprovalSkip: skip, folderSourcesAllowed: folders, issues: [] });
      // remote_hardened always asks, and its setting is never read.
      if (profile === "remote_hardened") expect(isFeatureEnabled).not.toHaveBeenCalled();
      else expect(isFeatureEnabled).toHaveBeenCalledWith("settingsApprovalSkipEnabled");
    },
  );

  it("answers the skip off when the setting is off", async () => {
    const { plugins } = wire("local_dev", false);
    expect(await plugins.list()).toMatchObject({ operatorApprovalSkip: false, folderSourcesAllowed: true });
  });

  it("says built-in plugins can't be read when a packaged install's app folder can't be verified", async () => {
    // The launcher names an app folder that isn't a source checkout and holds no release: no built-in folder is read.
    vi.stubEnv("GOATCITADEL_APP_DIR", tempDir("gc-unverified-app-"));
    const { plugins } = wire("local_dev", false);

    const listed = await plugins.list();

    expect(listed.builtIn).toEqual([]);
    expect(listed.issues).toEqual(["Built-in plugins can't be read on this install."]);
  });
});
