import { describe, expect, it, vi } from "vitest";
import { FOLLOW_ON_PROOF_LANE_SPECS, type FollowOnParityReport } from "@goatcitadel/contracts";
import { buildA2UIProofLaneArtifactPath, buildA2UIProofLaneDraft } from "./a2ui-proof-lane.js";
import { buildBrowserProofLaneArtifactPath, buildBrowserProofLaneDraft } from "./browser-proof-lane.js";
import { buildPackagingProofLaneArtifactPath, buildPackagingProofLaneDraft } from "./packaging-proof-lane.js";
import { buildVoiceProofLaneArtifactPath, buildVoiceProofLaneDraft } from "./voice-proof-lane.js";

function buildBaseReport(): FollowOnParityReport {
  return {
    generatedAt: "2026-03-31T18:00:00.000Z",
    deploymentProfile: "trusted_local",
    authMode: "token",
    packaging: {
      allowLoopbackBypass: false,
      networkAllowlistCount: 2,
      postureSummary: "Packaging is currently aligned to trusted_local with token auth.",
      proofStatus: {
        hasArtifact: false,
        freshness: "missing",
        matchedCurrentProfile: false,
      },
      blockingIssues: [],
      recommendedActions: [],
    },
    browser: {
      totalToolCount: 5,
      readToolCount: 3,
      controlToolCount: 2,
      guardrailSummary: "Trusted-local posture allows the full browser family, including cookie and storage tools, with normal guardrails.",
      stateToolRuntime: {
        restrictedToProfile: "trusted_local",
        registeredTools: ["browser.storage.get"],
        allowedTools: ["browser.storage.get"],
        blockedTools: [],
      },
      blockingIssues: [],
      recommendedActions: [],
      automationCatalog: {
        catalogId: "automation.browser-chrome-control",
        label: "Browser Control",
        maturity: "beta",
        capabilities: ["browse", "automation"],
      },
    },
    voice: {
      runtimeReadiness: "ready",
      selectedModelId: "base.en",
      talkState: "stopped",
      wakeState: "stopped",
      wakeEnabled: false,
      blockingIssues: [],
      recoveryActions: [],
      recommendedActions: [],
      automationCatalog: {
        catalogId: "automation.voice-wake-talk",
        label: "Voice Wake + Talk",
        maturity: "beta",
        capabilities: ["voice"],
      },
    },
    addons: {
      catalogCount: 1,
      installedCount: 1,
      runningCount: 1,
    },
    plugins: {
      totalCount: 1,
      enabledCount: 1,
      sdkSummary: "operator breadth",
      referenceLifecycle: {
        referencePluginId: "reference-integration-plugin",
        present: true,
        enabled: true,
        source: "templates/integration-plugins/reference-integration-plugin",
        matchesReferenceSource: true,
        capabilities: ["reference.install", "lifecycle.smoke"],
      },
      blockingIssues: [],
      recommendedActions: [],
    },
    canvas: {
      automationCatalog: {
        catalogId: "automation.canvas-a2ui",
        label: "Canvas + A2UI",
        maturity: "beta",
        capabilities: ["scene-view", "selection", "inspect", "agent-apply"],
      },
      platformTargets: [
        {
          catalogId: "platform.android-canvas-camera-screen",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas", "camera", "screen"],
        },
      ],
      contract: {
        contractId: "a2ui.v1",
        label: "A2UI Contract",
        operatorSurface: "mission_control",
        scopes: ["ui_canvas", "platform_canvas"],
        transports: ["local_session", "companion_session"],
        uiCapabilities: ["scene_view", "selection", "inspect", "agent_apply"],
        platformCapabilities: ["scene_view", "camera_input", "screen_input"],
        notes: ["Mission Control first."],
      },
      paritySummary: "Canvas + A2UI is ready for Mission Control operator proof.",
      blockingIssues: [],
      recommendedActions: [],
    },
    companion: {
      platformTargets: [
        {
          catalogId: "platform.android-canvas-camera-screen",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas", "camera", "screen"],
        },
      ],
      contract: {
        contractId: "companion.android.v1",
        label: "Android Companion Bootstrap Contract",
        pairedSurfaceContractId: "a2ui.v1",
        primaryTarget: "android",
        bootstrapStatus: "server_foundation",
        repoStrategy: "separate_repo",
        bootstrapRepo: "GoatCitadel-mobile",
        targetCatalogIds: ["platform.android-canvas-camera-screen"],
        deviceCapabilities: ["scene_view", "camera_input", "screen_input"],
        transportLanes: ["foreground_sse", "push_refresh", "manual_refresh"],
        authRequirements: [
          "device_identity",
          "short_lived_access_token",
          "rotating_refresh_token",
          "request_signing",
          "replay_protection",
        ],
        serverPrerequisites: [
          "device_pairing",
          "token_rotation",
          "request_signing",
          "sse_resume",
          "per_device_audit",
        ],
        bootstrapFeatures: ["dashboard", "chat", "approvals", "tasks", "settings", "event_feed"],
        notes: ["Gateway proof is done; Android runtime proof is next."],
      },
      authReadiness: [],
      prerequisiteReadiness: [],
      paritySummary: "Android-first companion lane is defined.",
      blockingIssues: [],
      recommendedActions: [],
    },
    epics: [],
  };
}

