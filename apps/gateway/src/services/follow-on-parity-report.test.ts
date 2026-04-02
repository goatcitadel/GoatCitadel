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
    expect(report.browser.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "current",
      latestArtifactDeploymentProfile: undefined,
      matchedCurrentProfile: false,
      ageDays: 1,
    });
    expect(report.packaging.proofStatus).toEqual({
      hasArtifact: false,
      freshness: "missing",
      matchedCurrentProfile: false,
    });
    expect(report.voice.artifactStatus).toEqual({
      hasArtifact: false,
      freshness: "missing",
      matchedCurrentProfile: false,
    });
    expect(report.canvas.artifactStatus).toEqual({
      hasArtifact: false,
      freshness: "missing",
      matchedCurrentProfile: false,
    });
    expect(report.companion.artifactStatus).toEqual({
      hasArtifact: false,
      freshness: "missing",
    });
    expect(report.plugins.artifactStatus).toEqual({
      hasArtifact: false,
      freshness: "missing",
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

  it("marks stale browser, A2UI, voice, companion, and extension artifacts when the last bundle lags behind runtime truth", () => {
    const report = buildFollowOnParityReport({
      ...buildReadyReportInput(),
      generatedAt: "2026-03-31T18:00:00.000Z",
      deploymentProfile: "remote_hardened",
      latestArtifacts: {
        browser: {
          laneId: "browser",
          generatedAt: "2026-03-20T10:00:00.000Z",
          summary: "Old browser bundle",
          relativePath: "artifacts/follow-on-parity/browser/2026-03-20/browser-control-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/browser/2026-03-20/browser-control-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          bytes: 300,
        },
        a2ui: {
          laneId: "a2ui",
          generatedAt: "2026-03-20T10:00:00.000Z",
          summary: "Old a2ui bundle",
          relativePath: "artifacts/follow-on-parity/a2ui/2026-03-20/a2ui-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/a2ui/2026-03-20/a2ui-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          bytes: 301,
        },
        voice: {
          laneId: "voice",
          generatedAt: "2026-03-20T10:00:00.000Z",
          summary: "Old voice bundle",
          relativePath: "artifacts/follow-on-parity/voice/2026-03-20/voice-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/voice/2026-03-20/voice-proof-bundle-trusted_local-2026-03-20T10-00-00-000Z.md",
          bytes: 302,
        },
        companion: {
          laneId: "companion",
          generatedAt: "2026-03-20T10:00:00.000Z",
          summary: "Old companion brief",
          relativePath: "artifacts/follow-on-parity/companion/2026-03-20/companion-bootstrap-brief-2026-03-20T10-00-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/companion/2026-03-20/companion-bootstrap-brief-2026-03-20T10-00-00-000Z.md",
          bytes: 303,
        },
        extensions: {
          laneId: "extensions",
          generatedAt: "2026-03-20T10:00:00.000Z",
          summary: "Old extension brief",
          relativePath: "artifacts/follow-on-parity/extensions/2026-03-20/extension-sdk-brief-2026-03-20T10-00-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/extensions/2026-03-20/extension-sdk-brief-2026-03-20T10-00-00-000Z.md",
          bytes: 304,
        },
      } as any,
    });

    expect(report.browser.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "stale",
      latestArtifactDeploymentProfile: "trusted_local",
      matchedCurrentProfile: false,
      ageDays: 11,
    });
    expect(report.canvas.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "stale",
      latestArtifactDeploymentProfile: "trusted_local",
      matchedCurrentProfile: false,
      ageDays: 11,
    });
    expect(report.voice.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "stale",
      latestArtifactDeploymentProfile: "trusted_local",
      matchedCurrentProfile: false,
      ageDays: 11,
    });
    expect(report.companion.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "stale",
      ageDays: 11,
    });
    expect(report.plugins.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "stale",
      ageDays: 11,
    });
    expect(report.browser.recommendedActions).toEqual(expect.arrayContaining([
      "Latest browser proof artifact is 11 day(s) old; refresh it before relying on it.",
      "Latest browser proof artifact targets trusted_local; rerun the lane under remote_hardened so proof matches current runtime truth.",
    ]));
    expect(report.canvas.recommendedActions).toEqual(expect.arrayContaining([
      "Latest A2UI proof artifact is 11 day(s) old; refresh it before relying on it.",
      "Latest A2UI proof artifact targets trusted_local; rerun the lane under remote_hardened so proof matches current runtime truth.",
    ]));
    expect(report.voice.recommendedActions).toEqual(expect.arrayContaining([
      "Latest voice proof artifact is 11 day(s) old; refresh it before relying on it.",
      "Latest voice proof artifact targets trusted_local; rerun the lane under remote_hardened so proof matches current runtime truth.",
    ]));
    expect(report.companion.recommendedActions).toEqual(expect.arrayContaining([
      "Latest companion bootstrap brief is 11 day(s) old; refresh it before relying on it.",
    ]));
    expect(report.plugins.recommendedActions).toEqual(expect.arrayContaining([
      "Latest extension SDK brief is 11 day(s) old; refresh it before relying on it.",
    ]));
  });

  it("acknowledges a current clean voice proof artifact instead of always asking for another proof run", () => {
    const report = buildFollowOnParityReport({
      ...buildReadyReportInput(),
      generatedAt: "2026-04-02T04:26:00.000Z",
      deploymentProfile: "local_dev",
      latestArtifacts: {
        voice: {
          laneId: "voice",
          generatedAt: "2026-04-02T04:25:42.216Z",
          summary: "Voice proof lane is ready with runtime ready, model tiny.en, talk stopped, and wake disabled.",
          relativePath: "artifacts/follow-on-parity/voice/2026-04-02/voice-proof-bundle-local_dev-2026-04-02T04-25-42-216Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/voice/2026-04-02/voice-proof-bundle-local_dev-2026-04-02T04-25-42-216Z.md",
          bytes: 1963,
        },
      } as any,
      voiceStatus: {
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "tiny.en",
          updatedAt: "2026-04-02T04:25:42.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-04-02T04:25:42.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-04-02T04:25:42.000Z",
        },
      } as any,
      voiceRuntime: {
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "tiny.en",
        installedModels: [],
        catalog: [],
      } as any,
    });

    expect(report.voice.artifactStatus).toEqual({
      hasArtifact: true,
      freshness: "current",
      latestArtifactDeploymentProfile: "local_dev",
      matchedCurrentProfile: true,
      ageDays: 0,
    });
    expect(report.voice.recommendedActions).toContain(
      "Current voice proof artifact matches the active deployment profile; rerun the lane only after runtime, model, or deployment-profile changes.",
    );
    expect(report.voice.recommendedActions).not.toContain(
      "Generate the voice proof-lane draft from System, then run the transcription, Talk Mode, and Wake Mode operator cycle.",
    );
  });
});
