import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackTestRecord } from "@goatcitadel/contracts";
import { PromptPackService, derivePromptPackResponseArtifacts } from "./prompt-pack-service.js";
import { createRun, createTrace } from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack response artifacts", () => {
  it("stores the raw model output without any score-facing fabrication artifacts", async () => {
    const patchRun = vi.fn((_runId: string, patch: Record<string, unknown>) => ({
      ...createRun("run-raw-derived", String(patch.status ?? "completed"), "2026-03-14T00:00:00.000Z"),
      testId: "test-raw-derived",
      responseText: patch.responseText,
      derivedResponseText: patch.derivedResponseText,
      derivedResponseSignals: patch.derivedResponseSignals,
      trace: patch.trace,
      citations: patch.citations,
      integrity: patch.integrity,
      error: patch.error,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-raw-derived",
                packId: "pack-1",
                code: "TEST-RAW-DERIVED",
                title: "Raw derived split",
                prompt: "Use web sources to answer: household emergency water storage.",
                orderIndex: 0,
                mode: "chat",
                toolTier: "explicit-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
        config: {
          rootDir: "F:/code/personal-ai",
          assistant: {
            workspaceDir: ".",
            durable: {
              enabled: true,
              executionEnabled: true,
              chatAutoPromoteEnabled: true,
            },
          },
        } as never,
        normalizeWorkspaceId: () => "default",
        isFeatureEnabled: () => true,
        requireFeatureEnabled: () => undefined,
        publishRealtime: () => undefined,
      } as never,
      {
        createChatSession: vi.fn(() => ({ sessionId: "sess-raw-derived" })),
        agentSendChatMessage: vi.fn(async () => ({
          sessionId: "sess-raw-derived",
          turnId: "turn-raw-derived",
          userMessage: {
            messageId: "user-raw-derived",
            sessionId: "sess-raw-derived",
            role: "user",
            actorType: "user",
            actorId: "user",
            content: "household emergency water storage",
            timestamp: "2026-03-14T00:00:00.000Z",
          },
          assistantMessage: {
            messageId: "assistant-raw-derived",
            sessionId: "sess-raw-derived",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "Raw model answer that should remain raw.",
            timestamp: "2026-03-14T00:00:01.000Z",
          },
          transport: "llm",
          trace: createTrace("sess-raw-derived"),
          citations: [],
          routing: {},
        })),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const run = await service.runPromptPackTest("pack-1", "test-raw-derived");

    expect(run.responseText).toBe("Raw model answer that should remain raw.");
    expect(run.derivedResponseText).toBeUndefined();
    expect(run.derivedResponseSignals).toBeUndefined();
    // Integrity must checksum the raw model output, not any rewritten artifact.
    expect(run.integrity?.responseChecksumSha256).toBe(
      createHash("sha256").update("Raw model answer that should remain raw.").digest("hex"),
    );
    // The run patch must never write score-facing fabrication fields.
    const patchPayload = patchRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("finalResponseText" in patchPayload).toBe(false);
    expect("finalResponseSignals" in patchPayload).toBe(false);
  });

  it("derives prompt-pack helper text without overwriting non-empty raw output", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how prompt-pack markdown is auto-loaded and imported.",
    ].join("\n");

    const derived = derivePromptPackResponseArtifacts({
      prompt,
      rawResponseText: "",
      trace: {
        ...createTrace("sess-derived-artifacts"),
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-derived-artifacts",
            sessionId: "sess-derived-artifacts",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                'ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, "utf8");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });',
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
          {
            toolRunId: "tool-route-read",
            turnId: "turn-derived-artifacts",
            sessionId: "sess-derived-artifacts",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
            },
            result: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
              content: "fastify.post('/api/v1/prompt-packs/import', async () => fastify.gateway.importPromptPack());",
            },
            startedAt: "2026-03-14T00:00:00.500Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
        ],
      },
    });

    expect(derived.derivedResponseSignals).toEqual(["prompt_lab_contract_fallback"]);
    expect(derived.derivedResponseText).toContain("Observed import/load path:");
    expect(derived.derivedResponseText).toContain("POST /api/v1/prompt-packs/import");

    expect(
      derivePromptPackResponseArtifacts({
        prompt,
        rawResponseText: "Raw answer stays canonical.",
        trace: createTrace("sess-derived-nonempty"),
      }),
    ).toEqual({});
  });

  it("derives a deterministic missing-output fallback from captured tool evidence", () => {
    const derived = derivePromptPackResponseArtifacts({
      prompt: "Use file/code tools to inspect the repo and cite exact files.",
      rawResponseText: "",
      trace: {
        turnId: "turn-missing-output",
        sessionId: "sess-missing-output",
        userMessageId: "user-missing-output",
        branchKind: "append",
        status: "failed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-search",
            turnId: "turn-missing-output",
            sessionId: "sess-missing-output",
            toolName: "code.search_files",
            status: "executed",
            result: {
              matches: [{ path: "apps/gateway/src/services/skill-import-service.ts" }],
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
        ],
        citations: [],
        routing: {},
        failure: {
          failureClass: "unknown",
          message: "The provider stopped before the answer finished.",
        },
      },
    });

    expect(derived.derivedResponseSignals).toEqual(["trace_missing_output_fallback"]);
    expect(derived.derivedResponseText).toContain("fell back to the captured tool evidence");
    expect(derived.derivedResponseText).toContain("code.search_files");
    expect(derived.derivedResponseText).toContain("apps/gateway/src/services/skill-import-service.ts");
  });

  it("prompt-pack service no longer exports a score-facing normalizer", async () => {
    const mod = await import("./prompt-pack-service.js");
    expect("normalizePromptPackAgenticResponse" in mod).toBe(false);
    expect("finalizePromptPackResponseText" in mod).toBe(false);
  });
});
