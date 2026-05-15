import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowOnParityReport } from "@goatcitadel/contracts";
import { buildExtensionSdkArtifactPath, buildExtensionSdkBrief } from "./extension-sdk-brief.js";

describe("extension SDK brief", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a dated operator brief from the live parity report", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:34:56.789Z"));

    const draft = buildExtensionSdkBrief(
      createReport({
        deploymentProfile: "local",
        authMode: "token",
        addons: {
          catalogCount: 5,
          installedCount: 2,
          runningCount: 1,
        },
        plugins: {
          totalCount: 4,
          enabledCount: 3,
          sdkSummary: "The SDK surface is published and smoke-tested.",
          referenceLifecycle: {
            present: true,
            enabled: true,
            matchesReferenceSource: true,
            capabilities: ["manifest", "lifecycle"],
          },
          blockingIssues: ["external publishing needs release approval"],
          recommendedActions: ["Keep the reference plugin green", "Publish the starter pack"],
        },
      }),
    );

    expect(draft.generatedAt).toBe("2026-05-14T12:34:56.789Z");
    expect(draft.summary).toContain("The SDK surface is published and smoke-tested.");
    expect(draft.markdown).toContain("Deployment profile: local");
    expect(draft.markdown).toContain("Auth mode: token");
    expect(draft.markdown).toContain("Contract doc: docs/PLUGIN_SDK_CONTRACT.md");
    expect(draft.markdown).toContain("Workspace SDK package: packages/extensions-sdk");
    expect(draft.markdown).toContain("Template baseline: templates/verification/extension-sdk-brief.md");
    expect(draft.markdown).toContain("- Add-on catalog count: 5");
    expect(draft.markdown).toContain("- Reference plugin present: yes");
    expect(draft.markdown).toContain("- Reference plugin enabled: yes");
    expect(draft.markdown).toContain("- Reference plugin source aligned: yes");
    expect(draft.markdown).toContain("- Reference plugin capabilities: manifest, lifecycle");
    expect(draft.markdown).toContain("- Blocking issues: external publishing needs release approval");
    expect(draft.markdown).toContain("1. Keep the reference plugin green");
    expect(draft.markdown).toContain("2. Publish the starter pack");
    expect(draft.markdown).toContain("@goatcitadel/extensions-sdk@1.0.0");
  });

  it("renders empty extension findings explicitly and creates a stable artifact path", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T01:02:03.004Z"));

    const draft = buildExtensionSdkBrief(
      createReport({
        deploymentProfile: "desktop",
        authMode: "none",
        addons: {
          catalogCount: 0,
          installedCount: 0,
          runningCount: 0,
        },
        plugins: {
          totalCount: 0,
          enabledCount: 0,
          sdkSummary: "No extension runtime has been enabled.",
          referenceLifecycle: {
            present: false,
            enabled: false,
            matchesReferenceSource: false,
            capabilities: [],
          },
          blockingIssues: [],
          recommendedActions: [],
        },
      }),
    );

    expect(draft.markdown).toContain("- Reference plugin present: no");
    expect(draft.markdown).toContain("- Reference plugin enabled: no");
    expect(draft.markdown).toContain("- Reference plugin source aligned: no");
    expect(draft.markdown).toContain("- Reference plugin capabilities: none recorded");
    expect(draft.markdown).toContain("- Blocking issues: none");
    expect(buildExtensionSdkArtifactPath(draft)).toBe(
      "artifacts/follow-on-parity/extensions/2026-05-15/extension-sdk-brief-2026-05-15T01-02-03-004Z.md",
    );
  });
});

function createReport(
  overrides: Pick<FollowOnParityReport, "addons" | "authMode" | "deploymentProfile" | "plugins">,
): FollowOnParityReport {
  return {
    generatedAt: "2026-05-14T00:00:00.000Z",
    packaging: {
      allowLoopbackBypass: false,
      networkAllowlistCount: 0,
      postureSummary: "local",
      proofStatus: "ok",
      proofCoverage: {
        currentProfiles: [],
        staleProfiles: [],
        missingProfiles: [],
      },
      blockingIssues: [],
      recommendedActions: [],
    },
    browser: {
      totalToolCount: 0,
      readToolCount: 0,
      controlToolCount: 0,
      guardrailSummary: "local",
      stateToolRuntime: {
        restrictedToProfile: "local",
        registeredTools: [],
        allowedTools: [],
        blockedTools: [],
      },
      artifactStatus: "ok",
      blockingIssues: [],
      recommendedActions: [],
    },
    voice: {
      runtimeReadiness: "ready",
      talkState: "ready",
      wakeState: "disabled",
      wakeEnabled: false,
      artifactStatus: "ok",
      proofCoverage: {
        currentProfiles: [],
        staleProfiles: [],
        missingProfiles: [],
      },
      blockingIssues: [],
      recoveryActions: [],
      recommendedActions: [],
    },
    canvas: {
      platformTargets: [],
      paritySummary: "local",
      artifactStatus: "ok",
      blockingIssues: [],
      recommendedActions: [],
    },
    companion: {
      platformTargets: [],
      authReadiness: [],
      prerequisiteReadiness: [],
      paritySummary: "local",
      artifactStatus: "ok",
      blockingIssues: [],
      recommendedActions: [],
    },
    epics: [],
    ...overrides,
  };
}
