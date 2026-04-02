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
      proofCoverage: {
        currentProfiles: [],
        staleProfiles: [],
        missingProfiles: ["local_dev", "trusted_local", "remote_hardened"],
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
      proofCoverage: {
        currentProfiles: [],
        staleProfiles: [],
        missingProfiles: ["local_dev", "trusted_local", "remote_hardened"],
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
      sdkSummary: "Local SDK exists and the published beta boundary is explicit.",
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
      blockingIssues: [],
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
        summary: "Local SDK exists and the published beta boundary is explicit.",
        nextSlice: "Keep the published beta SDK package green.",
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
      repo_runtime: 0,
      manual_operator: 2,
      external_repo: 0,
      publication: 0,
    });

    const tierOne = report.epics.find((epic) => epic.epicId === "GC-P0-03");
    expect(tierOne).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const tierTwo = report.epics.find((epic) => epic.epicId === "GC-P1-04");
    expect(tierTwo).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const coreBeta = report.epics.find((epic) => epic.epicId === "GC-P0-02");
    expect(coreBeta).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const canvas = report.epics.find((epic) => epic.epicId === "GC-P0-07");
    expect(canvas).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const companion = report.epics.find((epic) => epic.epicId === "GC-P1-08");
    expect(companion).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const extensions = report.epics.find((epic) => epic.epicId === "GC-P2-11");
    expect(extensions).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const longTail = report.epics.find((epic) => epic.epicId === "GC-P1-10");
    expect(longTail).toMatchObject({
      status: "complete",
      blockers: [],
    });

    const voice = report.epics.find((epic) => epic.epicId === "GC-P2-12");
    expect(voice?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "manual_operator",
        summary: expect.stringContaining("Voice proof artifact is still missing"),
      }),
    ]));
    expect(report.completedEpicIds).toEqual(expect.arrayContaining(["GC-P0-02", "GC-P0-03", "GC-P1-04"]));
    expect(report.openEpicIds).not.toEqual(expect.arrayContaining(["GC-P0-02", "GC-P0-03", "GC-P1-04"]));
  });

  it("closes the Android companion and A2UI epics when current proof is on file", () => {
    const base = buildFollowOnParityMock();
    const report = buildOpenclawParityProgramReport({
      ...base,
      canvas: {
        ...base.canvas,
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "trusted_local",
          matchedCurrentProfile: true,
          ageDays: 0,
        },
        blockingIssues: [],
      },
      companion: {
        ...base.companion,
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          ageDays: 0,
        },
        blockingIssues: [],
      },
      epics: base.epics.map((epic) => (
        epic.epicId === "GC-P0-07" || epic.epicId === "GC-P1-08"
          ? { ...epic, state: "have_foundation" as const }
          : epic
      )),
    });

    const canvas = report.epics.find((epic) => epic.epicId === "GC-P0-07");
    const companion = report.epics.find((epic) => epic.epicId === "GC-P1-08");

    expect(canvas).toMatchObject({
      status: "complete",
      blockers: [],
    });
    expect(companion).toMatchObject({
      status: "complete",
      blockers: [],
    });
  });

  it("keeps voice in progress but stops calling it a missing-proof problem when the active local proof is clean", () => {
    const base = buildFollowOnParityMock();
    const report = buildOpenclawParityProgramReport({
      ...base,
      deploymentProfile: "local_dev",
      voice: {
        ...base.voice,
        selectedModelId: "tiny.en",
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "local_dev",
          matchedCurrentProfile: true,
          ageDays: 0,
        },
      },
      epics: base.epics.map((epic) => (
        epic.epicId === "GC-P2-12"
          ? {
            ...epic,
            state: "have_foundation" as const,
            summary: "Voice runtime is ready on tiny.en and current operator proof is on file for local_dev.",
          }
          : epic
      )),
    });

    const voice = report.epics.find((epic) => epic.epicId === "GC-P2-12");

    expect(voice).toMatchObject({
      status: "in_progress",
      blockers: [
        expect.objectContaining({
          kind: "repo_runtime",
          summary: expect.stringContaining("current local-first voice proof lane is closed"),
        }),
      ],
    });
    expect(report.unsafeClaims).toContain(
      "Broader voice parity beyond the current local-first runtime lane still requires deliberate widening; do not over-claim cloud-grade or cross-profile parity from the current proof bundle.",
    );
    expect(report.unsafeClaims).not.toContain(
      "Voice parity still requires a current, profile-matched proof bundle before parity can be called complete for the active deployment posture.",
    );
  });

  it("closes voice when current managed-runtime proof covers local_dev, trusted_local, and remote_hardened", () => {
    const base = buildFollowOnParityMock();
    const report = buildOpenclawParityProgramReport({
      ...base,
      deploymentProfile: "remote_hardened",
      voice: {
        ...base.voice,
        selectedModelId: "tiny.en",
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "remote_hardened",
          matchedCurrentProfile: true,
          ageDays: 0,
        },
        proofCoverage: {
          currentProfiles: ["local_dev", "trusted_local", "remote_hardened"],
          staleProfiles: [],
          missingProfiles: [],
        },
      },
      epics: base.epics.map((epic) => (
        epic.epicId === "GC-P2-12"
          ? {
            ...epic,
            state: "have_foundation" as const,
            summary: "Voice runtime is ready on tiny.en and current operator proof now covers local_dev, trusted_local, and remote_hardened.",
          }
          : epic
      )),
    });

    const voice = report.epics.find((epic) => epic.epicId === "GC-P2-12");

    expect(voice).toMatchObject({
      status: "complete",
      blockers: [],
    });
    expect(report.completedEpicIds).toContain("GC-P2-12");
    expect(report.openEpicIds).not.toContain("GC-P2-12");
    expect(report.unsafeClaims).toContain(
      "Voice proof now covers the managed local-first runtime across local_dev, trusted_local, and remote_hardened; do not over-claim hosted or cloud voice parity beyond that lane.",
    );
  });

  it("closes browser when the active profile browser proof is current and clean", () => {
    const base = buildFollowOnParityMock();
    const report = buildOpenclawParityProgramReport({
      ...base,
      browser: {
        ...base.browser,
        artifactStatus: {
          hasArtifact: true,
          freshness: "current",
          latestArtifactDeploymentProfile: "trusted_local",
          matchedCurrentProfile: true,
          ageDays: 0,
        },
        blockingIssues: [],
      },
      epics: base.epics.map((epic) => (
        epic.epicId === "GC-P0-06"
          ? {
            ...epic,
            state: "have_foundation" as const,
            summary: "8 browser tools are registered and current operator proof is on file for trusted_local.",
          }
          : epic
      )),
    });

    const browser = report.epics.find((epic) => epic.epicId === "GC-P0-06");

    expect(browser).toMatchObject({
      status: "complete",
      blockers: [],
    });
    expect(report.completedEpicIds).toContain("GC-P0-06");
    expect(report.openEpicIds).not.toContain("GC-P0-06");
    expect(report.completionOrder).not.toContain("GC-P0-06");
    expect(report.unsafeClaims).not.toContain(
      "Signal, Zalo OA, Zalo Personal, browser, and packaging still require additional work or fresh evidence before parity can be called complete.",
    );
  });
});
