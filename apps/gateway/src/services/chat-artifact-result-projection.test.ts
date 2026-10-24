import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  projectArtifactPathsInAnswer,
  projectArtifactToolResultForModel,
  toWorkspaceRelativePath,
} from "./chat-artifact-result-projection.js";

const WORKSPACE_ROOT = path.join(os.tmpdir(), "goatcitadel-505", "workspace");
const ARTIFACT_PATH = path.join(WORKSPACE_ROOT, "artifacts", "Sandbox_Test_Brief.pdf");

// The documents.create result shape from the 2026-10-22 usability pass (#505).
function documentResult(artifactPath = ARTIFACT_PATH): Record<string, unknown> {
  return {
    path: artifactPath,
    bytesWritten: 4_096,
    format: "pdf",
    mimeType: "application/pdf",
    title: "Sandbox Test Brief",
    sectionCount: 2,
    designReport: {
      mode: "auto",
      preset: "clean-professional",
      visualLevel: "polished",
      assetPolicy: "auto",
      layouts: ["cover", "section"],
      assetSources: [],
      skippedAssets: [],
      validation: [
        {
          id: "design-skill-applied",
          label: "Design skill applied",
          status: "warning",
          detail: "Renderer design defaults ran, but no governed runtime design-instruction receipt was attached.",
        },
      ],
      guideReferences: [{ id: "impeccable", title: "Impeccable", path: "skills/impeccable/SKILL.md" }],
      localPath: artifactPath,
      google: { requested: false, status: "not_requested", mode: "convert" },
      residualRisks: [
        "PDF reports use standard Helvetica text and built-in color shapes; photos and custom fonts are not embedded.",
      ],
      designQuality: {
        skillId: "impeccable",
        register: "docs/evidence",
        lifecycle: "Polish",
        status: "warning",
        retryAttempted: true,
        findings: [],
        runtimeInstructions: { status: "not_injected", skills: [] },
      },
    },
  };
}

function executedRun(toolName: string, result: Record<string, unknown>): ChatToolRunRecord {
  return {
    toolRunId: `run-${toolName}`,
    turnId: "turn-505",
    sessionId: "sess-505",
    toolName,
    status: "executed",
    args: {},
    result,
    startedAt: "2026-10-24T00:00:00.000Z",
    finishedAt: "2026-10-24T00:00:01.000Z",
  } as ChatToolRunRecord;
}

describe("toWorkspaceRelativePath", () => {
  it("returns a forward-slash path for a file inside the workspace", () => {
    expect(toWorkspaceRelativePath(ARTIFACT_PATH, WORKSPACE_ROOT)).toBe("artifacts/Sandbox_Test_Brief.pdf");
  });

  it("returns undefined outside the workspace, for relative input, or without a root", () => {
    expect(toWorkspaceRelativePath(path.join(os.tmpdir(), "elsewhere.pdf"), WORKSPACE_ROOT)).toBeUndefined();
    expect(toWorkspaceRelativePath("artifacts/brief.pdf", WORKSPACE_ROOT)).toBeUndefined();
    expect(toWorkspaceRelativePath(ARTIFACT_PATH, undefined)).toBeUndefined();
    expect(toWorkspaceRelativePath(WORKSPACE_ROOT, WORKSPACE_ROOT)).toBeUndefined();
  });
});

