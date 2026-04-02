import { describe, expect, it, vi } from "vitest";
import {
  buildExtensionStarterPackArtifact,
  buildExtensionStarterPackArtifactRoot,
  buildExtensionStarterPackDraft,
  buildExtensionStarterPackFiles,
} from "./extension-starter-pack.js";

describe("extension starter pack", () => {
  it("builds a starter-pack draft from live parity state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T18:14:00.000Z"));

    const draft = buildExtensionStarterPackDraft({
      generatedAt: "2026-03-31T18:14:00.000Z",
      deploymentProfile: "trusted_local",
      authMode: "token",
      packaging: {
        allowLoopbackBypass: false,
        networkAllowlistCount: 1,
        postureSummary: "",
        proofStatus: { hasArtifact: false, freshness: "missing", matchedCurrentProfile: false },
        blockingIssues: [],
        recommendedActions: [],
      },
      browser: {
        totalToolCount: 0,
        readToolCount: 0,
        controlToolCount: 0,
        guardrailSummary: "",
        stateToolRuntime: {
          restrictedToProfile: "trusted_local",
          registeredTools: [],
          allowedTools: [],
          blockedTools: [],
        },
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
        blockingIssues: [],
        recommendedActions: [],
      },
      voice: {
        runtimeReadiness: "ready",
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
        totalCount: 2,
        enabledCount: 1,
        sdkSummary: "Operator breadth is present but the SDK/package story is still partial.",
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
        platformTargets: [],
        paritySummary: "",
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
          matchedCurrentProfile: false,
        },
        blockingIssues: [],
        recommendedActions: [],
      },
      companion: {
        platformTargets: [],
        authReadiness: [],
        prerequisiteReadiness: [],
        paritySummary: "",
        artifactStatus: {
          hasArtifact: false,
          freshness: "missing",
        },
        blockingIssues: [],
        recommendedActions: [],
      },
      epics: [],
    });

    expect(draft.summary).toContain("repo-native starter pack");
    expect(draft.starterRoot).toBe(
      "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z",
    );
    expect(draft.files).toContain(
      "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z/docs/PLUGIN_SDK_CONTRACT.md",
    );
    expect(draft.markdown).toContain("Included Files");
  });

  it("builds starter-pack files from repo templates", async () => {
    const draft = {
      generatedAt: "2026-03-31T18:14:00.000Z",
      summary: "starter summary",
      starterRoot: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z",
      files: [],
      markdown: "# Extension Starter Pack",
    };

    const files = await buildExtensionStarterPackFiles(draft);

    expect(files).toHaveLength(6);
    expect(files[0]).toEqual(expect.objectContaining({
      relativePath: `${draft.starterRoot}/README.md`,
      content: expect.stringContaining("# GoatCitadel Extension Starter Pack"),
    }));
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: `${draft.starterRoot}/docs/PLUGIN_SDK_CONTRACT.md`,
        content: expect.stringContaining("# Plugin And Add-on SDK Contract"),
      }),
      expect.objectContaining({
        relativePath: `${draft.starterRoot}/addons/reference-separate-repo-addon/goatcitadel.addon.json`,
        content: expect.stringContaining("\"schemaVersion\": 1"),
      }),
      expect.objectContaining({
        relativePath: `${draft.starterRoot}/integration-plugins/reference-integration-plugin/goatcitadel.integration-plugin.json`,
        content: expect.stringContaining("\"pluginId\": \"reference-integration-plugin\""),
      }),
    ]));
  });

  it("summarizes exported starter-pack files", () => {
    const artifact = buildExtensionStarterPackArtifact(
      {
        generatedAt: "2026-03-31T18:14:00.000Z",
        summary: "starter summary",
        starterRoot: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z",
        files: [],
        markdown: "",
      },
      [
        {
          relativePath: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z/README.md",
          fullPath: "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z/README.md",
          bytes: 100,
        },
        {
          relativePath: "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z/docs/PLUGIN_SDK_CONTRACT.md",
          fullPath: "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z/docs/PLUGIN_SDK_CONTRACT.md",
          bytes: 200,
        },
      ],
    );

    expect(artifact.fileCount).toBe(2);
    expect(artifact.totalBytes).toBe(300);
    expect(artifact.files).toHaveLength(2);
  });

  it("builds a stable artifact root from generated time", () => {
    expect(buildExtensionStarterPackArtifactRoot("2026-03-31T18:14:00.000Z")).toBe(
      "artifacts/follow-on-parity/extensions/starter-pack/2026-03-31/extension-starter-pack-2026-03-31T18-14-00-000Z",
    );
  });
});
