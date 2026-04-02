import { describe, expect, it } from "vitest";
import type { FollowOnParityReport } from "@goatcitadel/contracts";
import { buildOpenclawParityProgramReport } from "./openclaw-parity-report.js";

function buildFollowOnParityMock(): FollowOnParityReport {
  return {
    generatedAt: "2026-04-01T18:00:00.000Z",
    deploymentProfile: "trusted_local",
    authMode: "token",
    packaging: {
      allowLoopbackBypass: false,
      networkAllowlistCount: 2,
      postureSummary: "Packaging is currently operating in trusted_local posture.",
      proofStatus: {
        hasArtifact: false,
        freshness: "missing",
        matchedCurrentProfile: false,
      },
      blockingIssues: [],
      recommendedActions: [],
    },
    browser: {
      totalToolCount: 8,
      readToolCount: 4,
      controlToolCount: 4,
      guardrailSummary: "Trusted-local posture allows the full browser family.",
      stateToolRuntime: {
        restrictedToProfile: "trusted_local",
        registeredTools: ["browser.cookies.get", "browser.storage.get"],
        allowedTools: ["browser.cookies.get", "browser.storage.get"],
        blockedTools: [],
      },
      artifactStatus: {
        hasArtifact: false,
        freshness: "missing",
        matchedCurrentProfile: false,
      },
      blockingIssues: [
        "Browser control catalog maturity is not yet at a shipped operator-ready level.",
      ],
      recommendedActions: [],
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
      recommendedActions: [],
    },
    addons: {
      catalogCount: 1,
      installedCount: 1,
      runningCount: 1,
    },
    plugins: {
      totalCount: 1,
      enabledCount: 1,
      sdkSummary: "Local SDK exists but publication is still open.",
      referenceLifecycle: {
        referencePluginId: "reference-integration-plugin",
        present: true,
        enabled: true,
        source: "templates/integration-plugins/reference-integration-plugin",
        matchesReferenceSource: true,
        capabilities: ["reference.install"],
      },
      artifactStatus: {
        hasArtifact: false,
        freshness: "missing",
      },
      blockingIssues: [
        "A local workspace author SDK package and installable reference integration plugin now exist, but there is still no published SDK package or broader runtime contract.",
      ],
      recommendedActions: [],
    },
    canvas: {
      paritySummary: "A2UI contract exists but Android proof is still missing.",
      artifactStatus: {
        hasArtifact: false,
        freshness: "missing",
        matchedCurrentProfile: false,
      },
      platformTargets: [
        {
          catalogId: "platform.android-canvas-camera-screen",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas"],
        },
      ],
      blockingIssues: [
        "A2UI contract v1 exists and the gateway session path is proven, but the Android/companion runtime lane still lacks platform proof.",
      ],
      recommendedActions: [],
    },
    companion: {
      paritySummary: "Gateway session proof exists but Android UI/runtime proof is still missing.",
      artifactStatus: {
        hasArtifact: false,
        freshness: "missing",
      },
      platformTargets: [
        {
          catalogId: "platform.android-canvas-camera-screen",
          label: "Android Canvas/Camera/Screen",
          maturity: "planned",
          capabilities: ["canvas"],
        },
      ],
      authReadiness: [],
      prerequisiteReadiness: [],
      blockingIssues: [
        "Gateway session/signing proof is complete, but the existing GoatCitadel-mobile runtime still needs Android UI/runtime proof on companion.android.v1.",
      ],
      recommendedActions: [],
    },
    epics: [
      {
        epicId: "GC-P0-06",
        label: "Browser control parity",
        state: "partial",
        summary: "8 browser tools are registered (4 read, 4 control).",
        nextSlice: "Use the browser proof lane.",
      },
      {
        epicId: "GC-P0-07",
        label: "Canvas / A2UI parity",
        state: "partial",
        summary: "A2UI contract exists but platform proof is still missing.",
        nextSlice: "Use the A2UI proof lane.",
      },
      {
        epicId: "GC-P1-08",
        label: "Companion apps / nodes / device surfaces",
        state: "partial",
        summary: "Gateway session proof exists but Android runtime/UI proof is still missing.",
        nextSlice: "Use companion.android.v1 against GoatCitadel-mobile.",
      },
      {
        epicId: "GC-P1-09",
        label: "Packaging and remote deployment parity",
        state: "partial",
        summary: "Packaging proof is still missing.",
        nextSlice: "Use the packaging proof lane.",
      },
      {
        epicId: "GC-P1-10",
        label: "Long-tail parity register",
        state: "have_foundation",
        summary: "Live report exists.",
        nextSlice: "Keep contracts and docs aligned.",
      },
      {
        epicId: "GC-P2-11",
        label: "Extension / plugin SDK breadth",
        state: "partial",
        summary: "Local SDK exists but publication is still open.",
        nextSlice: "Decide publication boundary.",
      },
      {
        epicId: "GC-P2-12",
        label: "Voice Wake / Talk Mode parity",
        state: "partial",
        summary: "Voice is ready but proof is still missing.",
        nextSlice: "Use the voice proof lane.",
      },
    ],
  };
}

describe("buildOpenclawParityProgramReport", () => {
  it("classifies repo, manual, external, and publication blockers in the full-program report", () => {
    const report = buildOpenclawParityProgramReport(buildFollowOnParityMock());

    expect(report.blockerCounts).toEqual({
      repo_runtime: 6,
      manual_operator: 8,
      external_repo: 2,
      publication: 1,
    });

    const tierOne = report.epics.find((epic) => epic.epicId === "GC-P0-03");
    expect(tierOne?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "repo_runtime" }),
      expect.objectContaining({ kind: "manual_operator" }),
    ]));

    const canvas = report.epics.find((epic) => epic.epicId === "GC-P0-07");
    expect(canvas?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "external_repo",
        summary: expect.stringContaining("GoatCitadel-mobile"),
      }),
      expect.objectContaining({ kind: "manual_operator" }),
    ]));

    const extensions = report.epics.find((epic) => epic.epicId === "GC-P2-11");
    expect(extensions?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "publication" }),
      expect.objectContaining({ kind: "repo_runtime" }),
    ]));

    const voice = report.epics.find((epic) => epic.epicId === "GC-P2-12");
    expect(voice?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "manual_operator",
        summary: expect.stringContaining("Voice proof artifact is still missing"),
      }),
    ]));
  });
});
