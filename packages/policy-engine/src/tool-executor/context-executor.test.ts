import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRoutedContextSnapshotRecord, ToolInvokeRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { executeRoutedContextTool, listAvailableRoutedContextTools } from "./context-executor.js";

const SNAPSHOT_HASH = "a".repeat(64);
const SOURCE_HASH = "b".repeat(64);

function snapshot(overrides: Partial<ChatRoutedContextSnapshotRecord> = {}): ChatRoutedContextSnapshotRecord {
  return {
    snapshotId: "snapshot-1",
    schemaVersion: "chat.routed-context-snapshot.v1",
    turnId: "turn-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    capabilityProfileId: "profile-1",
    capabilityProfileHash: "c".repeat(64),
    sourceRequestHash: "d".repeat(64),
    contentHash: "e".repeat(64),
    snapshotHash: SNAPSHOT_HASH,
    budget: {
      effectiveProviderId: "provider-1",
      effectiveModel: "model-1",
      contextWindowTokens: 32_000,
      promptReservedTokens: 100,
      outputReservedTokens: 1_000,
      hardCapTokens: 20_000,
      effectiveBudgetTokens: 18_900,
      usedTokens: 20,
      usedBytes: 80,
      estimatorVersion: "gc-approx-tokens.v1",
      budgetPolicyVersion: "chat.routed-context-budget.v1",
    },
    entries: [
      {
        index: 0,
        kind: "attachment",
        ref: "attachment-1",
        label: "Architecture notes",
        disposition: "included",
        sourceScope: "workspace",
        sourceWorkspaceId: "workspace-1",
        sourceVersion: "1",
        sourceHash: SOURCE_HASH,
        originalBytes: 80,
        originalTokens: 20,
        admittedBytes: 80,
        admittedTokens: 20,
        truncated: false,
        admittedText: "Alpha heading\nGateway owns canonical state\nalpha closing",
      },
      {
        index: 1,
        kind: "memory_item",
        ref: "memory-omitted",
        label: "Omitted memory",
        disposition: "omitted",
        sourceScope: "workspace",
        sourceWorkspaceId: "workspace-1",
        sourceVersion: "2",
        sourceHash: "f".repeat(64),
        originalBytes: 20,
        originalTokens: 5,
        admittedBytes: 0,
        admittedTokens: 0,
        truncated: false,
        admittedText: "",
      },
    ],
    contextText: "frozen",
    createdAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function storage(record = snapshot()): AsyncStorage {
  return {
    routedContextSnapshots: { get: vi.fn(async () => record) },
    chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-1" })) },
  } as unknown as AsyncStorage;
}

function request(toolName: ToolInvokeRequest["toolName"], args: Record<string, unknown> = {}): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "assistant",
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceId: "workspace-1",
    routedContextSnapshotId: "snapshot-1",
    routedContextSnapshotHash: SNAPSHOT_HASH,
  };
}

describe("routed context tool executor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lists metadata and dispositions without returning admitted text", async () => {
    const result = await executeRoutedContextTool(request("context.list"), storage());
    expect(result.entries).toEqual([
      expect.objectContaining({ entryIndex: 0, disposition: "included", eligible: true, lineCount: 3 }),
      expect.objectContaining({ entryIndex: 1, disposition: "omitted", eligible: false, lineCount: 0 }),
    ]);
    expect(JSON.stringify(result)).not.toContain("Gateway owns canonical state");
  });

  it("performs bounded literal grep with exact immutable receipts", async () => {
    const result = await executeRoutedContextTool(
      request("context.grep", { pattern: "alpha", caseSensitive: false, limit: 1 }),
      storage(),
    );
    expect(result).toMatchObject({ retrievalMode: "literal", truncated: true });
    expect(result.matches).toEqual([
      {
        receipt: expect.objectContaining({
          snapshotHash: SNAPSHOT_HASH,
          sourceHash: SOURCE_HASH,
          entryIndex: 0,
          sourceRef: "attachment-1",
          startLine: 1,
          endLine: 1,
        }),
        text: "Alpha heading",
      },
    ]);
  });

  it("queries only frozen snapshot bytes with deterministic lexical fallback", async () => {
    const owner = storage();
    const first = await executeRoutedContextTool(request("context.query", { query: "canonical gateway" }), owner);
    const second = await executeRoutedContextTool(request("context.query", { query: "canonical gateway" }), owner);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ retrievalMode: "lexical_fallback", truncated: false });
    expect(first.matches).toEqual([
      expect.objectContaining({ text: "Gateway owns canonical state", score: expect.any(Number) }),
    ]);
  });

  it("uses ephemeral hybrid scoring when a real embedding provider is available", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "test-embedding");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "4");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://embeddings.example/v1/embeddings");
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeRoutedContextTool(request("context.query", { query: "ownership boundary" }), storage());

    expect(result).toMatchObject({ retrievalMode: "hybrid", truncated: false });
    expect(result.matches).toEqual([
      expect.objectContaining({
        receipt: expect.objectContaining({ entryIndex: 0, startLine: 1, endLine: 3 }),
        score: expect.any(Number),
      }),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reads 1-based ranges and never returns omitted entry content", async () => {
    expect(
      await executeRoutedContextTool(
        request("context.read_range", { entryIndex: 0, startLine: 2, endLine: 3 }),
        storage(),
      ),
    ).toMatchObject({
      text: "Gateway owns canonical state\nalpha closing",
      truncated: false,
      receipt: { entryIndex: 0, startLine: 2, endLine: 3 },
    });
    await expect(
      executeRoutedContextTool(request("context.read_range", { entryIndex: 1, startLine: 1, endLine: 1 }), storage()),
    ).rejects.toThrow(/not eligible/u);
  });

  it.each(["sessionId", "turnId", "workspaceId", "snapshotId", "snapshotHash"])(
    "rejects model-supplied %s authority overrides",
    async (key) => {
      await expect(executeRoutedContextTool(request("context.list", { [key]: "forged" }), storage())).rejects.toThrow(
        /authority override/u,
      );
    },
  );

  it("rejects forged hashes and cross-workspace snapshots", async () => {
    await expect(
      executeRoutedContextTool({ ...request("context.list"), routedContextSnapshotHash: "9".repeat(64) }, storage()),
    ).rejects.toThrow(/does not match/u);
    await expect(
      executeRoutedContextTool(request("context.list"), storage(snapshot({ workspaceId: "workspace-2" }))),
    ).rejects.toThrow(/does not match/u);
  });

  it("reports no callable tools without an exact server-authored binding", async () => {
    await expect(
      listAvailableRoutedContextTools({ ...request("session.status"), turnId: undefined }, storage()),
    ).resolves.toEqual([]);
    await expect(listAvailableRoutedContextTools(request("session.status"), storage())).resolves.toEqual([
      "context.list",
      "context.grep",
      "context.query",
      "context.read_range",
    ]);
  });
});
