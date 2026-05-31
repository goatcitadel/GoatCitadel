import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCodeModeAiderAdapterInvocationPlan } from "./code-mode-aider-adapter-plan.js";
import {
  persistCodeModeAiderArtifactBundle,
  type CodeModeAiderArtifactPersister,
} from "./code-mode-aider-artifacts.js";

describe("code-mode-aider-artifacts", () => {
  it("persists audit-only Aider request, plan, envelope, patch, stdout, and stderr evidence", async () => {
    const persisted: Array<{ filename: string; content: string; mimeType: string }> = [];
    const bundle = await persistCodeModeAiderArtifactBundle(fakePersister(persisted), {
      runId: "code-run-1",
      requestMarkdown: "Implement the approved Code Mode task.",
      invocationPlan: buildCodeModeAiderAdapterInvocationPlan({
        runId: "code-run-1",
        repositoryRootRelPath: "repo",
      }),
      outcome: "patch_produced",
      patch: {
        kind: "unified_diff",
        content: "diff --git a/file.ts b/file.ts\n",
        baseRef: "base",
        headRef: "head",
        fileCount: 1,
      },
      stdout: "done",
      stderr: "warning",
      command: {
        exitCode: 0,
        startedAt: "2026-05-31T00:00:00.000Z",
        finishedAt: "2026-05-31T00:00:01.000Z",
      },
    });

    expect(persisted.map((entry) => entry.filename)).toEqual([
      "request.md",
      "invocation-plan.json",
      "aider.patch",
      "stdout.log",
      "stderr.log",
      "result-envelope.json",
    ]);
    expect(bundle.envelope).toMatchObject({
      adapterId: "aider-cli-adapter",
      outcome: "patch_produced",
      runId: "code-run-1",
      patchArtifact: {
        kind: "unified_diff",
        baseRef: "base",
        headRef: "head",
        fileCount: 1,
      },
      stdoutArtifact: expect.objectContaining({ relPath: "code-run-1/aider/stdout.log" }),
      stderrArtifact: expect.objectContaining({ relPath: "code-run-1/aider/stderr.log" }),
      replay: {
        replaySafe: false,
        policy: "audit_only",
      },
    });
    expect(bundle.result.aiderAdapter.resultEnvelopeArtifact).toBe(bundle.resultEnvelopeArtifact);
  });

  it("refuses incomplete Aider evidence before persisting a result envelope", async () => {
    const persisted: Array<{ filename: string; content: string; mimeType: string }> = [];

    await expect(
      persistCodeModeAiderArtifactBundle(fakePersister(persisted), {
        runId: "code-run-1",
        requestMarkdown: "Implement the approved Code Mode task.",
        invocationPlan: buildCodeModeAiderAdapterInvocationPlan({
          runId: "code-run-1",
        }),
        outcome: "patch_produced",
      }),
    ).rejects.toThrow("patch_produced outcome requires patchArtifact");

    expect(persisted.map((entry) => entry.filename)).toEqual(["request.md", "invocation-plan.json"]);
  });

  it("requires the invocation plan to belong to the same run", async () => {
    await expect(
      persistCodeModeAiderArtifactBundle(fakePersister([]), {
        runId: "code-run-1",
        requestMarkdown: "Implement the approved Code Mode task.",
        invocationPlan: buildCodeModeAiderAdapterInvocationPlan({
          runId: "code-run-2",
        }),
        outcome: "no_changes",
      }),
    ).rejects.toThrow("invocation plan runId must match");
  });
});

function fakePersister(
  persisted: Array<{ filename: string; content: string; mimeType: string }>,
): CodeModeAiderArtifactPersister {
  const persistText: CodeModeAiderArtifactPersister["persistText"] = async (input) => {
    persisted.push({
      filename: input.filename,
      content: input.content,
      mimeType: input.mimeType,
    });
    return artifact(input.segments, input.filename, input.content, input.mimeType);
  };
  return {
    persistText,
    persistJson: async (input) => {
      const content = JSON.stringify(input.value);
      persisted.push({
        filename: input.filename,
        content,
        mimeType: "application/json",
      });
      return artifact(input.segments, input.filename, content, "application/json");
    },
  };
}

function artifact(segments: string[], filename: string, content: string, mimeType: string) {
  return {
    artifactId: `artifact-${filename}`,
    relPath: [...segments, filename].join("/"),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
    mimeType,
    createdAt: "2026-05-31T00:00:00.000Z",
  };
}