describe("projectArtifactToolResultForModel", () => {
  it("gives the model a workspace-relative path and plain design caveats, not the local path or receipts", () => {
    const projected = projectArtifactToolResultForModel("documents.create", documentResult(), WORKSPACE_ROOT);
    const serialized = JSON.stringify(projected);

    expect(projected.path).toBe("artifacts/Sandbox_Test_Brief.pdf");
    expect(serialized).not.toContain(WORKSPACE_ROOT.replaceAll("\\", "\\\\"));
    expect(serialized).not.toMatch(/receipt|governed|impeccable|design-skill-applied/iu);
    expect(projected.designReport).toEqual({
      style: "clean-professional",
      caveats: [
        "PDF reports use standard Helvetica text and built-in color shapes; photos and custom fonts are not embedded.",
      ],
    });
    expect(projected).toMatchObject({ bytesWritten: 4_096, format: "pdf", title: "Sandbox Test Brief" });
  });

  it("keeps a Google import outcome the model has to report", () => {
    const result = documentResult();
    (result.designReport as Record<string, unknown>).google = {
      requested: true,
      status: "failed",
      mode: "convert",
      reason: "No Google Drive connector is configured.",
    };
    const projected = projectArtifactToolResultForModel("documents.create", result, WORKSPACE_ROOT);
    expect(projected.designReport).toMatchObject({
      googleImport: { status: "failed", reason: "No Google Drive connector is configured." },
    });
  });

  it("does not mutate the stored result the trace and download receipts read", () => {
    const result = documentResult();
    projectArtifactToolResultForModel("documents.create", result, WORKSPACE_ROOT);
    expect(result.path).toBe(ARTIFACT_PATH);
    expect((result.designReport as Record<string, unknown>).localPath).toBe(ARTIFACT_PATH);
  });

  it("leaves a path outside the workspace as the runtime reported it", () => {
    const outside = path.join(os.tmpdir(), "goatcitadel-505-outside", "brief.pdf");
    const projected = projectArtifactToolResultForModel("documents.create", documentResult(outside), WORKSPACE_ROOT);
    expect(projected.path).toBe(outside);
  });

  it("projects fallbackPath and leaves other tools alone", () => {
    const projected = projectArtifactToolResultForModel(
      "presentations.create",
      { fallbackPath: path.join(WORKSPACE_ROOT, "goatcitadel_out", "deck.pptx"), bytesWritten: 10 },
      WORKSPACE_ROOT,
    );
    expect(projected.fallbackPath).toBe("goatcitadel_out/deck.pptx");
    const untouched = { path: ARTIFACT_PATH, content: "x" };
    expect(projectArtifactToolResultForModel("fs.read", untouched, WORKSPACE_ROOT)).toBe(untouched);
  });
});

describe("projectArtifactPathsInAnswer", () => {
  const runs = [executedRun("documents.create", documentResult())];

  it("replaces the artifact's absolute path in either separator style", () => {
    const answer = [`The full path is ${ARTIFACT_PATH}.`, `Also at \`${ARTIFACT_PATH.replaceAll("\\", "/")}\`.`].join(
      "\n",
    );
    const projected = projectArtifactPathsInAnswer(answer, runs, WORKSPACE_ROOT);
    expect(projected).toBe(
      ["The full path is artifacts/Sandbox_Test_Brief.pdf.", "Also at `artifacts/Sandbox_Test_Brief.pdf`."].join("\n"),
    );
  });

  it("keeps a file name with spaces and replacement tokens intact", () => {
    const spaced = path.join(WORKSPACE_ROOT, "goatcitadel_out", "Q1 $& plan.pdf");
    const projected = projectArtifactPathsInAnswer(
      `Saved to ${spaced}.`,
      [executedRun("documents.create", documentResult(spaced))],
      WORKSPACE_ROOT,
    );
    expect(projected).toBe("Saved to goatcitadel_out/Q1 $& plan.pdf.");
  });

  it("strips the workspace root from other paths under it and from a bare mention", () => {
    const answer = `Saved under ${path.join(WORKSPACE_ROOT, "artifacts")} in ${WORKSPACE_ROOT}.`;
    expect(projectArtifactPathsInAnswer(answer, runs, WORKSPACE_ROOT)).toBe(
      "Saved under artifacts in the workspace folder.",
    );
  });

  it("keeps unrelated absolute paths and answers without an artifact write", () => {
    const unrelated = path.join(os.tmpdir(), "goatcitadel-505-other", "notes.txt");
    expect(projectArtifactPathsInAnswer(`See ${unrelated}.`, runs, WORKSPACE_ROOT)).toBe(`See ${unrelated}.`);
    const answer = `The full path is ${ARTIFACT_PATH}.`;
    expect(projectArtifactPathsInAnswer(answer, [], WORKSPACE_ROOT)).toBe(answer);
    expect(projectArtifactPathsInAnswer(answer, runs, undefined)).toBe(answer);
  });
});
