import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ChatCompletionRequest, ChatTurnTraceRecord, TranscriptEvent } from "@goatcitadel/contracts";
import type { ConsolidationCursor, ConsolidationProgress } from "@goatcitadel/storage";
import { MemoryConsolidationService, type MemoryConsolidationDeps } from "./memory-consolidation-service.js";

function fixture(count: number, chars = 140, oversizedIndex?: number) {
  const traces = Array.from(
    { length: count },
    (_, index) =>
      ({
        turnId: "turn-" + String(index).padStart(3, "0"),
        sessionId: "source-session",
        userMessageId: "user-" + index,
        assistantMessageId: "assistant-" + index,
        status: "completed",
        startedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
        finishedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
        memoryMode: "on",
        completion: { status: "complete", repaired: false, providerCallCount: 1 },
      }) as ChatTurnTraceRecord,
  );
  const texts = traces.map(
    (trace, index) =>
      `SOURCE_MARKER_${String(index).padStart(3, "0")}_END ${"ordinary evidence ".repeat(Math.ceil((index === oversizedIndex ? 70_000 : chars) / 18))}`,
  );
  const events: TranscriptEvent[] = traces.flatMap((trace, index) => [
    {
      eventId: trace.userMessageId,
      actionId: trace.turnId,
      idempotencyKey: trace.userMessageId,
      sessionId: trace.sessionId,
      sessionKey: trace.sessionId,
      timestamp: trace.startedAt,
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: { content: texts[index] },
    },
    {
      eventId: trace.assistantMessageId!,
      actionId: trace.turnId,
      idempotencyKey: trace.assistantMessageId!,
      sessionId: trace.sessionId,
      sessionKey: trace.sessionId,
      timestamp: trace.finishedAt!,
      type: "message.assistant",
      actorType: "agent",
      actorId: "assistant",
      payload: { content: "The useful result and its evidence were checked for this operator turn." },
    },
  ]);
  let progress: ConsolidationProgress = { revision: 0, cursor: { finishedAt: "2026-06-30T00:00:00.000Z", turnId: "" } };
  const prompts: string[] = [],
    unsupportedReads: string[][] = [],
    exclusions: Array<Record<string, unknown>> = [];
  const source = (turnIds: string[]) => {
    const selected = events.filter((event) => turnIds.includes(event.actionId));
    const material = JSON.stringify(selected),
      sourceHash = createHash("sha256").update(material).digest("hex");
    if (selected.some((event) => String(event.payload.content).length > 65536) || material.length > 256_000)
      return undefined;
    return { sourceHash, events: selected };
  };
  const deps = {
    isFeatureEnabled: async (flag: string) => flag !== "autonomyV1Disabled",
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    listWorkspaceIds: async () => ["workspace-A"],
    resolveEligibleSourceSession: async () => ({ workspaceId: "workspace-A" }),
    readProgress: async () => progress,
    claimProgress: async (_workspace: string, revision: number, leaseOwner: string) => {
      if (revision !== progress.revision) return undefined;
      progress = { ...progress, revision: revision + 1, leaseOwner };
      return progress;
    },
    commitProgress: async (
      _workspace: string,
      revision: number,
      leaseOwner: string,
      cursor: ConsolidationCursor | undefined,
      _now: string,
      omitted: Array<Record<string, unknown>> = [],
    ) => {
      expect(progress.revision).toBe(revision);
      expect(progress.leaseOwner).toBe(leaseOwner);
      progress = { revision: revision + 1, cursor };
      exclusions.push(...omitted);
    },
    listCompletedTracePage: async ({ after, limit }: { after: ConsolidationCursor; limit: number }) =>
      traces
        .filter(
          (trace) =>
            trace.finishedAt! > after.finishedAt ||
            (trace.finishedAt === after.finishedAt && trace.turnId > after.turnId),
        )
        .slice(0, limit),
    readTranscriptOrEmpty: async () => events,
    readCanonicalSource: async ({ turnIds }: { turnIds: string[] }) => {
      const result = source(turnIds);
      if (!result) unsupportedReads.push(turnIds);
      return result;
    },
    inspectCanonicalSource: async ({ turnIds }: { turnIds: string[] }) => {
      const result = source(turnIds);
      return result
        ? { status: "ready", ...result }
        : {
            status: "excluded",
            reason: "source_size_limit",
            sourceHash: createHash("sha256")
              .update(JSON.stringify(turnIds.map((id) => texts[traces.findIndex((trace) => trace.turnId === id)])))
              .digest("hex"),
          };
    },
    createChatCompletion: async (request: ChatCompletionRequest) => {
      prompts.push(String(request.messages.find((message) => message.role === "user")?.content ?? ""));
      return { choices: [{ message: { content: "[]" } }] };
    },
    resolveModelDefaults: async () => ({ providerId: "fixture", model: "fixture" }),
    proposeTraceMemoryCandidate: async () => {
      throw new Error("This source-window fixture extracts no candidate");
    },
    listExistingInsightsForDedup: async () => [],
    publishRealtime: async () => undefined,
  } as unknown as MemoryConsolidationDeps;
  const marker = (index: number) => `SOURCE_MARKER_${String(index).padStart(3, "0")}_END`;
  return { deps, traces, prompts, unsupportedReads, exclusions, marker, progress: () => progress };
}

it("only checkpoints chronological complete turns actually included in bounded model windows", async () => {
  const f = fixture(30);
  for (let restart = 0; restart < 12 && f.progress().cursor?.turnId !== f.traces.at(-1)!.turnId; restart++) {
    await new MemoryConsolidationService(f.deps).runConsolidation();
  }
  expect(f.progress().cursor?.turnId).toBe(f.traces.at(-1)!.turnId);
  for (let index = 0; index < 30; index++)
    expect(f.prompts.filter((prompt) => prompt.includes(f.marker(index)))).toHaveLength(1);
  expect(f.prompts.every((prompt) => prompt.length <= 6000)).toBe(true);
});
it("reviews a short qualifying source instead of silently checkpointing it without model inspection",async()=>{
  const f=fixture(1,12);await new MemoryConsolidationService(f.deps).runConsolidation();
  expect(f.prompts).toHaveLength(1);expect(f.prompts[0]).toContain(f.marker(0));
});

it("drains a session exceeding the canonical aggregate byte limit through bounded windows and restarts", async () => {
  const f = fixture(200, 1500);
  for (let restart = 0; restart < 40 && f.progress().cursor?.turnId !== f.traces.at(-1)!.turnId; restart++) {
    await new MemoryConsolidationService(f.deps).runConsolidation();
  }
  expect(f.progress().cursor?.turnId).toBe(f.traces.at(-1)!.turnId);
  expect(f.unsupportedReads).toEqual([]);
  for (let index = 0; index < 200; index++)
    expect(f.prompts.filter((prompt) => prompt.includes(f.marker(index)))).toHaveLength(1);
});

it("records a permanent oversized-turn exclusion while processing both valid neighbors", async () => {
  const f = fixture(3, 260, 1);
  await new MemoryConsolidationService(f.deps).runConsolidation();
  expect(f.prompts.some((prompt) => prompt.includes(f.marker(0)))).toBe(true);
  expect(f.prompts.some((prompt) => prompt.includes(f.marker(2)))).toBe(true);
  expect(f.prompts.every((prompt) => !prompt.includes(f.marker(1)))).toBe(true);
  expect(f.exclusions).toContainEqual(
    expect.objectContaining({
      turnId: f.traces[1]!.turnId,
      reason: "source_size_limit",
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  );
  expect(f.progress().cursor?.turnId).toBe(f.traces[2]!.turnId);
});