describe("follow-on proof lane builders", () => {
  it("keeps browser draft and export paths aligned with the shared proof spec", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:10:00.000Z"));

    const draft = buildBrowserProofLaneDraft(buildBaseReport());

    expect(draft.checklistPath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.browser.checklistPath);
    expect(draft.templatePath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.browser.templatePath);
    expect(draft.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: "bundle",
        status: "ready",
        instructions: expect.stringContaining(FOLLOW_ON_PROOF_LANE_SPECS.browser.templatePath),
      }),
    ]));
    expect(buildBrowserProofLaneArtifactPath(draft)).toBe(
      "artifacts/follow-on-parity/browser/2026-03-31/browser-control-proof-bundle-trusted_local-2026-03-31T18-10-00-000Z.md",
    );

    vi.useRealTimers();
  });

  it("makes blocked browser state tools explicit in local_dev proof drafts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:10:30.000Z"));

    const draft = buildBrowserProofLaneDraft({
      ...buildBaseReport(),
      deploymentProfile: "local_dev",
      browser: {
        ...buildBaseReport().browser,
        guardrailSummary: "Local-dev posture allows browser read/control flows with guardrails, but cookie/storage state tools are still restricted to trusted_local.",
        stateToolRuntime: {
          restrictedToProfile: "trusted_local",
          registeredTools: ["browser.storage.get"],
          allowedTools: [],
          blockedTools: ["browser.storage.get"],
        },
      },
    });

    expect(draft.summary).toContain("1 state tool(s) intentionally blocked");
    expect(draft.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: "control-path",
        instructions: expect.stringContaining("browser.storage.get"),
      }),
    ]));
    expect(draft.markdown).toContain("State tools blocked in local_dev: browser.storage.get");

    vi.useRealTimers();
  });

  it("blocks the packaging draft until the hardened posture is real", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:11:00.000Z"));

    const draft = buildPackagingProofLaneDraft({
      ...buildBaseReport(),
      deploymentProfile: "local_dev",
      packaging: {
        ...buildBaseReport().packaging,
        allowLoopbackBypass: true,
        networkAllowlistCount: 0,
        postureSummary: "Packaging is still in local_dev posture.",
        blockingIssues: [
          "Loopback bypass is enabled, so auth and remote-share proof is weaker than the hardened target.",
        ],
        recommendedActions: [],
      },
    });

    expect(draft.checklistPath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.packaging.checklistPath);
    expect(draft.templatePath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.packaging.templatePath);
    expect(draft.summary).toContain("partially blocked");
    expect(draft.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: "remote-hardened",
        status: "blocked",
      }),
      expect.objectContaining({
        stepId: "bundle",
        status: "blocked",
      }),
    ]));
    expect(buildPackagingProofLaneArtifactPath(draft)).toBe(
      "artifacts/follow-on-parity/packaging/2026-03-31/packaging-deployment-proof-bundle-local_dev-2026-03-31T18-11-00-000Z.md",
    );

    vi.useRealTimers();
  });

  it("surfaces stale packaging proof metadata in the draft snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:11:30.000Z"));

    const draft = buildPackagingProofLaneDraft({
      ...buildBaseReport(),
      packaging: {
        ...buildBaseReport().packaging,
        proofStatus: {
          hasArtifact: true,
          freshness: "stale",
          latestArtifactDeploymentProfile: "trusted_local",
          matchedCurrentProfile: true,
          ageDays: 9,
        },
      },
    });

    expect(draft.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: "preflight",
        instructions: expect.stringContaining("9 day(s) old"),
      }),
    ]));
    expect(draft.markdown).toContain("Latest proof artifact: stale (9 day(s) old)");

    vi.useRealTimers();
  });

  it("carries live voice recovery actions straight into the proof lane", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:12:00.000Z"));

    const draft = buildVoiceProofLaneDraft({
      ...buildBaseReport(),
      voice: {
        ...buildBaseReport().voice,
        runtimeReadiness: "missing",
        selectedModelId: undefined,
        talkState: "running",
        wakeState: "running",
        wakeEnabled: true,
        blockingIssues: ["Managed runtime is missing."],
        recoveryActions: [
          "Repair or install the managed voice runtime from Settings before attempting transcription, talk, or wake validation.",
          "Install or activate a local voice model so the proof lane is not blocked on model selection.",
        ],
      },
    });

    expect(draft.checklistPath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.voice.checklistPath);
    expect(draft.templatePath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.voice.templatePath);
    expect(draft.summary).toContain("blocked");
    expect(draft.recoveryActions).toEqual([
      "Repair or install the managed voice runtime from Settings before attempting transcription, talk, or wake validation.",
      "Install or activate a local voice model so the proof lane is not blocked on model selection.",
    ]);
    expect(buildVoiceProofLaneArtifactPath(draft)).toBe(
      "artifacts/follow-on-parity/voice/2026-03-31/voice-proof-bundle-trusted_local-2026-03-31T18-12-00-000Z.md",
    );

    vi.useRealTimers();
  });

  it("keeps the A2UI proof lane honest about Mission Control readiness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:13:00.000Z"));

    const draft = buildA2UIProofLaneDraft({
      ...buildBaseReport(),
      canvas: {
        ...buildBaseReport().canvas,
        automationCatalog: {
          ...buildBaseReport().canvas.automationCatalog!,
          maturity: "planned",
        },
        blockingIssues: ["Canvas + A2UI is still marked below an operator-ready catalog maturity."],
      },
    });

    expect(draft.checklistPath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.a2ui.checklistPath);
    expect(draft.templatePath).toBe(FOLLOW_ON_PROOF_LANE_SPECS.a2ui.templatePath);
    expect(draft.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: "mission-control",
        status: "blocked",
      }),
      expect.objectContaining({
        stepId: "boundary",
        status: "ready",
      }),
    ]));
    expect(buildA2UIProofLaneArtifactPath(draft)).toBe(
      "artifacts/follow-on-parity/a2ui/2026-03-31/a2ui-proof-bundle-trusted_local-2026-03-31T18-13-00-000Z.md",
    );

    vi.useRealTimers();
  });
});
