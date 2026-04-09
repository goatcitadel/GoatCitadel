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
  fetchOpenclawParityReport: vi.fn(),
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
  fetchOpenclawParityReport: apiMocks.fetchOpenclawParityReport,
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

function buildOpenclawParityProgramMock() {
  return {
    generatedAt: "2026-03-29T00:00:00.000Z",
    completedEpicIds: ["GC-P0-01", "GC-P0-05", "GC-P0-06", "GC-P0-07", "GC-P1-08", "GC-P1-10", "GC-P2-11"],
    openEpicIds: ["GC-P0-02", "GC-P0-03", "GC-P1-04", "GC-P2-12"],
    completionOrder: ["GC-P2-12", "GC-P1-09", "GC-P0-02", "GC-P0-03", "GC-P1-04"],
    nextEpicId: "GC-P2-12",
    nextSlice:
      "Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.",
    unsafeClaims: [
      "Slack, Telegram, Google Chat, Teams, and Discord are not yet safe to claim as fully stabilized inbound/outbound channels.",
      "Tier-1 planned channels remain unfinished: WhatsApp, iMessage/BlueBubbles, and Signal.",
      "Tier-2 planned channels remain unfinished: Mattermost, LINE, Zalo OA, and Zalo Personal.",
    ],
    blockerCounts: {
      repo_runtime: 3,
      manual_operator: 4,
      external_repo: 0,
      publication: 0,
    },
    epics: [
      {
        epicId: "GC-P0-01",
        label: "Shared channel runtime semantics",
        status: "complete",
        summary:
          "Shared channel runtime semantics are already routed through the common capability/action contract used by the current shipped channel surfaces.",
        nextSlice:
          "Keep the shared channel-core contract as the only truth source while remaining beta and planned channels finish against it.",
        blockers: [],
      },
      {
        epicId: "GC-P0-02",
        label: "Stabilize core beta channels",
        status: "in_progress",
        summary:
          "Core beta channels exist, but Slack, Telegram, Google Chat, Teams, and Discord still need inbound/runtime hardening plus channel-by-channel operator proof before they are safe to claim as fully stabilized.",
        nextSlice:
          "Close the remaining inbound/runtime gaps for each beta channel, then rerun channel-specific setup, diagnostics, and smoke proof before promoting the claim.",
        blockers: [
          {
            kind: "repo_runtime",
            summary:
              "Slack, Telegram, Google Chat, Teams, and Discord still need the last inbound/runtime hardening tranche before the full stabilization claim is defensible.",
          },
          {
            kind: "manual_operator",
            summary:
              "Core beta channels still need a fresh operator proof pass after the final hardening tranche; code-complete alone does not close the claim.",
          },
        ],
      },
      {
        epicId: "GC-P0-03",
        label: "Ship Tier-1 planned channels",
        status: "in_progress",
        summary:
          "Tier-1 planned channels are still open: WhatsApp, iMessage/BlueBubbles, and Signal need to move from partial bridge seams to full parity support.",
        nextSlice:
          "Ship Tier-1 channels one at a time with capability truth, setup UX, diagnostics, tests, and operator proof before marking any of them complete.",
        blockers: [
          {
            kind: "repo_runtime",
            summary:
              "WhatsApp, iMessage/BlueBubbles, and Signal still lack the full inbound normalization and action/runtime parity needed to leave planned status.",
          },
          {
            kind: "manual_operator",
            summary:
              "Tier-1 channels still need repeatable operator proof before catalog maturity can be promoted truthfully.",
          },
        ],
      },
      {
        epicId: "GC-P1-04",
        label: "Ship Tier-2 planned channels",
        status: "in_progress",
        summary:
          "Tier-2 planned channels remain open: Mattermost, LINE, Zalo OA, and Zalo Personal are still pending implementation and proof.",
        nextSlice:
          "Reuse the Tier-1 completion template for Tier-2 channels so catalog maturity, diagnostics, tests, and operator proof stay aligned.",
        blockers: [
          {
            kind: "repo_runtime",
            summary:
              "Mattermost, LINE, Zalo OA, and Zalo Personal still have partial outbound seams but not the full parity bar for inbound/runtime behavior.",
          },
          {
            kind: "manual_operator",
            summary: "Tier-2 channels still need repeatable operator proof before any completion claim is safe.",
          },
        ],
      },
      {
        epicId: "GC-P0-06",
        label: "Browser control parity",
        status: "complete",
        summary: "8 browser tools are registered and current operator proof is on file for trusted_local.",
        nextSlice:
          "Keep the browser proof current and rerun the lane only when browser tooling, guardrails, or deployment-profile posture changes.",
        blockers: [],
      },
      {
        epicId: "GC-P1-10",
        label: "Long-tail parity register",
        status: "complete",
        summary: "Follow-on parity now resolves to a live runtime report instead of existing only as placeholder rows.",
        nextSlice:
          "Keep the parity report, proof-lane contract, and markdown register aligned as each remaining tranche lands.",
        blockers: [],
      },
      {
        epicId: "GC-P2-12",
        label: "Voice Wake / Talk Mode parity",
        status: "in_progress",
        summary:
          "Voice runtime is ready, but the current proof bundle still needs to be refreshed before parity can be called complete.",
        nextSlice:
          "Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.",
        blockers: [
          {
            kind: "manual_operator",
            summary:
              "Voice proof still depends on a current, reproducible operator run under the active deployment posture before parity can be called complete.",
          },
        ],
      },
    ],
  };
}

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
    return instanceText(node).replace(/\s+/g, " ").includes(label);
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
    apiMocks.fetchOpenclawParityReport.mockResolvedValue(buildOpenclawParityProgramMock());
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
          instructions:
            "Confirm the managed voice runtime is ready, the selected model is base.en, and current talk/wake state is visible before starting the proof run.",
          evidenceHint:
            "Capture the live runtime readiness, selected model, and current talk/wake state from System or Settings.",
        },
      ],
      markdown: "# Voice Wake And Talk Proof Bundle Draft",
    });
    apiMocks.exportVoiceProofLaneDraft.mockResolvedValue({
      laneId: "voice",
      generatedAt: "2026-03-29T00:04:00.000Z",
      summary: "Voice proof lane is ready with runtime ready, model base.en, talk stopped, and wake disabled.",
      relativePath:
        "artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      bytes: 384,
    });
    apiMocks.exportBrowserProofLaneDraft.mockResolvedValue({
      laneId: "browser",
      generatedAt: "2026-03-29T00:05:00.000Z",
      summary: "Browser proof lane is ready for trusted_local with 4 read tool(s) and 4 control tool(s).",
      relativePath:
        "artifacts/follow-on-parity/browser/2026-03-29/browser-control-proof-bundle-trusted_local-2026-03-29T00-05-00-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/browser/2026-03-29/browser-control-proof-bundle-trusted_local-2026-03-29T00-05-00-000Z.md",
      bytes: 448,
    });
    apiMocks.exportPackagingProofLaneDraft.mockResolvedValue({
      laneId: "packaging",
      generatedAt: "2026-03-29T00:06:00.000Z",
      summary: "Packaging proof lane is ready with trusted_local, token auth, and 2 allowlisted host(s).",
      relativePath:
        "artifacts/follow-on-parity/packaging/2026-03-29/packaging-deployment-proof-bundle-trusted_local-2026-03-29T00-06-00-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/packaging/2026-03-29/packaging-deployment-proof-bundle-trusted_local-2026-03-29T00-06-00-000Z.md",
      bytes: 472,
    });
    apiMocks.exportCompanionBootstrapBrief.mockResolvedValue({
      laneId: "companion",
      generatedAt: "2026-03-29T00:07:00.000Z",
      summary:
        "companion.android.v1 now has current Android runtime/UI proof recorded for the separate mobile repo, and the gateway/session lane remains aligned to that proof.",
      relativePath:
        "artifacts/follow-on-parity/companion/2026-03-29/companion-bootstrap-brief-2026-03-29T00-07-00-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/companion/2026-03-29/companion-bootstrap-brief-2026-03-29T00-07-00-000Z.md",
      bytes: 512,
    });
    apiMocks.exportExtensionSdkBrief.mockResolvedValue({
      laneId: "extensions",
      generatedAt: "2026-03-29T00:08:00.000Z",
      summary:
        "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; the author contract is explicit and @goatcitadel/extensions-sdk@0.9.0-beta.1 is published to GitHub Packages as the current public beta SDK boundary. The public beta package already exists; the remaining decision is whether and when to widen the runtime contract beyond the current explicit boundary.",
      relativePath: "artifacts/follow-on-parity/extensions/2026-03-29/extension-sdk-brief-2026-03-29T00-08-00-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/extensions/2026-03-29/extension-sdk-brief-2026-03-29T00-08-00-000Z.md",
      bytes: 540,
    });
    apiMocks.exportExtensionStarterPack.mockResolvedValue({
      generatedAt: "2026-03-29T00:09:00.000Z",
      summary:
        "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.",
      starterRoot:
        "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z",
      fileCount: 6,
      totalBytes: 4096,
      files: [
        {
          relativePath:
            "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z/README.md",
          fullPath:
            "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z/README.md",
          bytes: 512,
        },
      ],
    });
    apiMocks.fetchExtensionSdkBrief.mockResolvedValue({
      generatedAt: "2026-03-29T00:08:00.000Z",
      summary:
        "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; the author contract is explicit and @goatcitadel/extensions-sdk@0.9.0-beta.1 is published to GitHub Packages as the current public beta SDK boundary. The public beta package already exists; the remaining decision is whether and when to widen the runtime contract beyond the current explicit boundary.",
      markdown: "# Extension SDK Brief\n\n## Decision Gate",
    });
    apiMocks.fetchExtensionStarterPack.mockResolvedValue({
      generatedAt: "2026-03-29T00:09:00.000Z",
      summary:
        "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.",
      starterRoot:
        "artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z",
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
        postureSummary:
          "Packaging is currently operating in trusted_local posture, which is useful for operator validation but not the full hardened deployment lane.",
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
        guardrailSummary:
          "Trusted-local posture allows the full browser family, including cookie and storage tools, with normal guardrails.",
        stateToolRuntime: {
          restrictedToProfile: "trusted_local",
          registeredTools: ["browser.cookies.get", "browser.storage.get"],
          allowedTools: ["browser.cookies.get", "browser.storage.get"],
          blockedTools: [],
        },
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "trusted_local",
          matchedCurrentProfile: true,
          ageDays: 0,
        },
        blockingIssues: [],
        recommendedActions: [
          "Current browser proof artifact matches the active deployment profile; rerun the lane only after browser tooling, guardrails, or deployment-profile posture changes.",
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
          relativePath:
            "artifacts/follow-on-parity/browser/2026-03-28/browser-control-proof-bundle-trusted_local-2026-03-28T23-55-00-000Z.md",
          fullPath:
            "workspace/artifacts/follow-on-parity/browser/2026-03-28/browser-control-proof-bundle-trusted_local-2026-03-28T23-55-00-000Z.md",
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
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
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
        sdkSummary:
          "1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; the author contract is explicit and @goatcitadel/extensions-sdk@0.9.0-beta.1 is published to GitHub Packages as the current public beta SDK boundary.",
        referenceLifecycle: {
          referencePluginId: "reference-integration-plugin",
          present: true,
          enabled: true,
          source: "templates/integration-plugins/reference-integration-plugin",
          matchesReferenceSource: true,
          capabilities: ["reference.install", "lifecycle.smoke"],
        },
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
        },
        blockingIssues: [],
        recommendedActions: [
          "Use docs/PLUGIN_SDK_CONTRACT.md as the current author-contract baseline for extension work.",
          "Use packages/extensions-sdk/ as the local author SDK baseline for manifest validation and file helpers.",
          "Use @goatcitadel/extensions-sdk@0.9.0-beta.1 from GitHub Packages when validating the external author-install flow.",
          "Use templates/integration-plugins/reference-integration-plugin/ as the local installable plugin reference path.",
          "Use the generated or exported extension starter pack when the current contract doc and reference scaffolds need to be handed off outside the repo.",
          "Keep a smoke test around discovery, install metadata, enable/disable, and runtime reporting for the reference plugin lifecycle.",
        ],
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
            maturity: "beta",
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
            "Platform canvas targets inherit a2ui.v1 through companion_session, and Android proof is now on file for the current signed-session runtime.",
          ],
        },
        paritySummary:
          "A2UI contract a2ui.v1 now defines ui_canvas + platform_canvas scope for Canvas + A2UI via mission_control, with 1 declared canvas-capable platform target(s).",
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "trusted_local",
          matchedCurrentProfile: true,
          ageDays: 0,
        },
        blockingIssues: [],
        recommendedActions: [
          "Use docs/A2UI_CONTRACT.md and packages/contracts/src/a2ui.ts as the source of truth for a2ui.v1.",
          "Keep the Canvas + A2UI catalog entry aligned with a2ui.v1 capability naming instead of treating it as a generic visual-workspace placeholder.",
          "Keep the Android A2UI proof current and rerun the lane only when the canvas contract, deployment profile, or operator flow changes.",
        ],
      },
      companion: {
        platformTargets: [
          {
            catalogId: "platform.android-canvas-camera-screen",
            label: "Android Canvas/Camera/Screen",
            maturity: "beta",
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
          targetCatalogIds: ["platform.android-canvas-camera-screen", "platform.ios-canvas-camera-voice"],
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
            "Foreground SSE with resume is the primary realtime lane; push refresh and manual refresh cover background/mobile constraints.",
            "Live gateway proof now covers companion session exchange, refresh rotation, signed mutation verification, replay protection, and SSE resume, and Android runtime/UI proof is now on file for the separate mobile repo.",
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
        paritySummary:
          "companion.android.v1 defines an Android-first separate_repo bootstrap lane for 2 declared companion-capable platform target(s), and the gateway/session lane now has current Android runtime/UI proof recorded against the existing GoatCitadel-mobile repo.",
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          ageDays: 0,
        },
        blockingIssues: [],
        recommendedActions: [
          "Use docs/COMPANION_CONTRACT.md and docs/ANDROID_NATIVE_SPEC.md as the current companion bootstrap baseline.",
          "Keep Android as the first bootstrap target and align the separate GoatCitadel-mobile repo to companion.android.v1.",
          "Keep the Android companion proof current and rerun the lane only when the bootstrap contract, runtime flow, or signed-session behavior changes.",
        ],
      },
      epics: [
        {
          epicId: "GC-P0-06",
          label: "Browser control parity",
          state: "have_foundation",
          summary: "8 browser tools are registered and current operator proof is on file for trusted_local.",
          nextSlice:
            "Keep the browser proof current and rerun the lane only when browser tooling, guardrails, or deployment-profile posture changes.",
        },
        {
          epicId: "GC-P2-12",
          label: "Voice Wake / Talk Mode parity",
          state: "partial",
          summary: "Voice runtime is ready.",
          nextSlice:
            "Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.",
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
      summary:
        "A2UI proof lane is aligned to the current Android-signed-session runtime; rerun the Office Lab handoff and directed-move pass only when the contract, deployment profile, or operator flow changes.",
      checklistPath: "docs/testing/A2UI_VALIDATION_CHECKLIST.md",
      templatePath: "templates/verification/a2ui-proof-bundle.md",
      blockingIssues: [],
      steps: [
        {
          stepId: "preflight",
          title: "Capture live A2UI contract state",
          status: "ready",
          instructions:
            "Confirm a2ui.v1, scopes (ui_canvas, platform_canvas), transports (local_session, companion_session), and the current canvas summary from System before starting operator proof.",
          evidenceHint: "Capture the System-page contract summary.",
        },
      ],
      markdown: "# A2UI Proof Bundle Draft",
    });
    apiMocks.exportA2UIProofLaneDraft.mockResolvedValue({
      laneId: "a2ui",
      generatedAt: "2026-03-29T00:05:30.000Z",
      summary:
        "A2UI proof lane is aligned to the current Android-signed-session runtime; rerun the Office Lab handoff and directed-move pass only when the contract, deployment profile, or operator flow changes.",
      relativePath:
        "artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
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
      expect(initialText).toContain(
        "Saved browser proof artifact: artifacts/follow-on-parity/browser/2026-03-28/browser-control-proof-bundle-trusted_local-2026-03-28T23-55-00-000Z.md",
      );
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
      expect(text).toContain("OpenClaw Parity");
      expect(text).toContain("7 / 7 complete");
      expect(text).toContain("4 open");
      expect(text).toContain("next GC-P2-12");
      expect(text).toContain("Full-program status: 7 complete · 4 open · next GC-P2-12");
      expect(text).toContain("Completion order: GC-P2-12 -> GC-P1-09 -> GC-P0-02 -> GC-P0-03 -> GC-P1-04");
      expect(text).toContain("Blockers: repo runtime 3 · manual/operator 4 · external repo 0 · publication 0");
      expect(text).toContain(
        "Unsafe to claim yet: Slack, Telegram, Google Chat, Teams, and Discord are not yet safe to claim as fully stabilized inbound/outbound channels.",
      );
      expect(text).toContain(
        "Unsafe to claim yet: Tier-1 planned channels remain unfinished: WhatsApp, iMessage/BlueBubbles, and Signal.",
      );
      expect(text).toContain(
        "Follow-on runtime posture: trusted_local · auth token · voice ready · browser 4 control tool(s).",
      );
      expect(text).toContain(
        "Voice next action: Generate the voice proof-lane draft from System, then run the transcription, Talk Mode, and Wake Mode operator cycle.",
      );
      expect(text).toContain(
        "Voice proof status: current · latest profile trusted_local · matches current profile · 0 day(s) old",
      );
      expect(text).toContain("Generate voice proof draft");
      expect(text).toContain("Export voice proof artifact");
      expect(text).toContain(
        "Voice proof lane: Voice proof lane is ready with runtime ready, model base.en, talk stopped, and wake disabled.",
      );
      expect(text).toContain(
        "Checklist docs/testing/VOICE_VALIDATION_CHECKLIST.md · Template templates/verification/voice-proof-bundle.md",
      );
      expect(text).toContain("Voice proof step: Confirm voice runtime posture");
      expect(text).toContain(
        "Saved voice proof artifact: artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      );
      expect(text).toContain("Artifact bytes 384 · generated 2026-03-29T00:04:00.000Z");
      expect(text).toContain(
        "Browser posture: Trusted-local posture allows the full browser family, including cookie and storage tools, with normal guardrails.",
      );
      expect(text).toContain("Browser state tools in trusted_local");
      expect(text).toContain("allowed browser.cookies.get, browser.storage.get");
      expect(text).toContain("blocked none");
      expect(text).toContain(
        "Browser next action: Current browser proof artifact matches the active deployment profile; rerun the lane only after browser tooling, guardrails, or deployment-profile posture changes.",
      );
      expect(text).toContain(
        "Browser proof status: current · latest profile trusted_local · matches current profile · 0 day(s) old",
      );
      expect(text).toContain("Generate browser proof draft");
      expect(text).toContain("Export browser proof artifact");
      expect(text).toContain(
        "Browser proof lane: Browser proof lane is ready for trusted_local with 4 read tool(s) and 4 control tool(s).",
      );
      expect(text).toContain(
        "Checklist docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md · Template templates/verification/browser-control-proof-bundle.md",
      );
      expect(text).toContain("Browser proof step: Confirm live browser surface");
      expect(text).toContain("Confirm the current browser tool counts before starting the operator pass.");
      expect(text).toContain(
        "Saved browser proof artifact: artifacts/follow-on-parity/browser/2026-03-29/browser-control-proof-bundle-trusted_local-2026-03-29T00-05-00-000Z.md",
      );
      expect(text).toContain("Artifact bytes 448 · generated 2026-03-29T00:05:00.000Z");
      expect(text).toContain("Packaging posture is trusted_local with auth mode token");
      expect(text).toContain(
        "Packaging summary: Packaging is currently operating in trusted_local posture, which is useful for operator validation but not the full hardened deployment lane.",
      );
      expect(text).toContain(
        "Packaging proof status: current · latest profile trusted_local · matches current profile · 0 day(s) old",
      );
      expect(text).toContain("Generate packaging proof draft");
      expect(text).toContain("Export packaging proof artifact");
      expect(text).toContain(
        "Packaging proof lane: Packaging proof lane is ready with trusted_local, token auth, and 2 allowlisted host(s).",
      );
      expect(text).toContain(
        "Checklist docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md · Template templates/verification/packaging-deployment-proof-bundle.md",
      );
      expect(text).toContain("Packaging proof step: Capture deployment posture");
      expect(text).toContain("Confirm the current deployment profile before running install proof.");
      expect(text).toContain(
        "Packaging next action: Record each packaging parity run with templates/verification/packaging-deployment-proof-bundle.md.",
      );
      expect(text).toContain(
        "Saved packaging proof artifact: artifacts/follow-on-parity/packaging/2026-03-29/packaging-deployment-proof-bundle-trusted_local-2026-03-29T00-06-00-000Z.md",
      );
      expect(text).toContain("Artifact bytes 472 · generated 2026-03-29T00:06:00.000Z");
      expect(text).toContain(
        "Canvas summary: A2UI contract a2ui.v1 now defines ui_canvas + platform_canvas scope for Canvas + A2UI via mission_control, with 1 declared canvas-capable platform target(s).",
      );
      expect(text).toContain(
        "A2UI proof status: current · latest profile trusted_local · matches current profile · 0 day(s) old",
      );
      expect(text).toContain(
        "Canvas contract: a2ui.v1 · scopes ui_canvas, platform_canvas · transports local_session, companion_session",
      );
      expect(text).toContain("Generate A2UI proof draft");
      expect(text).toContain("Export A2UI proof artifact");
      expect(text).toContain(
        "A2UI proof lane: A2UI proof lane is aligned to the current Android-signed-session runtime; rerun the Office Lab handoff and directed-move pass only when the contract, deployment profile, or operator flow changes.",
      );
      expect(text).toContain(
        "Checklist docs/testing/A2UI_VALIDATION_CHECKLIST.md · Template templates/verification/a2ui-proof-bundle.md",
      );
      expect(text).toContain("A2UI proof step: Capture live A2UI contract state");
      expect(text).toContain(
        "Saved A2UI proof artifact: artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      );
      expect(text).toContain("Artifact bytes 512 · generated 2026-03-29T00:05:30.000Z");
      expect(text).toContain(
        "Companion summary: companion.android.v1 defines an Android-first separate_repo bootstrap lane for 2 declared companion-capable platform target(s), and the gateway/session lane now has current Android runtime/UI proof recorded against the existing GoatCitadel-mobile repo.",
      );
      expect(text).toContain("Companion brief status: current · 0 day(s) old");
      expect(text).toContain(
        "Companion contract: companion.android.v1 · target android · repo GoatCitadel-mobile · status server_foundation",
      );
      expect(text).toContain(
        "Companion bootstrap: dashboard, chat, approvals, tasks, settings, event_feed · transports foreground_sse, push_refresh, manual_refresh",
      );
      expect(text).toContain(
        "Companion prerequisites: device_pairing, token_rotation, request_signing, sse_resume, per_device_audit",
      );
      expect(text).toContain("Companion auth readiness: Device identity");
      expect(text).toContain(
        "Gateway auth already supports device access requests, approvals, grants, and revocation for named devices.",
      );
      expect(text).toContain("Companion auth readiness: Short-lived access tokens");
      expect(text).toContain(
        "the gateway now issues dedicated short-lived companion access tokens through the companion session exchange route.",
      );
      expect(text).toContain("Companion prerequisite: SSE resume");
      expect(text).toContain("Last-Event-ID resume");
      expect(text).toContain("Companion prerequisite: Request signing");
      expect(text).toContain(
        "The auth pipeline now verifies companion Ed25519 request signatures and records replay-cache state on signed mutations.",
      );
      expect(text).toContain("Export companion bootstrap brief");
      expect(text).toContain(
        "Saved companion bootstrap brief: artifacts/follow-on-parity/companion/2026-03-29/companion-bootstrap-brief-2026-03-29T00-07-00-000Z.md",
      );
      expect(text).toContain("Artifact bytes 512 · generated 2026-03-29T00:07:00.000Z");
      expect(text).toContain(
        "Extension summary: 1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; the author contract is explicit and @goatcitadel/extensions-sdk@0.9.0-beta.1 is published to GitHub Packages as the current public beta SDK boundary.",
      );
      expect(text).toContain("Extension brief status: current · 0 day(s) old");
      expect(text).toContain("Reference plugin lifecycle: reference-integration-plugin");
      expect(text).toContain("installed · enabled · source aligned");
      expect(text).toContain("Reference plugin source: templates/integration-plugins/reference-integration-plugin");
      expect(text).toContain("Reference plugin capabilities: reference.install, lifecycle.smoke");
      expect(text).toContain(
        "Extension next action: Use docs/PLUGIN_SDK_CONTRACT.md as the current author-contract baseline for extension work.",
      );
      expect(text).toContain(
        "Extension next action: Use packages/extensions-sdk/ as the local author SDK baseline for manifest validation and file helpers.",
      );
      expect(text).toContain(
        "Extension next action: Use @goatcitadel/extensions-sdk@0.9.0-beta.1 from GitHub Packages when validating the external author-install flow.",
      );
      expect(text).toContain(
        "Extension next action: Use templates/integration-plugins/reference-integration-plugin/ as the local installable plugin reference path.",
      );
      expect(text).toContain(
        "Extension next action: Use the generated or exported extension starter pack when the current contract doc and reference scaffolds need to be handed off outside the repo.",
      );
      expect(text).toContain(
        "Extension next action: Keep a smoke test around discovery, install metadata, enable/disable, and runtime reporting for the reference plugin lifecycle.",
      );
      expect(text).toContain("Generate extension SDK brief");
      expect(text).toContain(
        "Extension SDK brief: 1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; the author contract is explicit and @goatcitadel/extensions-sdk@0.9.0-beta.1 is published to GitHub Packages as the current public beta SDK boundary. The public beta package already exists; the remaining decision is whether and when to widen the runtime contract beyond the current explicit boundary.",
      );
      expect(text).toContain("Export extension SDK brief");
      expect(text).toContain(
        "Saved extension SDK brief: artifacts/follow-on-parity/extensions/2026-03-29/extension-sdk-brief-2026-03-29T00-08-00-000Z.md",
      );
      expect(text).toContain("Artifact bytes 540 · generated 2026-03-29T00:08:00.000Z");
      expect(text).toContain("Generate extension starter pack");
      expect(text).toContain(
        "Extension starter pack: 1 cataloged add-on(s), 1 installed (1 running), and 2 integration plugin(s) (1 enabled) show operator breadth; a repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.",
      );
      expect(text).toContain(
        "Starter root: artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z",
      );
      expect(text).toContain("Export extension starter pack");
      expect(text).toContain(
        "Saved extension starter pack: artifacts/follow-on-parity/extensions/starter-pack/2026-03-29/extension-starter-pack-2026-03-29T00-09-00-000Z",
      );
      expect(text).toContain("Starter pack files 6 · total bytes 4096");
      expect(text).toContain("GC-P0-02 · Stabilize core beta channels");
      expect(text).toContain(
        "Blocker [ repo runtime ]: Slack, Telegram, Google Chat, Teams, and Discord still need the last inbound/runtime hardening tranche before the full stabilization claim is defensible.",
      );
      expect(text).toContain("GC-P0-03 · Ship Tier-1 planned channels");
      expect(text).toContain(
        "Blocker [ manual/operator ]: Tier-1 channels still need repeatable operator proof before catalog maturity can be promoted truthfully.",
      );
      expect(text).toContain("GC-P0-06 · Browser control parity");
      expect(text).toContain(
        "Keep the browser proof current and rerun the lane only when browser tooling, guardrails, or deployment-profile posture changes.",
      );
      expect(text).toContain(
        "Next slice: Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.",
      );
      expect(text).toContain("Android Canvas/Camera/Screen (beta), iOS Canvas/Camera/Voice (planned)");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps the page usable when the follow-on parity report fails", async () => {
    apiMocks.fetchOpenclawParityReport.mockRejectedValue(new Error("program unavailable"));
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
      relativePath:
        "artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/a2ui/2026-03-29/a2ui-proof-bundle-trusted_local-2026-03-29T00-05-30-000Z.md",
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
      relativePath:
        "artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
      fullPath:
        "workspace/artifacts/follow-on-parity/voice/2026-03-29/voice-proof-bundle-trusted_local-2026-03-29T00-04-00-000Z.md",
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
      expect(text).toContain("OpenClaw parity program unavailable: program unavailable");
      expect(text).toContain("Follow-on parity report unavailable: report unavailable");
    } finally {
      renderer.unmount();
    }
  });

  it("normalizes sparse system and parity payloads without crashing", async () => {
    apiMocks.fetchSystemVitals.mockResolvedValue({
      hostname: "goat-box",
    });
    apiMocks.fetchOpenclawParityReport.mockResolvedValue({
      generatedAt: "2026-03-29T00:00:00.000Z",
      epics: [
        {
          epicId: "GC-P2-12",
          label: "Voice Wake / Talk Mode parity",
        },
      ],
    });
    apiMocks.fetchFollowOnParityReport.mockResolvedValue({
      generatedAt: "2026-03-29T00:00:00.000Z",
      canvas: {
        contract: {
          contractId: "a2ui.v1",
        },
      },
      companion: {
        contract: {
          contractId: "companion.android.v1",
        },
      },
    });
    apiMocks.fetchBrowserProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:05:00.000Z",
    });
    apiMocks.fetchPackagingProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:06:00.000Z",
    });
    apiMocks.fetchVoiceProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:04:00.000Z",
    });
    apiMocks.fetchA2UIProofLaneDraft.mockResolvedValue({
      generatedAt: "2026-03-29T00:05:30.000Z",
    });
    apiMocks.fetchExtensionSdkBrief.mockResolvedValue({
      generatedAt: "2026-03-29T00:08:00.000Z",
    });
    apiMocks.fetchExtensionStarterPack.mockResolvedValue({
      generatedAt: "2026-03-29T00:09:00.000Z",
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SystemPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Host Vitals");
      expect(text).toContain("0.00 / 0.00 / 0.00");
      expect(text).toContain("Voice Wake / Talk Mode parity");
      expect(text).toContain("Canvas contract: a2ui.v1");
      expect(text).toContain("Companion contract: companion.android.v1");
      expect(text).toContain("Browser proof lane has not been generated yet.");
      expect(text).toContain("Extension starter pack has not been generated yet.");
    } finally {
      renderer.unmount();
    }
  });
});
