import { expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => ({ DatabaseSync: class {}, StatementSync: class {} }));
import { PromptPackService } from "./prompt-pack-service.js";
it("freezes watch eligibility before canonical run creation and before dispatch", async () => {
  const order: string[] = [],
    bindings = [
      {
        activationId: "watch",
        revisionId: "revision",
        changeHash: "a".repeat(64),
        workspaceId: "prompt-lab",
        fingerprint: "fingerprint",
        capability: "routing",
        capturedAt: new Date().toISOString(),
      },
    ];
  let stored: any;
  const capture = vi.fn(async () => {
    order.push("capture");
    return bindings;
  });
  const service = new PromptPackService(
    {
      storage: {
        promptPacks: {
          getPack: async () => ({ packId: "pack" }),
          getTest: async () => ({
            packId: "pack",
            testId: "test",
            code: "TEST-1",
            title: "Source check",
            prompt: "Answer directly from supplied text",
            mode: "chat",
            toolTier: "no-tools",
          }),
        },
        promptPackRuns: {
          create: async (input: any) => {
            order.push("persist");
            stored = { ...input, startedAt: new Date().toISOString() };
            return stored;
          },
          patch: async (_id: string, patch: any) => (stored = { ...stored, ...patch }),
        },
        toolGrants: { list: async () => [] },
      },
      config: {
        rootDir: process.cwd(),
        assistant: {
          workspaceDir: "workspace",
          durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true },
        },
      },
      normalizeWorkspaceId: (id?: string) => id ?? "default",
      isFeatureEnabled: async () => true,
      requireFeatureEnabled: async () => {},
      publishRealtime: async () => {},
    } as never,
    {
      createChatSession: vi.fn(async () => ({ sessionId: "session" }) as never),
      agentSendChatMessage: vi.fn(async () => {
        order.push("dispatch");
        throw new Error("Controlled provider failure after admission");
      }),
      createChatCompletion: vi.fn(),
      getPromptRunnerModelDefaults: async () => ({ providerId: "provider", model: "model" }),
      getPromptJudgeModelDefaults: async () => ({}),
      backgroundTasks: new Set(),
      captureImprovementWatchBindings: capture,
    },
  );
  vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(async () => {});
  const result = await service.runPromptPackTest("pack", "test");
  expect(result.status).toBe("failed");
  expect(order).toEqual(["capture", "persist", "dispatch"]);
  expect(stored.improvementWatchBindings).toEqual(bindings);
  expect(capture).toHaveBeenCalledExactlyOnceWith("pack");
});
