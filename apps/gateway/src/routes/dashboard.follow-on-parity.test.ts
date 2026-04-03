import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard follow-on parity route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns a live follow-on parity report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T00:00:00.000Z"));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1", "localhost"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => [
        { toolName: "browser.search" },
        { toolName: "browser.navigate" },
        { toolName: "browser.extract" },
        { toolName: "browser.interact" },
        { toolName: "browser.storage.get" },
      ]),
      listIntegrationCatalog: vi.fn(() => [
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
          maturity: "planned",
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
      ]),
      listIntegrationPlugins: vi.fn(() => [
        { pluginId: "reference-integration-plugin", enabled: true, source: "templates/integration-plugins/reference-integration-plugin" },
        { pluginId: "msteams", enabled: false },
      ]),
      listAddonsCatalog: vi.fn(() => [
        { addonId: "arena" },
      ]),
      listInstalledAddons: vi.fn(async () => [
        { addonId: "arena", runtimeStatus: "running" },
      ]),
      getLatestFollowOnParityArtifacts: vi.fn(() => ({
        browser: {
          laneId: "browser",
          generatedAt: "2026-03-28T23:55:00.000Z",
          summary: "Prior browser proof bundle",
          relativePath: "artifacts/follow-on-parity/browser/2026-03-28/browser-control-proof-bundle-trusted_local-2026-03-28T23-55-00-000Z.md",
          fullPath: "workspace/artifacts/follow-on-parity/browser/2026-03-28/browser-control-proof-bundle-trusted_local-2026-03-28T23-55-00-000Z.md",
          bytes: 321,
        },
      })),
      getVoiceProofCoverage: vi.fn(() => ({
        currentProfiles: ["local_dev"],
        staleProfiles: [],
        missingProfiles: ["trusted_local", "remote_hardened"],
      })),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deploymentProfile: "trusted_local",
      authMode: "token",
      packaging: {
        allowLoopbackBypass: false,
        networkAllowlistCount: 2,
        postureSummary: expect.stringContaining("trusted_local"),
        proofStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
        blockingIssues: [],
        recommendedActions: expect.arrayContaining([
          expect.stringContaining("packaging proof-lane draft"),
        ]),
      },
      browser: {
        totalToolCount: 5,
        readToolCount: 3,
        controlToolCount: 2,
        guardrailSummary: expect.stringContaining("Trusted-local"),
        stateToolRuntime: {
          restrictedToProfile: "trusted_local",
          registeredTools: ["browser.storage.get"],
          allowedTools: ["browser.storage.get"],
          blockedTools: [],
        },
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "trusted_local",
          matchedCurrentProfile: true,
          ageDays: 4,
        },
        blockingIssues: [],
        recommendedActions: expect.arrayContaining([
          expect.stringContaining("Current browser proof artifact matches the active deployment profile"),
        ]),
        automationCatalog: {
          catalogId: "automation.browser-chrome-control",
          maturity: "beta",
        },
        latestArtifact: {
          laneId: "browser",
          generatedAt: "2026-03-28T23:55:00.000Z",
          relativePath: "artifacts/follow-on-parity/browser/2026-03-28/browser-control-proof-bundle-trusted_local-2026-03-28T23-55-00-000Z.md",
          bytes: 321,
        },
      },
      voice: {
        runtimeReadiness: "ready",
        selectedModelId: "base.en",
        talkState: "stopped",
        wakeState: "stopped",
        wakeEnabled: false,
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
        blockingIssues: [],
        recoveryActions: [],
        recommendedActions: [
          "Current local-first voice proof is on file for local_dev; rerun trusted_local or remote_hardened only when deliberately widening the supported voice posture.",
        ],
      },
      addons: {
        catalogCount: 1,
        installedCount: 1,
        runningCount: 1,
      },
      plugins: {
        totalCount: 2,
        enabledCount: 1,
        sdkSummary: expect.stringContaining("operator breadth"),
        referenceLifecycle: {
          referencePluginId: "reference-integration-plugin",
          present: true,
          enabled: true,
          source: "templates/integration-plugins/reference-integration-plugin",
          matchesReferenceSource: true,
          capabilities: [],
        },
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
        },
        blockingIssues: [],
        recommendedActions: expect.arrayContaining([
          expect.stringContaining("PLUGIN_SDK_CONTRACT.md"),
          expect.stringContaining("@goatcitadel/extensions-sdk@0.6.0-beta.2"),
          expect.stringContaining("reference-integration-plugin"),
          expect.stringContaining("smoke test"),
        ]),
      },
      canvas: {
        contract: {
          contractId: "a2ui.v1",
          scopes: ["ui_canvas", "platform_canvas"],
          transports: ["local_session", "companion_session"],
        },
        paritySummary: expect.stringContaining("Canvas + A2UI"),
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
        blockingIssues: expect.arrayContaining([
          expect.stringContaining("Android/companion runtime lane"),
        ]),
        recommendedActions: expect.arrayContaining([
          expect.stringContaining("docs/A2UI_CONTRACT.md"),
          expect.stringContaining("Generate or export"),
        ]),
      },
      companion: {
        contract: {
          contractId: "companion.android.v1",
          primaryTarget: "android",
          bootstrapRepo: "GoatCitadel-mobile",
          bootstrapStatus: "server_foundation",
        },
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
        },
        authReadiness: expect.arrayContaining([
          expect.objectContaining({
            key: "device_identity",
            state: "have_foundation",
          }),
          expect.objectContaining({
            key: "short_lived_access_token",
            state: "have_foundation",
          }),
        ]),
        prerequisiteReadiness: expect.arrayContaining([
          expect.objectContaining({
            key: "device_pairing",
            state: "have_foundation",
          }),
          expect.objectContaining({
            key: "sse_resume",
            state: "have_foundation",
          }),
          expect.objectContaining({
            key: "request_signing",
            state: "have_foundation",
          }),
        ]),
        paritySummary: expect.stringContaining("companion-capable"),
        blockingIssues: expect.arrayContaining([
          expect.stringContaining("Gateway session/signing proof is complete"),
        ]),
        recommendedActions: expect.arrayContaining([
          expect.stringContaining("COMPANION_CONTRACT.md"),
          expect.stringContaining("GoatCitadel-mobile"),
        ]),
      },
      epics: expect.arrayContaining([
        expect.objectContaining({
          epicId: "GC-P1-10",
          label: "Long-tail parity register",
          state: "have_foundation",
          summary: expect.stringContaining("live runtime report"),
        }),
      ]),
    });

    const openclawResponse = await app.inject({
      method: "GET",
      url: "/api/v1/system/openclaw-parity",
    });

    expect(openclawResponse.statusCode).toBe(200);
    expect(openclawResponse.json()).toMatchObject({
      completedEpicIds: ["GC-P0-01", "GC-P0-02", "GC-P0-03", "GC-P0-05", "GC-P0-06", "GC-P0-07", "GC-P1-04", "GC-P1-08", "GC-P1-10", "GC-P2-11", "GC-P2-12"],
      openEpicIds: ["GC-P1-09"],
      completionOrder: [
        "GC-P1-09",
      ],
      nextEpicId: "GC-P1-09",
      nextSlice: expect.stringContaining("repeatable install"),
      unsafeClaims: expect.arrayContaining([
        expect.stringContaining("Discord, Slack, and Telegram"),
        expect.stringContaining("Google Chat and Teams are outbound webhook lanes only"),
        expect.stringContaining("WhatsApp, Signal, iMessage/BlueBubbles, Mattermost, LINE, Zalo OA, and Zalo Personal"),
        expect.stringContaining("Broader voice parity beyond the current local-first runtime lane still requires deliberate widening"),
      ]),
      epics: expect.arrayContaining([
        expect.objectContaining({
          epicId: "GC-P0-02",
          label: "Stabilize core beta channels",
          status: "complete",
          summary: expect.stringContaining("Discord, Slack, and Telegram"),
        }),
        expect.objectContaining({
          epicId: "GC-P0-03",
          label: "Ship Tier-1 planned channels",
          status: "complete",
          summary: expect.stringContaining("WhatsApp, Signal, and iMessage/BlueBubbles"),
        }),
        expect.objectContaining({
          epicId: "GC-P1-04",
          label: "Ship Tier-2 planned channels",
          status: "complete",
          summary: expect.stringContaining("Mattermost, LINE, Zalo OA, and Zalo Personal"),
        }),
        expect.objectContaining({
          epicId: "GC-P1-10",
          label: "Long-tail parity register",
          status: "complete",
          blockers: [],
        }),
        expect.objectContaining({
          epicId: "GC-P2-11",
          label: "Extension / plugin SDK breadth",
          status: "complete",
          blockers: [],
        }),
        expect.objectContaining({
          epicId: "GC-P2-12",
          label: "Voice Wake / Talk Mode parity",
          status: "complete",
          blockers: [],
        }),
      ]),
    });
  });

  it("returns a browser proof-lane draft derived from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => [
        { toolName: "browser.search" },
        { toolName: "browser.navigate" },
        { toolName: "browser.extract" },
        { toolName: "browser.screenshot" },
        { toolName: "browser.interact" },
      ]),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.browser-chrome-control",
          kind: "automation",
          label: "Browser Control",
          maturity: "beta",
          capabilities: ["browse", "automation"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/browser-proof-lane",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      checklistPath: "docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/browser-control-proof-bundle.md",
      summary: expect.stringContaining("Browser proof lane is ready"),
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: "preflight",
          status: "ready",
        }),
        expect.objectContaining({
          stepId: "bundle",
          status: "ready",
        }),
      ]),
      markdown: expect.stringContaining("Browser Control Proof Bundle Draft"),
    }));
  });

  it("blocks the browser proof lane when the browser catalog is not operator-ready", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => [
        { toolName: "browser.search" },
        { toolName: "browser.navigate" },
        { toolName: "browser.extract" },
        { toolName: "browser.screenshot" },
        { toolName: "browser.interact" },
      ]),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.browser-chrome-control",
          kind: "automation",
          label: "Browser Control",
          maturity: "planned",
          capabilities: ["browse", "automation"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/browser-proof-lane",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      summary: expect.stringContaining("blocked"),
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: "preflight",
          status: "blocked",
        }),
        expect.objectContaining({
          stepId: "bundle",
          status: "blocked",
        }),
      ]),
    }));
  });

  it("blocks the browser proof lane when browser.interact is missing", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => [
        { toolName: "browser.search" },
        { toolName: "browser.navigate" },
        { toolName: "browser.extract" },
        { toolName: "browser.storage.get" },
      ]),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.browser-chrome-control",
          kind: "automation",
          label: "Browser Control",
          maturity: "beta",
          capabilities: ["browse", "automation"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/browser-proof-lane",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      summary: expect.stringContaining("browser.interact"),
      blockingIssues: expect.arrayContaining([
        expect.stringContaining("No browser interaction tool"),
      ]),
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: "preflight",
          status: "blocked",
        }),
        expect.objectContaining({
          stepId: "control-path",
          status: "blocked",
        }),
        expect.objectContaining({
          stepId: "bundle",
          status: "blocked",
        }),
      ]),
    }));
  });

  it("does not claim extension operator breadth when no add-ons or plugins are registered", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      addons: {
        catalogCount: 0,
        installedCount: 0,
        runningCount: 0,
      },
      plugins: expect.objectContaining({
        totalCount: 0,
        enabledCount: 0,
        sdkSummary: expect.stringContaining("no live operator breadth yet"),
        referenceLifecycle: expect.objectContaining({
          referencePluginId: "reference-integration-plugin",
          present: false,
          enabled: false,
          matchesReferenceSource: false,
          capabilities: [],
        }),
        blockingIssues: expect.arrayContaining([
          expect.stringContaining("No add-on catalog entries or integration plugins are currently registered."),
        ]),
      }),
    }));
  });

  it("returns a packaging proof-lane draft derived from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1", "localhost"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/packaging-proof-lane",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      checklistPath: "docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md",
      templatePath: "templates/verification/packaging-deployment-proof-bundle.md",
      summary: expect.stringContaining("partially blocked"),
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: "preflight",
          status: "ready",
        }),
        expect.objectContaining({
          stepId: "remote-hardened",
          status: "blocked",
        }),
        expect.objectContaining({
          stepId: "bundle",
          status: "blocked",
        }),
      ]),
      markdown: expect.stringContaining("Packaging And Deployment Proof Bundle Draft"),
    }));
  });

  it("returns a voice proof-lane draft derived from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.voice-wake-talk",
          kind: "automation",
          label: "Voice Wake + Talk",
          maturity: "beta",
          capabilities: ["voice"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/voice-proof-lane",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      checklistPath: "docs/testing/VOICE_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/voice-proof-bundle.md",
      summary: expect.stringContaining("Voice proof lane is ready"),
      recoveryActions: [],
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: "preflight",
          status: "ready",
        }),
        expect.objectContaining({
          stepId: "wake-cycle",
          status: "ready",
        }),
      ]),
      markdown: expect.stringContaining("Voice Wake And Talk Proof Bundle Draft"),
    }));
  });

  it("surfaces live voice recovery actions in the parity report when runtime cleanup is needed", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: false,
          modelId: undefined,
          lastError: "model load failed",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "running",
          activeSessionId: "talk-session-1",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: true,
          state: "running",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "broken",
        binaryReady: false,
        ffmpegReady: true,
        selectedModelId: undefined,
        installedModels: [],
        catalog: [],
        lastError: "binary missing",
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().voice.recoveryActions).toEqual(expect.arrayContaining([
      expect.stringContaining("managed voice runtime"),
      expect.stringContaining("local voice model"),
      expect.stringContaining("stale talk session"),
      expect.stringContaining("wake listener"),
      expect.stringContaining("Capture and clear the last runtime error"),
    ]));
  });

  it("exports the browser proof lane as a workspace artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:10:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));
    const rememberFollowOnParityArtifact = vi.fn((artifact) => artifact);

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => [
        { toolName: "browser.search" },
        { toolName: "browser.navigate" },
        { toolName: "browser.extract" },
        { toolName: "browser.screenshot" },
        { toolName: "browser.interact" },
      ]),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.browser-chrome-control",
          kind: "automation",
          label: "Browser Control",
          maturity: "beta",
          capabilities: ["browse", "automation"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
      uploadWorkspaceFile,
      rememberFollowOnParityArtifact,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/browser-proof-lane/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/browser/2026-03-30/browser-control-proof-bundle-trusted_local-2026-03-30T10-10-00-000Z.md",
      expect.stringContaining("# Browser Control Proof Bundle Draft"),
    );
    expect(rememberFollowOnParityArtifact).toHaveBeenCalledWith(expect.objectContaining({
      laneId: "browser",
      generatedAt: "2026-03-30T10:10:00.000Z",
      relativePath: "artifacts/follow-on-parity/browser/2026-03-30/browser-control-proof-bundle-trusted_local-2026-03-30T10-10-00-000Z.md",
    }));
    expect(response.json()).toEqual(expect.objectContaining({
      laneId: "browser",
      generatedAt: "2026-03-30T10:10:00.000Z",
      relativePath: "artifacts/follow-on-parity/browser/2026-03-30/browser-control-proof-bundle-trusted_local-2026-03-30T10-10-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/browser/2026-03-30/browser-control-proof-bundle-trusted_local-2026-03-30T10-10-00-000Z.md",
      bytes: expect.any(Number),
    }));
  });

  it("exports the packaging proof lane as a workspace artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:12:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1", "localhost"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
      uploadWorkspaceFile,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/packaging-proof-lane/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/packaging/2026-03-30/packaging-deployment-proof-bundle-trusted_local-2026-03-30T10-12-00-000Z.md",
      expect.stringContaining("# Packaging And Deployment Proof Bundle Draft"),
    );
    expect(response.json()).toEqual(expect.objectContaining({
      laneId: "packaging",
      generatedAt: "2026-03-30T10:12:00.000Z",
      relativePath: "artifacts/follow-on-parity/packaging/2026-03-30/packaging-deployment-proof-bundle-trusted_local-2026-03-30T10-12-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/packaging/2026-03-30/packaging-deployment-proof-bundle-trusted_local-2026-03-30T10-12-00-000Z.md",
      bytes: expect.any(Number),
    }));
  });

  it("exports the voice proof lane as a workspace artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:20:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.voice-wake-talk",
          kind: "automation",
          label: "Voice Wake + Talk",
          maturity: "beta",
          capabilities: ["voice"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
      uploadWorkspaceFile,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/voice-proof-lane/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/voice/2026-03-30/voice-proof-bundle-trusted_local-2026-03-30T10-20-00-000Z.md",
      expect.stringContaining("# Voice Wake And Talk Proof Bundle Draft"),
    );
    expect(response.json()).toEqual(expect.objectContaining({
      laneId: "voice",
      generatedAt: "2026-03-30T10:20:00.000Z",
      summary: expect.stringContaining("Voice proof lane is ready"),
      relativePath: "artifacts/follow-on-parity/voice/2026-03-30/voice-proof-bundle-trusted_local-2026-03-30T10-20-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/voice/2026-03-30/voice-proof-bundle-trusted_local-2026-03-30T10-20-00-000Z.md",
      bytes: expect.any(Number),
    }));
  });

  it("returns the companion bootstrap brief draft from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: { mode: "token", allowLoopbackBypass: false },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "platform.android-canvas-camera-screen",
          kind: "platform",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas", "camera", "screen"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/companion-bootstrap-brief",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      summary: expect.stringContaining("live gateway session proof is complete"),
      markdown: expect.stringContaining("Android runtime/UI bundle"),
    }));
  });

  it("exports the companion bootstrap brief as a workspace artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:25:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: { mode: "token", allowLoopbackBypass: false },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => [
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
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
      uploadWorkspaceFile,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/companion-bootstrap-brief/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/companion/2026-03-30/companion-bootstrap-brief-2026-03-30T10-25-00-000Z.md",
      expect.stringContaining("# Companion Bootstrap Brief"),
    );
    expect(response.json()).toEqual(expect.objectContaining({
      laneId: "companion",
      generatedAt: "2026-03-30T10:25:00.000Z",
      relativePath: "artifacts/follow-on-parity/companion/2026-03-30/companion-bootstrap-brief-2026-03-30T10-25-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/companion/2026-03-30/companion-bootstrap-brief-2026-03-30T10-25-00-000Z.md",
      bytes: expect.any(Number),
    }));
  });

  it("returns the extension SDK brief draft from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: { mode: "token", allowLoopbackBypass: false },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => [
        { pluginId: "reference-integration-plugin", enabled: true, source: "templates/integration-plugins/reference-integration-plugin" },
      ]),
      listAddonsCatalog: vi.fn(() => [{ addonId: "arena" }]),
      listInstalledAddons: vi.fn(async () => [{ addonId: "arena", runtimeStatus: "running" }]),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/extension-sdk-brief",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual(expect.objectContaining({
      summary: expect.stringContaining("public beta package already exists"),
      markdown: expect.stringContaining("Decision Gate"),
    }));
    expect(body.markdown).toContain("Reference plugin present: yes");
    expect(body.markdown).toContain("Reference plugin source aligned: yes");
  });

  it("exports the extension SDK brief as a workspace artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:27:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: { mode: "token", allowLoopbackBypass: false },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => [
        { pluginId: "reference-integration-plugin", enabled: true, source: "templates/integration-plugins/reference-integration-plugin" },
        { pluginId: "msteams", enabled: false },
      ]),
      listAddonsCatalog: vi.fn(() => [{ addonId: "arena" }]),
      listInstalledAddons: vi.fn(async () => [{ addonId: "arena", runtimeStatus: "running" }]),
      uploadWorkspaceFile,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/extension-sdk-brief/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/extensions/2026-03-30/extension-sdk-brief-2026-03-30T10-27-00-000Z.md",
      expect.stringContaining("# Extension SDK Brief"),
    );
    expect(response.json()).toEqual(expect.objectContaining({
      laneId: "extensions",
      generatedAt: "2026-03-30T10:27:00.000Z",
      relativePath: "artifacts/follow-on-parity/extensions/2026-03-30/extension-sdk-brief-2026-03-30T10-27-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/extensions/2026-03-30/extension-sdk-brief-2026-03-30T10-27-00-000Z.md",
      bytes: expect.any(Number),
    }));
  });

  it("returns the extension starter-pack draft from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: { mode: "token", allowLoopbackBypass: false },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => [
        { pluginId: "reference-integration-plugin", enabled: true, source: "templates/integration-plugins/reference-integration-plugin" },
      ]),
      listAddonsCatalog: vi.fn(() => [{ addonId: "arena" }]),
      listInstalledAddons: vi.fn(async () => [{ addonId: "arena", runtimeStatus: "running" }]),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/extension-starter-pack",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      summary: expect.stringContaining("repo-native starter pack"),
      starterRoot: expect.stringContaining("artifacts/follow-on-parity/extensions/starter-pack/"),
      files: expect.arrayContaining([
        expect.stringContaining("docs/PLUGIN_SDK_CONTRACT.md"),
        expect.stringContaining("addons/reference-separate-repo-addon/goatcitadel.addon.json"),
        expect.stringContaining("integration-plugins/reference-integration-plugin/goatcitadel.integration-plugin.json"),
      ]),
      markdown: expect.stringContaining("Included Files"),
    }));
  });

  it("exports the extension starter pack as workspace files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:29:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: { mode: "token", allowLoopbackBypass: false },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: { state: "stopped", provider: "whisper.cpp", runtimeReady: true, modelId: "base.en", updatedAt: "2026-03-29T00:00:00.000Z" },
        talk: { state: "stopped", updatedAt: "2026-03-29T00:00:00.000Z" },
        wake: { enabled: false, state: "stopped", model: "openwakeword", updatedAt: "2026-03-29T00:00:00.000Z" },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => []),
      listIntegrationPlugins: vi.fn(() => [
        { pluginId: "reference-integration-plugin", enabled: true, source: "templates/integration-plugins/reference-integration-plugin" },
      ]),
      listAddonsCatalog: vi.fn(() => [{ addonId: "arena" }]),
      listInstalledAddons: vi.fn(async () => [{ addonId: "arena", runtimeStatus: "running" }]),
      uploadWorkspaceFile,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/extension-starter-pack/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(6);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/extensions/starter-pack/2026-03-30/extension-starter-pack-2026-03-30T10-29-00-000Z/README.md",
      expect.stringContaining("# GoatCitadel Extension Starter Pack"),
    );
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/extensions/starter-pack/2026-03-30/extension-starter-pack-2026-03-30T10-29-00-000Z/docs/PLUGIN_SDK_CONTRACT.md",
      expect.stringContaining("# Plugin And Add-on SDK Contract"),
    );
    expect(response.json()).toEqual(expect.objectContaining({
      generatedAt: "2026-03-30T10:29:00.000Z",
      starterRoot: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-30/extension-starter-pack-2026-03-30T10-29-00-000Z",
      fileCount: 6,
      totalBytes: expect.any(Number),
      files: expect.arrayContaining([
        expect.objectContaining({
          relativePath: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-30/extension-starter-pack-2026-03-30T10-29-00-000Z/README.md",
          fullPath: "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-03-30/extension-starter-pack-2026-03-30T10-29-00-000Z/README.md",
        }),
      ]),
    }));
  });

  it("returns an A2UI proof-lane draft derived from live parity state", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.canvas-a2ui",
          kind: "automation",
          label: "Canvas + A2UI",
          maturity: "planned",
          capabilities: ["scene-view", "selection", "inspect", "agent-apply"],
        },
        {
          catalogId: "platform.android-canvas-camera-screen",
          kind: "platform",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas", "camera", "screen"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/follow-on-parity/a2ui-proof-lane",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      checklistPath: "docs/testing/A2UI_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/a2ui-proof-bundle.md",
      summary: expect.stringContaining("blocked"),
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: "preflight",
          status: "ready",
        }),
        expect.objectContaining({
          stepId: "mission-control",
          status: "blocked",
          title: "Run the Office Lab handoff and directed-move proof",
        }),
      ]),
      markdown: expect.stringContaining("A2UI Proof Bundle Draft"),
    }));
  });

  it("exports the A2UI proof lane as a workspace artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:15:00.000Z"));

    const uploadWorkspaceFile = vi.fn(async (relativePath: string, content: string) => ({
      relativePath,
      fullPath: `workspace/${relativePath}`,
      bytes: Buffer.byteLength(content, "utf8"),
    }));

    app = Fastify();
    app.decorate("gateway", {
      getSettings: vi.fn(() => ({
        deploymentProfile: "trusted_local",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
        networkAllowlist: ["127.0.0.1"],
      })),
      getVoiceStatus: vi.fn(async () => ({
        stt: {
          state: "stopped",
          provider: "whisper.cpp",
          runtimeReady: true,
          modelId: "base.en",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        talk: {
          state: "stopped",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
        wake: {
          enabled: false,
          state: "stopped",
          model: "openwakeword",
          updatedAt: "2026-03-29T00:00:00.000Z",
        },
      })),
      getVoiceRuntimeStatus: vi.fn(async () => ({
        provider: "whisper.cpp",
        source: "managed",
        readiness: "ready",
        binaryReady: true,
        ffmpegReady: true,
        selectedModelId: "base.en",
        installedModels: [],
        catalog: [],
      })),
      listToolCatalog: vi.fn(() => []),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "automation.canvas-a2ui",
          kind: "automation",
          label: "Canvas + A2UI",
          maturity: "planned",
          capabilities: ["scene-view", "selection", "inspect", "agent-apply"],
        },
        {
          catalogId: "platform.android-canvas-camera-screen",
          kind: "platform",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas", "camera", "screen"],
        },
      ]),
      listIntegrationPlugins: vi.fn(() => []),
      listAddonsCatalog: vi.fn(() => []),
      listInstalledAddons: vi.fn(async () => []),
      uploadWorkspaceFile,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/follow-on-parity/a2ui-proof-lane/export",
    });

    expect(response.statusCode).toBe(201);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(
      "artifacts/follow-on-parity/a2ui/2026-03-30/a2ui-proof-bundle-trusted_local-2026-03-30T10-15-00-000Z.md",
      expect.stringContaining("# A2UI Proof Bundle Draft"),
    );
    expect(response.json()).toEqual(expect.objectContaining({
      laneId: "a2ui",
      generatedAt: "2026-03-30T10:15:00.000Z",
      summary: expect.stringContaining("blocked"),
      relativePath: "artifacts/follow-on-parity/a2ui/2026-03-30/a2ui-proof-bundle-trusted_local-2026-03-30T10-15-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/a2ui/2026-03-30/a2ui-proof-bundle-trusted_local-2026-03-30T10-15-00-000Z.md",
      bytes: expect.any(Number),
    }));
  });
});
