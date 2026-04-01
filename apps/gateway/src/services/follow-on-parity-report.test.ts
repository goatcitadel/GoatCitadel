import { describe, expect, it } from "vitest";
import { FOLLOW_ON_PROOF_LANE_SPECS } from "@goatcitadel/contracts";
import { buildFollowOnParityReport } from "./follow-on-parity-report.js";

function buildReadyReportInput() {
  return {
    generatedAt: "2026-03-31T18:00:00.000Z",
    deploymentProfile: "trusted_local" as const,
    authMode: "token" as const,
    allowLoopbackBypass: false,
    networkAllowlistCount: 2,
    toolCatalog: [
      { toolName: "browser.search" },
      { toolName: "browser.navigate" },
      { toolName: "browser.extract" },
      { toolName: "browser.interact" },
      { toolName: "browser.storage.get" },
    ] as any,
    integrationCatalog: [
      {
        catalogId: "automation.browser-chrome-control",
        kind: "automation",
        label: "Browser Control",
        maturity: "beta",
        capabilities: ["browse", "automation"],
      },
      {
        catalogId: "automation.canvas-a2ui",
        kind: "automation",
        label: "Canvas + A2UI",
        maturity: "beta",
        capabilities: ["scene-view", "selection", "inspect", "agent-apply"],
      },
      {
        catalogId: "automation.voice-wake-talk",
        kind: "automation",
        label: "Voice Wake + Talk",
        maturity: "beta",
        capabilities: ["voice"],
      },
      {
        catalogId: "platform.android-canvas-camera-screen",
        kind: "platform",
        label: "Android Canvas/Camera/Screen",
        maturity: "planned",
        capabilities: ["canvas", "camera", "screen"],
      },
      {
        catalogId: "platform.ios-canvas-camera-voice",
        kind: "platform",
        label: "iOS Canvas/Camera/Voice",
        maturity: "planned",
        capabilities: ["canvas", "camera", "voice"],
      },
    ] as any,
    integrationPlugins: [
      {
        pluginId: "reference-integration-plugin",
        enabled: true,
        source: "templates/integration-plugins/reference-integration-plugin",
      },
    ] as any,
    addonsCatalog: [{ addonId: "arena" }] as any,
    installedAddons: [{ addonId: "arena", runtimeStatus: "running" }] as any,
    voiceStatus: {
      stt: {
        state: "stopped",
        provider: "whisper.cpp",
        runtimeReady: true,
        modelId: "base.en",
        updatedAt: "2026-03-31T17:55:00.000Z",
      },
      talk: {
        state: "stopped",
        updatedAt: "2026-03-31T17:55:00.000Z",
      },
      wake: {
        enabled: false,
        state: "stopped",
        model: "openwakeword",
        updatedAt: "2026-03-31T17:55:00.000Z",
      },
    } as any,
    voiceRuntime: {
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
      selectedModelId: "base.en",
      installedModels: [],
      catalog: [],
    } as any,
    latestArtifacts: {
      browser: {
        laneId: "browser",
        generatedAt: "2026-03-30T10:00:00.000Z",
        summary: "Prior browser proof bundle",
        relativePath: "artifacts/follow-on-parity/browser/2026-03-30/prior-browser-proof.md",
        fullPath: "workspace/artifacts/follow-on-parity/browser/2026-03-30/prior-browser-proof.md",
        bytes: 321,
      },
    } as any,
  };
}

