import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareUiParityRuntime } from "./ui-parity-runtime.mjs";

describe("UI parity runtime isolation", () => {
  it("uses a fresh shipped-defaults root, pins every GoatCitadel path inside it and scrubs inherited settings", async () => {
    const inherited = { GOATCITADEL_EXAMPLE_INHERITED: "operator", VITE_GOATCITADEL_EXAMPLE: "operator", PATH: "kept" };
    const { runtimeRoot, gatewayEnv, omitEnv } = await prepareUiParityRuntime({ runId: "ui-parity-test" }, inherited);
    try {
      // Shipped defaults only: the example-derived config and tracked skills, never checkout workspaces.
      const entries = await fs.readdir(runtimeRoot);
      assert.ok(entries.includes("config"));
      assert.ok(!entries.includes("workspaces"));
      for (const key of [
        "GOATCITADEL_HOME",
        "GOATCITADEL_BACKUP_DIR",
        "GOATCITADEL_LOCAL_ENV_FILE",
        "GOATCITADEL_CODE_MODE_ARTIFACT_ROOT",
        "GOATCITADEL_CODE_MODE_TEMP_ROOT",
      ]) {
        assert.ok(gatewayEnv[key]?.startsWith(runtimeRoot), key);
      }
      // Local services stay off; feature flags are left to the lane.
      for (const key of [
        "GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART",
        "GOATCITADEL_LLAMACPP_AUTOSTART",
        "GOATCITADEL_NPU_AUTOSTART",
      ]) {
        assert.equal(gatewayEnv[key], "false", key);
      }
      assert.equal(gatewayEnv.GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED, undefined);
      assert.ok(omitEnv.includes("GOATCITADEL_EXAMPLE_INHERITED"));
      assert.ok(omitEnv.includes("VITE_GOATCITADEL_EXAMPLE"));
      assert.ok(!omitEnv.includes("PATH"));
    } finally {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    }
    await assert.rejects(fs.stat(path.join(runtimeRoot, "config")));
  });
});

describe("UI parity shell", () => {
  it("pins the Classic shell it compares, since the cockpit is the default and owns /ops/approvals natively", async () => {
    const source = await fs.readFile(new URL("../scenarios.mjs", import.meta.url), "utf8");
    const lane = source.slice(
      source.indexOf("export async function runUiParityLane"),
      source.indexOf("export async function runMemoryTruthLane"),
    );
    assert.match(lane, /localStorage\.setItem\("goatcitadel\.ui\.shell\.v1", "classic"\)/);
  });
});

describe("UI parity route readiness", () => {
  it("tells the readiness helper every compared route is Classic (it otherwise assumes the cockpit)", async () => {
    const source = await fs.readFile(new URL("../scenarios.mjs", import.meta.url), "utf8");
    const lane = source.slice(
      source.indexOf("export async function runUiParityLane"),
      source.indexOf("export async function runMemoryTruthLane"),
    );
    // Compared routes are built by classicUiParityProbe (which always pins the Classic shell) or written inline.
    const probes = lane.match(/classicUiParityProbe\(/g) ?? [];
    const routes = lane.match(/route: \{[^}]*\}/g) ?? [];
    assert.ok(probes.length + routes.length >= 6);
    for (const route of routes) assert.match(route, /shell: "classic"/, route);
    const { classicUiParityProbe } = await import("./ui-parity-owner-contract.mjs");
    const probe = classicUiParityProbe("/ops/runtime", { expectedArea: "ops", expectedSection: "runtime", readyText: "Services" });
    assert.equal(probe.route.shell, "classic");
    assert.match(probe.href, /shell=classic/);
  });
});

describe("UI parity teardown", () => {
  it("starts the UI inside the guarded block so a failed UI start still stops the stack and removes the fresh root", async () => {
    const source = await fs.readFile(new URL("../scenarios.mjs", import.meta.url), "utf8");
    const lane = source.slice(
      source.indexOf("export async function runUiParityLane"),
      source.indexOf("export async function runMemoryTruthLane"),
    );
    assert.match(lane, /let nextUi;\s*try \{\s*nextUi = await startVerificationUiProcess\(/);
    assert.match(lane, /if \(nextUi\) \{[\s\S]*?stopProcess\(nextUi\.handle\)/);
    assert.match(lane, /certifies the Classic shell only/);
  });
});
