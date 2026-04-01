import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  exportBrowserProofLaneDraft: vi.fn(),
  exportCompanionBootstrapBrief: vi.fn(),
  exportExtensionStarterPack: vi.fn(),
  exportExtensionSdkBrief: vi.fn(),
  exportPackagingProofLaneDraft: vi.fn(),
  fetchExtensionStarterPack: vi.fn(),
  fetchExtensionSdkBrief: vi.fn(),
  fetchSystemVitals: vi.fn(),
  fetchFollowOnParityReport: vi.fn(),
  fetchA2UIProofLaneDraft: vi.fn(),
  exportA2UIProofLaneDraft: vi.fn(),
  exportVoiceProofLaneDraft: vi.fn(),
  fetchBrowserProofLaneDraft: vi.fn(),
  fetchPackagingProofLaneDraft: vi.fn(),
  fetchVoiceProofLaneDraft: vi.fn(),
  fetchDaemonStatus: vi.fn(),
  fetchDaemonLogs: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  restartDaemon: vi.fn(),
}));

vi.mock("../api/client", () => ({
  exportBrowserProofLaneDraft: apiMocks.exportBrowserProofLaneDraft,
  exportCompanionBootstrapBrief: apiMocks.exportCompanionBootstrapBrief,
  exportExtensionStarterPack: apiMocks.exportExtensionStarterPack,
  exportExtensionSdkBrief: apiMocks.exportExtensionSdkBrief,
  exportPackagingProofLaneDraft: apiMocks.exportPackagingProofLaneDraft,
  fetchExtensionStarterPack: apiMocks.fetchExtensionStarterPack,
  fetchExtensionSdkBrief: apiMocks.fetchExtensionSdkBrief,
  fetchSystemVitals: apiMocks.fetchSystemVitals,
  fetchFollowOnParityReport: apiMocks.fetchFollowOnParityReport,
  fetchA2UIProofLaneDraft: apiMocks.fetchA2UIProofLaneDraft,
  exportA2UIProofLaneDraft: apiMocks.exportA2UIProofLaneDraft,
  exportVoiceProofLaneDraft: apiMocks.exportVoiceProofLaneDraft,
  fetchBrowserProofLaneDraft: apiMocks.fetchBrowserProofLaneDraft,
  fetchPackagingProofLaneDraft: apiMocks.fetchPackagingProofLaneDraft,
  fetchVoiceProofLaneDraft: apiMocks.fetchVoiceProofLaneDraft,
  fetchDaemonStatus: apiMocks.fetchDaemonStatus,
  fetchDaemonLogs: apiMocks.fetchDaemonLogs,
  startDaemon: apiMocks.startDaemon,
  stopDaemon: apiMocks.stopDaemon,
  restartDaemon: apiMocks.restartDaemon,
}));