describe("buildFollowOnParityReport", () => {
  it("keeps proof-lane recommendations aligned with the shared proof specs", () => {
    const report = buildFollowOnParityReport(buildReadyReportInput());

    expect(report.generatedAt).toBe("2026-03-31T18:00:00.000Z");
    expect(report.browser.latestArtifact?.laneId).toBe("browser");
    expect(report.packaging.proofStatus).toEqual({
      hasArtifact: false,
      freshness: "missing",
      matchedCurrentProfile: false,
    });
    expect(report.browser.stateToolRuntime).toEqual({
      restrictedToProfile: "trusted_local",
      registeredTools: ["browser.storage.get"],
      allowedTools: ["browser.storage.get"],
      blockedTools: [],
    });
    expect(report.browser.recommendedActions).toContain(
      `Record browser parity runs with ${FOLLOW_ON_PROOF_LANE_SPECS.browser.templatePath}.`,
    );
    expect(report.packaging.recommendedActions).toContain(
      `Record each packaging parity run with ${FOLLOW_ON_PROOF_LANE_SPECS.packaging.templatePath}.`,
    );
    expect(report.packaging.recommendedActions).toContain(
      "No packaging proof artifact is recorded yet; export the next clean install/startup bundle from System before expanding deployment claims.",
    );
    expect(report.plugins.referenceLifecycle).toEqual({
      referencePluginId: "reference-integration-plugin",
      present: true,
      enabled: true,
      source: "templates/integration-plugins/reference-integration-plugin",
      matchesReferenceSource: true,
      capabilities: [],
    });
    expect(report.epics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        epicId: "GC-P1-10",
        state: "have_foundation",
      }),
    ]));
  });

  it("surfaces runtime-state recovery notes directly from live voice posture", () => {
    const report = buildFollowOnParityReport({
      ...buildReadyReportInput(),
      deploymentProfile: "remote_hardened",
      authMode: "none",
      allowLoopbackBypass: true,
      networkAllowlistCount: 0,
      voiceStatus: {
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: false,
          updatedAt: "2026-03-31T17:55:00.000Z",
          lastError: "stt pipeline failed",
        },
        talk: {
          state: "running",
          updatedAt: "2026-03-31T17:55:00.000Z",
        },
        wake: {
          enabled: true,
          state: "running",
          model: "openwakeword",
          updatedAt: "2026-03-31T17:55:00.000Z",
        },
      } as any,
      voiceRuntime: {
        provider: "whisper.cpp",
        source: "managed",
        readiness: "missing_runtime",
        binaryReady: false,
        ffmpegReady: false,
        installedModels: [],
        catalog: [],
        lastError: "runtime missing",
      } as any,
    });

    expect(report.packaging.blockingIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("Auth mode is set to none"),
      expect.stringContaining("Loopback bypass is enabled"),
      expect.stringContaining("No network allowlist entries"),
    ]));
    expect(report.voice.recoveryActions).toEqual(expect.arrayContaining([
      expect.stringContaining("Repair or install the managed voice runtime"),
      expect.stringContaining("Install or activate a local voice model"),
      expect.stringContaining("Capture and clear the last runtime error after recovery: runtime missing"),
      expect.stringContaining("Stop the stale talk session"),
      expect.stringContaining("Disable the current wake listener first"),
    ]));
  });

  it("keeps local_dev browser state-tool guidance aligned with the route guard", () => {
    const report = buildFollowOnParityReport({
      ...buildReadyReportInput(),
      deploymentProfile: "local_dev",
      toolCatalog: [
        { toolName: "browser.search" },
        { toolName: "browser.navigate" },
        { toolName: "browser.extract" },
        { toolName: "browser.interact" },
        { toolName: "browser.cookies.get" },
        { toolName: "browser.storage.get" },
      ] as any,
    });

    expect(report.browser.guardrailSummary).toContain("state tools are still restricted to trusted_local");
    expect(report.browser.stateToolRuntime.blockedTools).toEqual([
      "browser.cookies.get",
      "browser.storage.get",
    ]);
    expect(report.browser.recommendedActions).toEqual(expect.arrayContaining([
      expect.stringContaining("switch to trusted_local for cookie/storage validation"),
      expect.stringContaining("browser.cookies.get, browser.storage.get"),
    ]));
  });

  it("marks stale packaging proof and profile mismatch when the last bundle lags behind runtime truth", () => {
    const report = buildFollowOnParityReport({
      ...buildReadyReportInput(),
      generatedAt: "2026-03-31T18:00:00.000Z",
      deploymentProfile: "remote_hardened",
      latestArtifacts: {
        packaging: {
          laneId: "packaging",
          generatedAt: "2026-03-20T10:00:00.000Z",
          summary: "Old trusted-local bundle",
          relativePath: "artifacts/follow-on-parity/packaging/2026-03-20/packaging-deployment-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/packaging/2026-03-20/packaging-deployment-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          bytes: 456,
        },
      } as any,
    });

    expect(report.packaging.proofStatus).toEqual({
      hasArtifact: true,
      freshness: "stale",
      latestArtifactDeploymentProfile: "trusted_local",
      matchedCurrentProfile: false,
      ageDays: 11,
    });
    expect(report.packaging.recommendedActions).toEqual(expect.arrayContaining([
      expect.stringContaining("11 day(s) old"),
      "Latest packaging proof artifact targets trusted_local; rerun the packaging proof lane under remote_hardened so proof matches current runtime truth.",
    ]));
  });
});
