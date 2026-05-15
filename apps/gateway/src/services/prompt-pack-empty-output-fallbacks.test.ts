import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  applyPromptPackPromptLabFallbacks,
  buildPromptPackMarkdownImportFallback,
  buildPromptPackOperatorSurfaceFallback,
  buildPromptPackRepoBindingFallback,
} from "./prompt-pack-empty-output-fallbacks.js";

describe("prompt-pack empty output fallbacks", () => {
  it("builds markdown import evidence from concrete file reads and dedupes exact files", () => {
    const fallback = buildPromptPackMarkdownImportFallback({
      prompt: "## User Task\nExplain how prompt-pack markdown is auto-loaded and imported.\nAnswer contract:",
      responseText: "I need to inspect more before answering.",
      toolRuns: [
        fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "ensurePromptPackLoaded importPromptPack"),
        fileReadRun("./apps/gateway/src/routes/prompt-packs.ts", "POST /api/v1/prompt-packs/import"),
        fileReadRun("F:/code/personal-ai/packages/storage/src/prompt-pack-repo.ts", "source_label policy_v2_source"),
        fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "fs.readFile"),
      ],
    });

    expect(fallback).toContain("Observed import/load path");
    expect(fallback).toContain("source_label");
    expect(fallback).toContain("policy_v2_source");
    expect(fallback?.match(/apps\/gateway\/src\/services\/prompt-pack-service\.ts/g)?.length).toBeGreaterThan(1);
    expect(new Set(fallback?.match(/`[^`]+`/g) ?? [])).toContain("`packages/storage/src/prompt-pack-repo.ts`");
  });

  it("skips markdown import fallbacks when the answer is already grounded or lacks service evidence", () => {
    const prompt = "Explain prompt-pack markdown import behavior.";

    expect(
      buildPromptPackMarkdownImportFallback({
        prompt,
        responseText: "GOATCITADEL_PROMPT_PACK_PATH and ensurePromptPackLoaded prove the import path.",
        toolRuns: [fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "ensurePromptPackLoaded")],
      }),
    ).toBeUndefined();
    expect(
      buildPromptPackMarkdownImportFallback({
        prompt,
        responseText: "unverified answer",
        toolRuns: [fileReadRun("apps/gateway/src/routes/prompt-packs.ts", "route only")],
      }),
    ).toBeUndefined();
  });

  it("builds repo-binding evidence and respects explicit section contract prompts", () => {
    const input = {
      prompt: "Prompt-pack repo/project binding and tool-path resolution: explain the chain.",
      responseText: "",
      toolRuns: [
        fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "PROMPT_PACK_REPO_PROJECT_BINDING"),
        fileReadRun("apps/gateway/src/services/tool-path-resolution.ts", "resolveProjectRootForToolContext"),
        fileReadRun("packages/storage/src/chat-session-binding-repo.ts", "workspaceId target"),
      ],
    };

    expect(buildPromptPackRepoBindingFallback(input)).toContain("Observed repo-binding chain");
    expect(
      buildPromptPackRepoBindingFallback({
        ...input,
        prompt: "Prompt-pack repo/project binding. Produce role-labeled sections.",
      }),
    ).toBeUndefined();
  });

  it("builds operator surface evidence when a partial inspection answer needs repair", () => {
    const fallback = buildPromptPackOperatorSurfaceFallback({
      prompt: "Report rendering, trend rendering, and benchmark status API evidence for the operator surface.",
      responseText: "taskSuccess is mentioned, but I'll continue inspection before drafting.",
      toolRuns: [
        fileReadRun("apps/gateway/src/routes/prompt-packs.ts", "GET /api/v1/prompt-packs/:packId/report"),
        fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "getPromptPackBenchmarkStatus"),
        fileReadRun(
          "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          "progress.totalItems progress.completedItems",
        ),
      ],
    });

    expect(fallback).toContain("## Report Surface");
    expect(fallback).toContain("## Trend Surface");
    expect(fallback).toContain("progress.totalItems");
  });

  it("normalizes serialized payload evidence and tool-name aliases through the public dispatcher", () => {
    const fallback = applyPromptPackPromptLabFallbacks({
      prompt: "Explain prompt-pack repo-bound tool path resolution.",
      responseText: "",
      toolRuns: [
        {
          toolRunId: "ignored-status",
          toolName: "file.read_range",
          status: "failed",
          args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
          result: { path: "apps/gateway/src/services/prompt-pack-service.ts", content: "ignored" },
        } as unknown as ChatToolRunRecord,
        {
          toolRunId: "ignored-tool",
          toolName: "not-a-reader",
          status: "executed",
          args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
          result: { path: "apps/gateway/src/services/prompt-pack-service.ts", content: "ignored" },
        } as unknown as ChatToolRunRecord,
        {
          toolRunId: "ignored-result",
          toolName: "file.read_range",
          status: "executed",
          args: {},
          result: { content: "ignored" },
        } as unknown as ChatToolRunRecord,
        fileReadRun(
          "apps/gateway/src/services/tool-path-resolution.ts",
          JSON.stringify({
            content: "resolveProjectRootForToolContext\\nrepo root",
          }),
        ),
        {
          toolRunId: "snippet-reader",
          toolName: "fs.read",
          status: "executed",
          args: { path: "./apps/gateway/src/services/prompt-pack-service.ts" },
          result: { snippet: "PROMPT_PACK_REPO_PROJECT_BINDING" },
        } as unknown as ChatToolRunRecord,
      ],
    });

    expect(fallback).toContain("tool-path-resolution.ts");
  });

  it("returns undefined for non-prompt, over-cited continuation, and unreadable evidence cases", () => {
    expect(
      applyPromptPackPromptLabFallbacks({
        prompt: "Ordinary chat request",
        responseText: "",
        toolRuns: [fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "ensurePromptPackLoaded")],
      }),
    ).toBeUndefined();
    expect(
      buildPromptPackOperatorSurfaceFallback({
        prompt: "Report rendering, trend rendering, and benchmark status API evidence.",
        responseText: "taskSuccess exists. I need to read more `a.ts` `b.ts` `c.ts` `d.ts` `e.ts` `f.ts` `g.ts`.",
        toolRuns: [
          fileReadRun("apps/gateway/src/routes/prompt-packs.ts", "report"),
          fileReadRun("apps/gateway/src/services/prompt-pack-service.ts", "report"),
        ],
      }),
    ).toBeUndefined();
    expect(
      buildPromptPackRepoBindingFallback({
        prompt: "Prompt-pack repo-bound tool path resolution.",
        responseText: "",
        toolRuns: [
          {
            toolRunId: "no-alias",
            toolName: undefined,
            status: "executed",
            args: { path: "apps/gateway/src/services/tool-path-resolution.ts" },
            result: { path: "apps/gateway/src/services/tool-path-resolution.ts", content: "ignored" },
          } as unknown as ChatToolRunRecord,
        ],
      }),
    ).toBeUndefined();
  });
});

function fileReadRun(path: string, content: unknown): ChatToolRunRecord {
  const result = { path, content: typeof content === "string" ? content : JSON.stringify(content) };
  return {
    toolRunId: `tool-${path}`,
    toolName: "file_read_range",
    status: "executed",
    args: { path },
    result,
  } as unknown as ChatToolRunRecord;
}