import { SystemPage } from "./SystemPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const instanceText = (node: unknown): string => {
    if (typeof node === "string") {
      return node;
    }
    if (!node || typeof node !== "object" || !("children" in node)) {
      return "";
    }
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map((child) => instanceText(child)).join(" ");
  };
  const button = renderer.root.findAll((node) => {
    if (node.type !== "button") {
      return false;
    }
    return instanceText(node)
      .replace(/\s+/g, " ")
      .includes(label);
  })[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("SystemPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchSystemVitals.mockResolvedValue({
      hostname: "goat-box",
      platform: "win32",
      release: "11",
      uptimeSeconds: 123,
      loadAverage: [0.1, 0.2, 0.3],
      cpuCount: 8,
      memoryTotalBytes: 16 * 1024 * 1024 * 1024,
      memoryFreeBytes: 8 * 1024 * 1024 * 1024,
      memoryUsedBytes: 8 * 1024 * 1024 * 1024,
      processRssBytes: 256 * 1024 * 1024,
      processHeapUsedBytes: 128 * 1024 * 1024,
    });
    apiMocks.fetchDaemonStatus.mockResolvedValue({
      state: "running",
      running: true,
      pid: 4242,
      uptimeSeconds: 45,
    });
    apiMocks.fetchDaemonLogs.mockResolvedValue({
      items: [
        {
          timestamp: "2026-03-29T00:00:00.000Z",
          level: "info",
          message: "daemon ready",
        },
      ],
    });
    apiMocks.fetchVoiceProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:04:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "Voice proof lane is ready with runtime ready, model base.en, talk stopped, and wake disabled.",
      checklistPath: "docs/testing/VOICE_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/voice-proof-bundle.md",
      blockingIssues: [],
      recoveryActions: [],
      steps: [
        {
          stepId: "preflight",
          title: "Confirm voice runtime posture",
          status: "ready",
          instructions: "Confirm the managed voice runtime is ready, the selected model is base.en, and current talk/wake state is visible before starting the proof run.",
          evidenceHint: "Capture the live runtime readiness, selected model, and current talk/wake state from System or Settings.",
        },
      ],
      markdown: "# Voice Wake And Talk Proof Bundle Draft",
    });
    apiMocks.exportVoiceProofLaneDraft.mockResolvedValue({
      laneId: "voice",
      generatedAt: "2026-03-29T00:04:00.000Z",
      summary: "Voice proof lane is ready with runtime ready, model base.en, talk stopped, and wake disabled.",
      relativePath: "artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      bytes: 384,
    });
    apiMocks.exportBrowserProofLaneDraft.mockResolvedValue({
      laneId: "browser",
      generatedAt: "2026-03-29T00:05:00.000Z",
      summary: "Browser proof lane is ready for trusted_local with 4 read tool(s) and 4 control tool(s).",
      relativePath: "artifacts/follow-on-parity/browser/2026-03-29/browser-control-proof-bundle-trusted_local-2026-03-29T00-05-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/browser/2026-03-29/browser-control-proof-bundle-trusted_local-2026-03-29T00-05-00-000Z.md",
      bytes: 448,
    });
    apiMocks.exportPackagingProofLaneDraft.mockResolvedValue({
      laneId: "packaging",
      generatedAt: "2026-03-29T00:06:00.000Z",
      summary: "Packaging proof lane is ready with trusted_local, token auth, and 2 allowlisted host(s).",
      relativePath: "artifacts/follow-on-parity/packaging/2026-03-29/packaging-deployment-proof-bundle-trusted_local-2026-03-29T00-06-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/packaging/2026-03-29/packaging-deployment-proof-bundle-trusted_local-2026-03-29T00-06-00-000Z.md",
      bytes: 472,
    });
    apiMocks.exportCompanionBootstrapBrief.mockResolvedValue({
      laneId: "companion",
      generatedAt: "2026-03-29T00:07:00.000Z",
      summary: "companion.android.v1 is ready for separate-repo bootstrap planning, but the mobile runtime still needs its first signed companion session proof.",
      relativePath: "artifacts/follow-on-parity/companion/2026-03-29/companion-bootstrap-brief-2026-03-29T00-07-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/companion/2026-03-29/companion-bootstrap-brief-2026-03-29T00-07-00-000Z.md",
      bytes: 512,
    });
    apiMocks.exportExtensionSdkBrief.mockResolvedValue({
      laneId: "extensions",
      generatedAt: "2026-03-29T00:08:00.000Z",
      summary: "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a local workspace author SDK package and installable reference integration plugin are now present, but the published SDK/runtime story is still partial. The next safe public artifact is now a published SDK package or broader runtime-contract decision, not a broad runtime promise.",
      relativePath: "artifacts/follow-on-parity/extensions/2026-03-29/extension-sdk-brief-2026-03-29T00-08-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/extensions/2026-03-29/extension-sdk-brief-2026-03-29T00-08-00-000Z.md",
      bytes: 540,
    });
    apiMocks.exportExtensionStarterPack.mockResolvedValue({
      generatedAt: "2026-03-29T00:09:00.000Z",
      summary: "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.",
      starterRoot: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z",
      fileCount: 6,
      totalBytes: 4096,
      files: [
        {
          relativePath: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z/README.md",
          fullPath: "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z/README.md",
          bytes: 512,
        },
      ],
    });
    apiMocks.fetchExtensionSdkBrief.mockResolvedValue({
      generatedAt: "2026-03-29T00:08:00.000Z",
      summary: "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a local workspace author SDK package and installable reference integration plugin are now present, but the published SDK/runtime story is still partial. The next safe public artifact is now a published SDK package or broader runtime-contract decision, not a broad runtime promise.",
      markdown: "# Extension SDK Brief\n\n## Decision Gate",
    });
    apiMocks.fetchExtensionStarterPack.mockResolvedValue({
      generatedAt: "2026-03-29T00:09:00.000Z",
      summary: "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.",
      starterRoot: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z",
      files: [
        "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z/README.md",
        "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z/docs/PLUGIN_SDK_CONTRACT.md",
      ],
      markdown: "# Extension Starter Pack\n\n## Included Files",
    });
  });

  it("renders the follow-on parity panel with live report details", async () => {
    apiMocks.fetchFollowOnParityReport.mockResolvedValue({
      generatedAt: "2026-03-29T00:00:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      packaging: {
        allowLoopbackBypass: false,
        networkAllowlistCount: 2,
        postureSummary: "Packaging is currently operating in trusted_local posture, which is useful for operator validation but not the full hardened deployment lane.",
        proofStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
        blockingIssues: [],
        recommendedActions: [
          "Generate the packaging proof-lane draft from System, run a trusted_local smoke pass, then rerun the same install/startup path under remote_hardened.",
          "Record each packaging parity run with templates/verification/packaging-deployment-proof-bundle.md.",
        ],
      },
      browser: {
        totalToolCount: 8,
        readToolCount: 4,
        controlToolCount: 4,
        guardrailSummary: "Trusted-local posture allows the full browser family, including cookie and storage tools, with normal guardrails.",
        stateToolRuntime: {
          restrictedToProfile: "trusted_local",
          registeredTools: ["browser.cookies.get", "browser.storage.get"],
          allowedTools: ["browser.cookies.get", "browser.storage.get"],
          blockedTools: [],
        },
        blockingIssues: [],
        recommendedActions: [
          "Generate the browser proof-lane draft from System, then run the operator pass from Mission Control or the tool surface.",
          "Add an operator-facing browser validation pass that proves read, control, and screenshot flows end to end.",
        ],
        automationCatalog: {
          catalogId: "automation.browser-chrome-control",
          label: "Browser Control",
          maturity: "beta",
          capabilities: ["browse", "automation"],
        },
        latestArtifact: {
          laneId: "browser",
          generatedAt: "2026-03-28T23:55:00.000Z",
          summary: "Prior browser proof bundle",
          relativePath: "artifacts/follow-on-parity/browser/2026-03-28/prior-browser-proof.md",
          fullPath: "workspace/artifacts/follow-on-parity/browser/2026-03-28/prior-browser-proof.md",
          bytes: 321,
        },
      },
      voice: {
        runtimeReadiness: "ready",
        selectedModelId: "base.en",
        talkState: "stopped",
        wakeState: "stopped",
        wakeEnabled: false,
        lastError: undefined,
        blockingIssues: [],
        recoveryActions: [],
        recommendedActions: [
          "Generate the voice proof-lane draft from System, then run the transcription, Talk Mode, and Wake Mode operator cycle.",
        ],
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
        totalCount: 2,
        enabledCount: 1,
        sdkSummary: "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a local workspace author SDK package and installable reference integration plugin are now present, but the published SDK/runtime story is still partial.",
        referenceLifecycle: {
          referencePluginId: "reference-integration-plugin",
          present: true,
          enabled: true,
          source: "templates/integration-plugins/reference-integration-plugin",
          matchesReferenceSource: true,
          capabilities: ["reference.install", "lifecycle.smoke"],
        },
        blockingIssues: [
          "A local workspace author SDK package and installable reference integration plugin now exist, but there is still no published SDK package or broader runtime contract.",
        ],
        recommendedActions: [
          "Use docs/PLUGIN_SDK_CONTRACT.md as the current author-contract baseline for extension work.",
          "Use packages/extensions-sdk/ as the local author SDK baseline for manifest validation and file helpers.",
          "Use templates/integration-plugins/reference-integration-plugin/ as the local installable plugin reference path.",
          "Use the generated or exported extension starter pack when the current contract doc and reference scaffolds need to be handed off outside the repo.",
          "Keep a smoke test around discovery, install metadata, enable/disable, and runtime reporting for the reference plugin lifecycle.",
        ],
      },
      canvas: {
        automationCatalog: {
          catalogId: "automation.canvas-a2ui",
          label: "Canvas + A2UI",
          maturity: "planned",
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
          label: "A2UI Operator Contract",
          scopes: ["ui_canvas", "platform_canvas"],
          transports: ["local_session", "companion_session"],
          operatorSurface: "mission_control",
          uiCapabilities: ["scene_view", "selection", "inspect", "agent_apply"],
          platformCapabilities: ["scene_view", "camera_input", "screen_input"],
          notes: [
            "Mission Control is the first operator surface for a2ui.v1 proof and review.",
            "Platform canvas targets inherit a2ui.v1 through companion_session, but no companion runtime is shipped yet.",
          ],
        },
        paritySummary: "A2UI contract a2ui.v1 now defines ui_canvas + platform_canvas scope for Canvas + A2UI via mission_control, with 1 declared canvas-capable platform target(s).",
        blockingIssues: [
          "Canvas/A2UI catalog maturity is planned, which is still below an operator-ready surface.",
          "A2UI contract v1 exists, but there is still no shipped runtime behind the companion-session lane.",
        ],
        recommendedActions: [
          "Use docs/A2UI_CONTRACT.md and packages/contracts/src/a2ui.ts as the source of truth for a2ui.v1.",
          "Keep the Canvas + A2UI catalog entry aligned with a2ui.v1 capability naming instead of treating it as a generic visual-workspace placeholder.",
          "Generate or export the A2UI proof lane from System, then use it for a Mission-Control-first Office Lab handoff and directed-move pass before broadening to companion sessions.",
        ],
      },
      companion: {
        platformTargets: [
          {
            catalogId: "platform.android-canvas-camera-screen",
            label: "Android Canvas/Camera/Screen",
            maturity: "planned",
            capabilities: ["canvas", "camera", "screen"],
          },
          {
            catalogId: "platform.ios-canvas-camera-voice",
            label: "iOS Canvas/Camera/Voice",
            maturity: "planned",
            capabilities: ["canvas", "camera", "voice"],
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
          targetCatalogIds: [
            "platform.android-canvas-camera-screen",
            "platform.ios-canvas-camera-voice",
          ],
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
          notes: [
            "Android is the first companion bootstrap target and should ship from the separate GoatCitadel-mobile repo, not this monorepo.",
          ],
        },
        authReadiness: [
          {
            key: "device_identity",
            label: "Device identity",
            state: "have_foundation",
            note: "Gateway auth already supports device access requests, approvals, grants, and revocation for named devices.",
          },
          {
            key: "short_lived_access_token",
            label: "Short-lived access tokens",
            state: "have_foundation",
            note: "Current gateway auth mode is token; the gateway now issues dedicated short-lived companion access tokens through the companion session exchange route.",
          },
          {
            key: "rotating_refresh_token",
            label: "Rotating refresh tokens",
            state: "have_foundation",
            note: "The gateway now rotates companion refresh tokens and revokes companion sessions when the parent device grant is revoked.",
          },
          {
            key: "request_signing",
            label: "Signed mutating requests",
            state: "have_foundation",
            note: "Companion-authenticated mutating requests now require an Ed25519 signature over method, path, timestamp, nonce, and canonical body hash.",
          },
          {
            key: "replay_protection",
            label: "Replay protection",
            state: "have_foundation",
            note: "Signed companion mutations now write nonce-scoped replay records with bounded TTL enforcement on the gateway.",
          },
        ],
        prerequisiteReadiness: [
          {
            key: "device_pairing",
            label: "Device pairing",
            state: "have_foundation",
            note: "The auth API already supports device requests, request polling, grants, and grant revocation.",
          },
          {
            key: "token_rotation",
            label: "Token rotation",
            state: "have_foundation",
            note: "The auth API now exposes companion session exchange and refresh endpoints that rotate access and refresh credentials.",
          },
          {
            key: "request_signing",
            label: "Request signing",
            state: "have_foundation",
            note: "The auth pipeline now verifies companion Ed25519 request signatures and records replay-cache state on signed mutations.",
          },
          {
            key: "sse_resume",
            label: "SSE resume",
            state: "have_foundation",
            note: "The realtime events stream already supports afterCursor replay, Last-Event-ID resume, and explicit replay-gap responses.",
          },
          {
            key: "per_device_audit",
            label: "Per-device audit",
            state: "partial",
            note: "Device grants already record device label, type, actor, grant source, and last-used metadata, but there is no companion-specific signed audit chain yet.",
          },
        ],
        paritySummary: "companion.android.v1 defines an Android-first separate_repo bootstrap lane for 2 declared companion-capable platform target(s), and the gateway now has server-foundation session/signing support while the existing GoatCitadel-mobile runtime still lacks first signed-session proof.",
        blockingIssues: [
          "Companion gateway foundation is now present, but the existing GoatCitadel-mobile runtime still needs companion.android.v1 signed-session wiring and end-to-end proof.",
        ],
        recommendedActions: [
          "Use docs/COMPANION_CONTRACT.md and docs/ANDROID_NATIVE_SPEC.md as the current companion bootstrap baseline.",
          "Keep Android as the first bootstrap target and align the separate GoatCitadel-mobile repo to companion.android.v1.",
          "Use the new companion session exchange/refresh contract and Android bootstrap template to wire and prove the first signed GoatCitadel-mobile session.",
        ],
      },
      epics: [
        {
          epicId: "GC-P0-06",
          label: "Browser control parity",
          state: "partial",
          summary: "8 browser tools are registered.",
          nextSlice: "Add browser parity diagnostics.",
        },
        {
          epicId: "GC-P2-12",
          label: "Voice Wake / Talk Mode parity",
          state: "partial",
          summary: "Voice runtime is ready.",
          nextSlice: "Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.",
        },
      ],
    });
    apiMocks.fetchBrowserProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:05:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "Browser proof lane is ready for trusted_local with 4 read tool(s) and 4 control tool(s).",
      checklistPath: "docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/browser-control-proof-bundle.md",
      blockingIssues: [],
      steps: [
        {
          stepId: "preflight",
          title: "Confirm live browser surface",
          status: "ready",
          instructions: "Confirm the current browser tool counts before starting the operator pass.",
          evidenceHint: "Capture the runtime snapshot.",
        },
      ],
      markdown: "# Browser Control Proof Bundle Draft",
    });
    apiMocks.fetchA2UIProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:05:30.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "A2UI proof lane is ready for a Mission-Control-first Office Lab handoff and directed-move pass with a2ui.v1; companion-session expansion remains unproven.",
      checklistPath: "docs/testing/A2UI_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/a2ui-proof-bundle.md",
      blockingIssues: [
        "Canvas/A2UI catalog maturity is planned, which is still below an operator-ready surface.",
      ],
      steps: [
        {
          stepId: "preflight",
          title: "Capture live A2UI contract state",
          status: "ready",
          instructions: "Confirm a2ui.v1, scopes (ui_canvas, platform_canvas), transports (local_session, companion_session), and the current canvas summary from System before starting operator proof.",
          evidenceHint: "Capture the System-page contract summary.",
        },
      ],
      markdown: "# A2UI Proof Bundle Draft",
    });
    apiMocks.exportA2UIProofLaneDraft.mockResolvedValue({
      laneId: "a2ui",
      generatedAt: "2026-03-29T00:05:30.000Z",
      summary: "A2UI proof lane is ready for a Mission-Control-first Office Lab handoff and directed-move pass with a2ui.v1; companion-session expansion remains unproven.",
      relativePath: "artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      bytes: 512,
    });
    apiMocks.fetchPackagingProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:06:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "Packaging proof lane is ready with trusted_local, token auth, and 2 allowlisted host(s).",
      checklistPath: "docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md",
      templatePath: "templates/verification/packaging-deployment-proof-bundle.md",
      blockingIssues: [],
      steps: [
        {
          stepId: "preflight",
          title: "Capture deployment posture",
          status: "ready",
          instructions: "Confirm the current deployment profile before running install proof.",
          evidenceHint: "Capture the posture snapshot.",
        },
      ],
      markdown: "# Packaging And Deployment Proof Bundle Draft",
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SystemPage />);
      });
      await flush();
      const initialText = rendererText(renderer);
      expect(initialText).toContain("Saved browser proof artifact: artifacts/follow-on-parity/browser/2026-03-28/prior-browser-proof.md");
      expect(initialText).toContain("Artifact bytes 321 · generated 2026-03-28T23:55:00.000Z");
      await clickButton(renderer, "Export browser proof artifact");
      await flush();
      await clickButton(renderer, "Export packaging proof artifact");
      await flush();
      await clickButton(renderer, "Export voice proof artifact");
      await flush();
      await clickButton(renderer, "Export A2UI proof artifact");
      await flush();
      await clickButton(renderer, "Export companion bootstrap brief");
      await flush();
      await clickButton(renderer, "Export extension SDK brief");
      await flush();
      await clickButton(renderer, "Export extension starter pack");
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Follow-On Parity");
      expect(text).toContain("browser 4 control");
      expect(text).toContain("voice ready");
      expect(text).toContain("Voice next action: Generate the voice proof-lane draft from System, then run the transcription, Talk Mode, and Wake Mode operator cycle.");
      expect(text).toContain("Generate voice proof draft");
      expect(text).toContain("Export voice proof artifact");
      expect(text).toContain("Voice proof lane: Voice proof lane is ready with runtime ready, model base.en, talk stopped, and wake disabled.");
      expect(text).toContain("Checklist docs/testing/VOICE_VALIDATION_CHECKLIST.md · Template templates/verification/voice-proof-bundle.md");
      expect(text).toContain("Voice proof step: Confirm voice runtime posture");
      expect(text).toContain("Saved voice proof artifact: artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md");
      expect(text).toContain("Artifact bytes 384 · generated 2026-03-29T00:04:00.000Z");
      expect(text).toContain("Browser posture: Trusted-local posture allows the full browser family, including cookie and storage tools, with normal guardrails.");
      expect(text).toContain("Browser state tools in trusted_local");
      expect(text).toContain("allowed browser.cookies.get, browser.storage.get");
      expect(text).toContain("blocked none");
      expect(text).toContain("Browser next action: Generate the browser proof-lane draft from System, then run the operator pass from Mission Control or the tool surface.");
      expect(text).toContain("Generate browser proof draft");
      expect(text).toContain("Export browser proof artifact");
      expect(text).toContain("Browser proof lane: Browser proof lane is ready for trusted_local with 4 read tool(s) and 4 control tool(s).");
      expect(text).toContain("Checklist docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md · Template templates/verification/browser-control-proof-bundle.md");
      expect(text).toContain("Browser proof step: Confirm live browser surface");
      expect(text).toContain("Confirm the current browser tool counts before starting the operator pass.");
      expect(text).toContain("Saved browser proof artifact: artifacts/follow-on-parity/browser/2026-03-29/browser-control-proof-bundle-trusted_local-2026-03-29T00-05-00-000Z.md");
      expect(text).toContain("Artifact bytes 448 · generated 2026-03-29T00:05:00.000Z");
      expect(text).toContain("Packaging posture is trusted_local with auth mode token");
      expect(text).toContain("Packaging summary: Packaging is currently operating in trusted_local posture, which is useful for operator validation but not the full hardened deployment lane.");
      expect(text).toContain("Packaging proof status: missing");
      expect(text).toContain("no artifact recorded yet");
      expect(text).toContain("Generate packaging proof draft");
      expect(text).toContain("Export packaging proof artifact");
      expect(text).toContain("Packaging proof lane: Packaging proof lane is ready with trusted_local, token auth, and 2 allowlisted host(s).");
      expect(text).toContain("Checklist docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md · Template templates/verification/packaging-deployment-proof-bundle.md");
      expect(text).toContain("Packaging proof step: Capture deployment posture");
      expect(text).toContain("Confirm the current deployment profile before running install proof.");
      expect(text).toContain("Packaging next action: Record each packaging parity run with templates/verification/packaging-deployment-proof-bundle.md.");
      expect(text).toContain("Saved packaging proof artifact: artifacts/follow-on-parity/packaging/2026-03-29/packaging-deployment-proof-bundle-trusted_local-2026-03-29T00-06-00-000Z.md");
      expect(text).toContain("Artifact bytes 472 · generated 2026-03-29T00:06:00.000Z");
      expect(text).toContain("Canvas summary: A2UI contract a2ui.v1 now defines ui_canvas + platform_canvas scope for Canvas + A2UI via mission_control, with 1 declared canvas-capable platform target(s).");
      expect(text).toContain("Canvas contract: a2ui.v1 · scopes ui_canvas, platform_canvas · transports local_session, companion_session");
      expect(text).toContain("Generate A2UI proof draft");
      expect(text).toContain("Export A2UI proof artifact");
      expect(text).toContain("A2UI proof lane: A2UI proof lane is ready for a Mission-Control-first Office Lab handoff and directed-move pass with a2ui.v1; companion-session expansion remains unproven.");
      expect(text).toContain("Checklist docs/testing/A2UI_VALIDATION_CHECKLIST.md · Template templates/verification/a2ui-proof-bundle.md");
      expect(text).toContain("A2UI proof step: Capture live A2UI contract state");
      expect(text).toContain("Saved A2UI proof artifact: artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md");
      expect(text).toContain("Artifact bytes 512 · generated 2026-03-29T00:05:30.000Z");
      expect(text).toContain("Companion summary: companion.android.v1 defines an Android-first separate_repo bootstrap lane for 2 declared companion-capable platform target(s), and the gateway now has server-foundation session/signing support while the existing GoatCitadel-mobile runtime still lacks first signed-session proof.");
      expect(text).toContain("Companion contract: companion.android.v1 · target android · repo GoatCitadel-mobile · status server_foundation");
      expect(text).toContain("Companion bootstrap: dashboard, chat, approvals, tasks, settings, event_feed · transports foreground_sse, push_refresh, manual_refresh");
      expect(text).toContain("Companion prerequisites: device_pairing, token_rotation, request_signing, sse_resume, per_device_audit");
      expect(text).toContain("Companion auth readiness: Device identity");
      expect(text).toContain("Gateway auth already supports device access requests, approvals, grants, and revocation for named devices.");
      expect(text).toContain("Companion auth readiness: Short-lived access tokens");
      expect(text).toContain("the gateway now issues dedicated short-lived companion access tokens through the companion session exchange route.");
      expect(text).toContain("Companion prerequisite: SSE resume");
      expect(text).toContain("Last-Event-ID resume");
      expect(text).toContain("Companion prerequisite: Request signing");
      expect(text).toContain("The auth pipeline now verifies companion Ed25519 request signatures and records replay-cache state on signed mutations.");
      expect(text).toContain("Export companion bootstrap brief");
      expect(text).toContain("Saved companion bootstrap brief: artifacts/follow-on-parity/companion/2026-03-29/companion-bootstrap-brief-2026-03-29T00-07-00-000Z.md");
      expect(text).toContain("Artifact bytes 512 · generated 2026-03-29T00:07:00.000Z");
      expect(text).toContain("Extension summary: 1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a local workspace author SDK package and installable reference integration plugin are now present, but the published SDK/runtime story is still partial.");
      expect(text).toContain("Reference plugin lifecycle: reference-integration-plugin");
      expect(text).toContain("installed · enabled · source aligned");
      expect(text).toContain("Reference plugin source: templates/integration-plugins/reference-integration-plugin");
      expect(text).toContain("Reference plugin capabilities: reference.install, lifecycle.smoke");
      expect(text).toContain("Extension next action: Use docs/PLUGIN_SDK_CONTRACT.md as the current author-contract baseline for extension work.");
      expect(text).toContain("Extension next action: Use packages/extensions-sdk/ as the local author SDK baseline for manifest validation and file helpers.");
      expect(text).toContain("Extension next action: Use templates/integration-plugins/reference-integration-plugin/ as the local installable plugin reference path.");
      expect(text).toContain("Extension next action: Use the generated or exported extension starter pack when the current contract doc and reference scaffolds need to be handed off outside the repo.");
      expect(text).toContain("Extension next action: Keep a smoke test around discovery, install metadata, enable/disable, and runtime reporting for the reference plugin lifecycle.");
      expect(text).toContain("Generate extension SDK brief");
      expect(text).toContain("Extension SDK brief: 1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a local workspace author SDK package and installable reference integration plugin are now present, but the published SDK/runtime story is still partial. The next safe public artifact is now a published SDK package or broader runtime-contract decision, not a broad runtime promise.");
      expect(text).toContain("Export extension SDK brief");
      expect(text).toContain("Saved extension SDK brief: artifacts/follow-on-parity/extensions/2026-03-29/extension-sdk-brief-2026-03-29T00-08-00-000Z.md");
      expect(text).toContain("Artifact bytes 540 · generated 2026-03-29T00:08:00.000Z");
      expect(text).toContain("Generate extension starter pack");
      expect(text).toContain("Extension starter pack: 1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.");
      expect(text).toContain("Starter root: artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z");
      expect(text).toContain("Export extension starter pack");
      expect(text).toContain("Saved extension starter pack: artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z");
      expect(text).toContain("Starter pack files 6 · total bytes 4096");
      expect(text).toContain("GC-P0-06 · Browser control parity");
      expect(text).toContain("Next slice: Add browser parity diagnostics.");
      expect(text).toContain("Next slice: Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.");
      expect(text).toContain("Android Canvas/Camera/Screen (planned), iOS Canvas/Camera/Voice (planned)");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps the page usable when the follow-on parity report fails", async () => {
    apiMocks.fetchFollowOnParityReport.mockRejectedValue(new Error("report unavailable"));
    apiMocks.fetchA2UIProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:05:30.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "A2UI proof lane is ready.",
      checklistPath: "docs/testing/A2UI_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/a2ui-proof-bundle.md",
      blockingIssues: [],
      steps: [],
      markdown: "# A2UI Proof Bundle Draft",
    });
    apiMocks.exportA2UIProofLaneDraft.mockResolvedValue({
      laneId: "a2ui",
      generatedAt: "2026-03-29T00:05:30.000Z",
      summary: "A2UI proof lane is ready.",
      relativePath: "artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      bytes: 512,
    });
    apiMocks.fetchBrowserProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:05:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "Browser proof lane is ready.",
      checklistPath: "docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/browser-control-proof-bundle.md",
      blockingIssues: [],
      steps: [],
      markdown: "# Browser Control Proof Bundle Draft",
    });
    apiMocks.fetchPackagingProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:06:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "Packaging proof lane is ready.",
      checklistPath: "docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md",
      templatePath: "templates/verification/packaging-deployment-proof-bundle.md",
      blockingIssues: [],
      steps: [],
      markdown: "# Packaging And Deployment Proof Bundle Draft",
    });
    apiMocks.fetchVoiceProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:04:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      summary: "Voice proof lane is ready.",
      checklistPath: "docs/testing/VOICE_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/voice-proof-bundle.md",
      blockingIssues: [],
      recoveryActions: [],
      steps: [],
      markdown: "# Voice Wake And Talk Proof Bundle Draft",
    });
    apiMocks.exportVoiceProofLaneDraft.mockResolvedValue({
      laneId: "voice",
      generatedAt: "2026-03-29T00:04:00.000Z",
      summary: "Voice proof lane is ready.",
      relativePath: "artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      fullPath: "workspace/artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      bytes: 384,
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SystemPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Host Vitals");
      expect(text).toContain("Follow-on parity report unavailable: report unavailable");
    } finally {
      renderer.unmount();
    }
  });
});
