import { createHash } from "node:crypto";
import type {
  ChatAttachmentRecord,
  ChatGeneratedArtifactRecord,
  ChatTurnCapabilityProfileRecord,
  MemoryItemRecord,
  NoteRecord,
} from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_ROUTED_CONTEXT_OUTPUT_RESERVE_TOKENS,
  buildChatRoutedContextSnapshot,
  resolveChatRoutedContextSources,
  type ChatRoutedContextSourceDeps,
  type ResolvedChatRoutedContextSources,
} from "./chat-routed-context-service.js";

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestHash(sources: Array<{ kind: string; ref: string }>): string {
  return hash(canonicalJsonString(sources.map(({ kind, ref }) => ({ kind, ref }))));
}

function attachment(id: string, text: string, patch: Partial<ChatAttachmentRecord> = {}): ChatAttachmentRecord {
  const bytes = Buffer.from(text, "utf8");
  return {
    attachmentId: id,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    fileName: "private-path-must-not-render.txt",
    mimeType: "text/plain",
    mediaType: "text",
    sizeBytes: bytes.length,
    sha256: hash(bytes),
    storageRelPath: "private/path.txt",
    extractStatus: "ready",
    analysisStatus: "ready",
    createdAt: "2026-07-13T00:00:00.000Z",
    ...patch,
  };
}

function memory(id: string, content: string, patch: Partial<MemoryItemRecord> = {}): MemoryItemRecord {
  return {
    itemId: id,
    namespace: "operator",
    title: "private title must not render",
    content,
    metadata: {},
    pinned: false,
    status: "active",
    lifecycleState: "active",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...patch,
  };
}

function externalAttachmentRecord(attachmentId: string, artifactSha: string) {
  return {
    schemaVersion: "goatcitadel.external-source.v1" as const,
    attachmentId,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceId: "source-1",
    importId: "import-1",
    itemId: "item-1",
    normalizedArtifactSha256: artifactSha,
    mode: "read_only_external" as const,
    status: "attached" as const,
    revision: 1,
    attachedByActorId: "operator-1",
    attachedAt: "2026-07-14T08:06:00.000Z",
  };
}

function externalProvenance(attachmentId: string, artifactSha: string) {
  return {
    sourceId: "source-1",
    importId: "import-1",
    itemId: "item-1",
    attachmentId,
    attachmentRevision: 1,
    normalizedArtifactSha256: artifactSha,
  };
}

function profile(): ChatTurnCapabilityProfileRecord {
  return {
    profileId: "chat-capability-profile-turn-1",
    identity: {
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    },
    selection: {
      effectiveProviderId: "provider-1",
      effectiveModel: "model-1",
      tools: [],
      memory: {
        mode: "on",
        retrievalMode: "standard",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        contextManifestRef: `chat-memory-scope:${"d".repeat(64)}`,
        writeApprovalRequired: true,
      },
    },
    hashes: { profileHash: "a".repeat(64) },
  } as unknown as ChatTurnCapabilityProfileRecord;
}

function deps(
  input: {
    sessionKind?: "dm" | "group" | "thread";
    attachments?: Record<string, { record: ChatAttachmentRecord; text: string; delay?: number }>;
    memories?: Record<string, MemoryItemRecord>;
    notes?: Record<string, NoteRecord>;
    artifacts?: Record<string, ChatGeneratedArtifactRecord>;
  } = {},
): ChatRoutedContextSourceDeps {
  return {
    getSessionKind: vi.fn(async () => input.sessionKind ?? "dm"),
    getAttachment: vi.fn((id) => {
      const value = input.attachments?.[id];
      if (!value) throw new Error(`missing ${id}`);
      return value.record;
    }),
    readAttachmentContent: vi.fn(async (id) => {
      const value = input.attachments?.[id];
      if (!value) throw new Error(`missing ${id}`);
      if (value.delay) await new Promise((resolve) => setTimeout(resolve, value.delay));
      return { record: value.record, bytes: Buffer.from(value.text, "utf8") };
    }),
    getActiveMemoryItem: vi.fn((id) => input.memories?.[id]),
    getPersonalNote: vi.fn((id) => {
      const item = input.notes?.[id];
      if (!item) throw new Error(`missing ${id}`);
      return item;
    }),
    getGeneratedArtifact: vi.fn((id, scope) => {
      const item = input.artifacts?.[id];
      if (!item) throw new Error(`missing ${id}`);
      if (
        (item.workspaceId ?? "default") !== scope.workspaceId ||
        (scope.sessionId && item.sessionId !== scope.sessionId)
      ) {
        throw new Error(`missing ${id}`);
      }
      return item;
    }),
  };
}

describe("chat routed context service", () => {
  it("rejects private memory references in shared sessions before reading either source", async () => {
    const host = deps({
      sessionKind: "group",
      memories: { private: memory("private", "private bytes") },
    });

    await expect(
      resolveChatRoutedContextSources(host, {
        refs: [
          { kind: "memory_item", ref: "private" },
          { kind: "personal_note", ref: "private-note" },
        ],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/unavailable in shared sessions/u);

    expect(host.getActiveMemoryItem).not.toHaveBeenCalled();
    expect(host.getPersonalNote).not.toHaveBeenCalled();
    expect(host.getAttachment).not.toHaveBeenCalled();
  });

  it("allows same-session generated artifacts in shared sessions and rejects foreign-session artifacts", async () => {
    const sameSession: ChatGeneratedArtifactRecord = {
      artifactId: "artifact-same",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      title: "Same session",
      kind: "markdown",
      content: "same-session artifact bytes",
      sourceSurface: "chat",
      version: 1,
      contentHash: hash("same-session artifact bytes"),
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    const foreign = { ...sameSession, artifactId: "artifact-foreign", sessionId: "session-foreign" };
    const host = deps({
      sessionKind: "thread",
      artifacts: { "artifact-same": sameSession, "artifact-foreign": foreign },
    });

    const resolved = await resolveChatRoutedContextSources(host, {
      refs: [{ kind: "generated_artifact", ref: "artifact-same" }],
      sessionId: "session-1",
      workspaceId: "workspace-1",
      memoryMode: "on",
      allowGlobalMemory: false,
    });
    expect(resolved.accessMode).toBe("session_only");
    expect(resolved.sources[0]?.text).toBe("same-session artifact bytes");

    await expect(
      resolveChatRoutedContextSources(host, {
        refs: [{ kind: "generated_artifact", ref: "artifact-foreign" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/missing artifact-foreign/u);
    expect(host.getGeneratedArtifact).toHaveBeenLastCalledWith("artifact-foreign", {
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });
  });

  it("freezes personal notes and generated artifacts with revision and hash provenance", async () => {
    const note: NoteRecord = {
      noteId: "note-1",
      workspaceId: "workspace-1",
      title: "Plan",
      body: "note bytes",
      tags: [],
      sourceRefs: [],
      lifecycleStatus: "active",
      revision: 3,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:01:00.000Z",
    };
    const artifact: ChatGeneratedArtifactRecord = {
      artifactId: "artifact-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-old",
      title: "Draft",
      kind: "markdown",
      content: "artifact bytes",
      sourceSurface: "chat",
      version: 2,
      contentHash: hash("artifact bytes"),
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    const resolved = await resolveChatRoutedContextSources(
      deps({ notes: { "note-1": note }, artifacts: { "artifact-1": artifact } }),
      {
        refs: [
          { kind: "personal_note", ref: "note-1", label: "Plan" },
          { kind: "generated_artifact", ref: "artifact-1", label: "Draft" },
        ],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      },
    );
    expect(resolved.sources.map((source) => source.text)).toEqual(["note bytes", "artifact bytes"]);
    expect(resolved.sources[0]?.sourceVersion).toContain("revision:3");
    expect(resolved.sources[1]?.sourceVersion).toContain("version:2");
    expect(resolved.sources.every((source) => source.sourceWorkspaceId === "workspace-1")).toBe(true);
  });
  it("rejects unknown ref fields and duplicate normalized sources before any source read", async () => {
    const host = deps();
    await expect(
      resolveChatRoutedContextSources(host, {
        refs: [{ kind: "attachment", ref: "a", path: "C:/secret" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/unsupported shape/u);
    await expect(
      resolveChatRoutedContextSources(host, {
        refs: [
          { kind: "attachment", ref: "a" },
          { kind: "attachment", ref: "a", label: "second" },
        ],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/duplicate source/u);
    expect(host.getAttachment).not.toHaveBeenCalled();
  });

  it("resolves parallel sources in request order and attests ordinary duplicates without reinjecting them", async () => {
    const a = attachment("a", "alpha");
    const b = attachment("b", "ordinary");
    const legacy = memory("m", "remember this", { metadata: { workspaceId: "workspace-1" } });
    const host = deps({
      attachments: {
        a: { record: a, text: "alpha", delay: 20 },
        b: { record: b, text: "ordinary" },
      },
      memories: { m: legacy },
    });
    const resolved = await resolveChatRoutedContextSources(host, {
      refs: [
        { kind: "attachment", ref: "a" },
        { kind: "memory_item", ref: "m" },
        { kind: "attachment", ref: "b" },
      ],
      sessionId: "session-1",
      workspaceId: "workspace-1",
      memoryMode: "on",
      allowGlobalMemory: false,
      ordinaryAttachmentIds: ["b"],
    });

    expect(resolved.sources.map((item) => item.ref)).toEqual(["a", "m", "b"]);
    expect(resolved.sources.map((item) => item.label)).toEqual(["Attachment 1", "Memory item 2", "Attachment 3"]);
    expect(resolved.sources[1]).toMatchObject({ sourceScope: "workspace", sourceWorkspaceId: "workspace-1" });
    expect(resolved.sources[2]).toMatchObject({ alreadyAttached: true, sourceHash: b.sha256 });
    expect(host.readAttachmentContent).toHaveBeenCalledTimes(2);
    expect(host.readAttachmentContent).toHaveBeenCalledWith("a", { maxBytes: 256 * 1024 });
    expect(host.readAttachmentContent).toHaveBeenCalledWith("b", { maxBytes: 256 * 1024 });
    const snapshot = buildChatRoutedContextSnapshot({
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [{ role: "user", content: "question" }],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    expect(snapshot.entries[2]).toMatchObject({
      disposition: "already_attached",
      admittedText: "",
      admittedBytes: 0,
      admittedTokens: 0,
    });
    expect(snapshot.entries[2]!.originalTokens).toBeGreaterThan(0);
    expect(snapshot.contextText).not.toContain("ordinary");
  });

  it("fails closed on foreign attachment ownership or exact-byte hash drift", async () => {
    const foreign = attachment("a", "alpha", { workspaceId: "workspace-2" });
    await expect(
      resolveChatRoutedContextSources(deps({ attachments: { a: { record: foreign, text: "alpha" } } }), {
        refs: [{ kind: "attachment", ref: "a" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/outside the effective session\/workspace scope/u);

    const stale = attachment("a", "recorded");
    await expect(
      resolveChatRoutedContextSources(deps({ attachments: { a: { record: stale, text: "changed!" } } }), {
        refs: [{ kind: "attachment", ref: "a" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/changed after admission metadata/u);
  });

  it("rejects ready records that are not canonical text media and mismatched memory identities", async () => {
    const binary = attachment("a", "alpha", { mediaType: "binary", mimeType: "application/octet-stream" });
    await expect(
      resolveChatRoutedContextSources(deps({ attachments: { a: { record: binary, text: "alpha" } } }), {
        refs: [{ kind: "attachment", ref: "a" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/not ready for exact text use/u);

    await expect(
      resolveChatRoutedContextSources(deps({ memories: { wanted: memory("other", "wrong identity") } }), {
        refs: [{ kind: "memory_item", ref: "wanted" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: true,
      }),
    ).rejects.toThrow(/unavailable in the effective scope/u);
  });

  it("requires ready text lifecycle and rejects metadata drift between lookup and bounded read", async () => {
    const notReady = attachment("a", "alpha", { extractStatus: "unsupported", analysisStatus: "unsupported" });
    const notReadyHost = deps({ attachments: { a: { record: notReady, text: "alpha" } } });
    await expect(
      resolveChatRoutedContextSources(notReadyHost, {
        refs: [{ kind: "attachment", ref: "a" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/not ready for exact text use/u);
    expect(notReadyHost.readAttachmentContent).not.toHaveBeenCalled();

    const original = attachment("a", "alpha");
    const drifted = { ...original, storageRelPath: "different/path.txt" };
    const driftHost: ChatRoutedContextSourceDeps = {
      getAttachment: vi.fn(() => original),
      readAttachmentContent: vi.fn(async () => ({ record: drifted, bytes: Buffer.from("alpha") })),
      getActiveMemoryItem: vi.fn(),
    };
    await expect(
      resolveChatRoutedContextSources(driftHost, {
        refs: [{ kind: "attachment", ref: "a" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: false,
      }),
    ).rejects.toThrow(/metadata changed during resolution/u);
  });

  it("requires explicit global-memory policy, preserves legacy workspace provenance, and blocks memory-off", async () => {
    const global = memory("global", "global text");
    const host = deps({ memories: { global } });
    const base = {
      refs: [{ kind: "memory_item", ref: "global" }],
      sessionId: "session-1",
      workspaceId: "workspace-1",
      memoryMode: "on" as const,
    };
    await expect(resolveChatRoutedContextSources(host, { ...base, allowGlobalMemory: false })).rejects.toThrow(
      /not admitted by the effective policy/u,
    );
    const admitted = await resolveChatRoutedContextSources(host, { ...base, allowGlobalMemory: true });
    expect(admitted.sources[0]).toMatchObject({ sourceScope: "global" });
    expect(host.getActiveMemoryItem).toHaveBeenLastCalledWith("global", "workspace-1", { allowGlobal: true });

    await expect(
      resolveChatRoutedContextSources(host, { ...base, memoryMode: "off", allowGlobalMemory: true }),
    ).rejects.toThrow(/memory mode is off/u);

    const malformedHost = deps({ memories: { global: memory("global", "text", { metadata: { workspaceId: 42 } }) } });
    await expect(resolveChatRoutedContextSources(malformedHost, { ...base, allowGlobalMemory: true })).rejects.toThrow(
      /malformed workspace provenance/u,
    );
  });

  it("rejects memory text that cannot round-trip as exact UTF-8", async () => {
    const malformed = memory("bad", "lone surrogate \ud800");
    await expect(
      resolveChatRoutedContextSources(deps({ memories: { bad: malformed } }), {
        refs: [{ kind: "memory_item", ref: "bad" }],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: true,
      }),
    ).rejects.toThrow(/canonical UTF-8/u);
  });

  it("preserves a leading UTF-8 BOM in exact attachment and memory source bytes", async () => {
    const text = "\ufeffexact text";
    const record = attachment("bom", text);
    const resolved = await resolveChatRoutedContextSources(
      deps({
        attachments: { bom: { record, text } },
        memories: { memory: memory("memory", text) },
      }),
      {
        refs: [
          { kind: "attachment", ref: "bom" },
          { kind: "memory_item", ref: "memory" },
        ],
        sessionId: "session-1",
        workspaceId: "workspace-1",
        memoryMode: "on",
        allowGlobalMemory: true,
      },
    );

    expect(resolved.sources.map((source) => source.text)).toEqual([text, text]);
    expect(Buffer.from(resolved.sources[0]!.text, "utf8")).toEqual(Buffer.from(text, "utf8"));
    expect(Buffer.from(resolved.sources[1]!.text, "utf8")).toEqual(Buffer.from(text, "utf8"));
  });

  it("budgets the final rendered block deterministically and keeps display labels out of provider context", () => {
    const longText = "context-token ".repeat(2_000);
    const sourceHash = hash(longText);
    const resolved: ResolvedChatRoutedContextSources = {
      sourceRequestHash: requestHash([{ kind: "memory_item", ref: "m" }]),
      sources: [
        {
          index: 0,
          kind: "memory_item",
          ref: "m",
          label: "operator display label",
          sourceScope: "workspace",
          sourceWorkspaceId: "workspace-1",
          sourceVersion: `updated:2026-07-13T00:00:00.000Z:sha256:${sourceHash}`,
          sourceHash,
          originalBytes: Buffer.byteLength(longText),
          text: longText,
          alreadyAttached: false,
        },
      ],
    };
    const baseInput = {
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [{ role: "user" as const, content: "question" }],
      createdAt: "2026-07-13T00:00:00.000Z",
    };
    const roomy = buildChatRoutedContextSnapshot(baseInput);
    const narrowWindow = roomy.budget.promptReservedTokens + CHAT_ROUTED_CONTEXT_OUTPUT_RESERVE_TOKENS + 180;
    const narrow = buildChatRoutedContextSnapshot({ ...baseInput, routeContextWindowTokens: narrowWindow });
    expect(narrow.budget.effectiveBudgetTokens).toBe(180);
    expect(narrow.budget.usedTokens).toBeLessThanOrEqual(180);
    expect(narrow.entries[0]?.disposition).toBe("truncated");
    expect(narrow.contextText).not.toContain("operator display label");
    expect(narrow.contextText).not.toContain("private title");

    const relabeled = buildChatRoutedContextSnapshot({
      ...baseInput,
      resolved: { ...resolved, sources: [{ ...resolved.sources[0]!, label: "different display label" }] },
    });
    expect(relabeled.contentHash).toBe(roomy.contentHash);
    expect(relabeled.contextText).toBe(roomy.contextText);
    expect(relabeled.snapshotHash).not.toBe(roomy.snapshotHash);
  });

  it("includes a short source when its complete rendered block fits the route budget", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    const sourceHash = hash(text);
    const snapshot = buildChatRoutedContextSnapshot({
      resolved: {
        sourceRequestHash: requestHash([{ kind: "memory_item", ref: "short" }]),
        sources: [
          {
            index: 0,
            kind: "memory_item",
            ref: "short",
            label: "Memory item 1",
            sourceScope: "workspace",
            sourceWorkspaceId: "workspace-1",
            sourceVersion: `updated:2026-07-13T00:00:00.000Z:sha256:${sourceHash}`,
            sourceHash,
            originalBytes: Buffer.byteLength(text),
            text,
            alreadyAttached: false,
          },
        ],
      },
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [{ role: "user", content: "question" }],
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(snapshot.entries[0]).toMatchObject({ disposition: "included", admittedText: text });
    expect(snapshot.contextText).toContain(text);
  });

  it("omits all entries when immutable wrapper overhead alone exhausts the available budget", () => {
    const text = "one token";
    const sourceHash = hash(text);
    const resolved: ResolvedChatRoutedContextSources = {
      sourceRequestHash: requestHash([{ kind: "memory_item", ref: "m" }]),
      sources: [
        {
          index: 0,
          kind: "memory_item",
          ref: "m",
          label: "Memory item 1",
          sourceScope: "workspace",
          sourceWorkspaceId: "workspace-1",
          sourceVersion: `updated:2026-07-13T00:00:00.000Z:sha256:${sourceHash}`,
          sourceHash,
          originalBytes: Buffer.byteLength(text),
          text,
          alreadyAttached: false,
        },
      ],
    };
    const seed = buildChatRoutedContextSnapshot({
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [{ role: "user", content: "question" }],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const contextWindow = seed.budget.promptReservedTokens + CHAT_ROUTED_CONTEXT_OUTPUT_RESERVE_TOKENS + 1;
    const snapshot = buildChatRoutedContextSnapshot({
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: contextWindow,
      baseHistoryMessages: [{ role: "user", content: "question" }],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    expect(snapshot.budget.effectiveBudgetTokens).toBe(1);
    expect(snapshot.entries[0]?.disposition).toBe("omitted");
    expect(snapshot.contextText).toBe("");
    expect(snapshot.budget.usedTokens).toBe(0);
    expect(snapshot.budget.usedBytes).toBe(0);
  });

  it("truncates only at Unicode code-point boundaries", () => {
    const text = "🙂goat ".repeat(2_000);
    const sourceHash = hash(text);
    const resolved: ResolvedChatRoutedContextSources = {
      sourceRequestHash: requestHash([{ kind: "memory_item", ref: "emoji" }]),
      sources: [
        {
          index: 0,
          kind: "memory_item",
          ref: "emoji",
          label: "Memory item 1",
          sourceScope: "workspace",
          sourceWorkspaceId: "workspace-1",
          sourceVersion: `updated:2026-07-13T00:00:00.000Z:sha256:${sourceHash}`,
          sourceHash,
          originalBytes: Buffer.byteLength(text),
          text,
          alreadyAttached: false,
        },
      ],
    };
    const seed = buildChatRoutedContextSnapshot({
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [],
    });
    const snapshot = buildChatRoutedContextSnapshot({
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: seed.budget.promptReservedTokens + CHAT_ROUTED_CONTEXT_OUTPUT_RESERVE_TOKENS + 160,
      baseHistoryMessages: [],
    });
    expect(snapshot.entries[0]?.disposition).toBe("truncated");
    const admitted = snapshot.entries[0]!.admittedText;
    expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(admitted, "utf8"))).toBe(admitted);
    expect(admitted).not.toContain("�");
  });

  it("fails closed when the frozen effective model has no exact context-window metadata", () => {
    const empty: ResolvedChatRoutedContextSources = { sourceRequestHash: requestHash([]), sources: [] };
    expect(() =>
      buildChatRoutedContextSnapshot({
        resolved: empty,
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        capabilityProfile: profile(),
        routeContextWindowTokens: undefined as unknown as number,
        baseHistoryMessages: [],
      }),
    ).toThrow(/lacks trusted context-window metadata/u);
  });

  it("resolves live external attachments byte-exact with provenance and freezes them unmodified", async () => {
    const text = "external canary bytes: lobster-matrix-7f3a";
    const bytes = Buffer.from(text, "utf8");
    const artifactSha = hash(bytes);
    const record = externalAttachmentRecord("ext-1", artifactSha);
    const provenance = externalProvenance("ext-1", artifactSha);
    const readExternalAttachmentContent = vi.fn(async () => ({ attachment: record, bytes, provenance }));
    const host = { ...deps(), readExternalAttachmentContent };

    const resolved = await resolveChatRoutedContextSources(host, {
      refs: [{ kind: "external_attachment", ref: "ext-1", label: "Codex session" }],
      sessionId: "session-1",
      workspaceId: "workspace-1",
      memoryMode: "off",
      allowGlobalMemory: false,
    });
    expect(readExternalAttachmentContent).toHaveBeenCalledWith("ext-1", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    expect(resolved.sources[0]).toMatchObject({
      kind: "external_attachment",
      ref: "ext-1",
      sourceScope: "workspace",
      sourceWorkspaceId: "workspace-1",
      sourceHash: artifactSha,
      externalProvenance: provenance,
      originalBytes: bytes.length,
      text,
      alreadyAttached: false,
    });

    const snapshot = buildChatRoutedContextSnapshot({
      resolved,
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [],
    });
    expect(snapshot.entries[0]).toMatchObject({
      kind: "external_attachment",
      disposition: "included",
      admittedText: text,
      admittedBytes: bytes.length,
      externalProvenance: provenance,
      truncated: false,
    });
    expect(snapshot.contextText).toContain(text);
  });

  it("fails closed when the external runtime is absent, bytes drift, or the attachment is not live", async () => {
    const text = "exact external bytes";
    const bytes = Buffer.from(text, "utf8");
    const artifactSha = hash(bytes);
    const baseInput = {
      refs: [{ kind: "external_attachment" as const, ref: "ext-1" }],
      sessionId: "session-1",
      workspaceId: "workspace-1",
      memoryMode: "auto" as const,
      allowGlobalMemory: false,
    };
    await expect(resolveChatRoutedContextSources(deps(), baseInput)).rejects.toThrow(/unavailable in this runtime/u);

    const tampered = {
      ...deps(),
      readExternalAttachmentContent: vi.fn(async () => ({
        attachment: externalAttachmentRecord("ext-1", artifactSha),
        bytes: Buffer.from("different bytes than the immutable artifact", "utf8"),
        provenance: externalProvenance("ext-1", artifactSha),
      })),
    };
    await expect(resolveChatRoutedContextSources(tampered, baseInput)).rejects.toThrow(
      /do not match their immutable artifact hash/u,
    );

    const detached = {
      ...deps(),
      readExternalAttachmentContent: vi.fn(async () => ({
        attachment: { ...externalAttachmentRecord("ext-1", artifactSha), status: "detached" as const, revision: 2 },
        bytes,
        provenance: externalProvenance("ext-1", artifactSha),
      })),
    };
    await expect(resolveChatRoutedContextSources(detached, baseInput)).rejects.toThrow(/is not live/u);

    const foreignSession = {
      ...deps(),
      readExternalAttachmentContent: vi.fn(async () => ({
        attachment: { ...externalAttachmentRecord("ext-1", artifactSha), sessionId: "session-2" },
        bytes,
        provenance: externalProvenance("ext-1", artifactSha),
      })),
    };
    await expect(resolveChatRoutedContextSources(foreignSession, baseInput)).rejects.toThrow(/is not live/u);
  });

  it("omits an external source whole instead of truncating when it cannot fit the budget", () => {
    const bigText = "external transcript line that repeats. ".repeat(400);
    const bigHash = hash(bigText);
    const smallText = "small external body";
    const smallHash = hash(smallText);
    const sources = [
      {
        index: 0,
        kind: "external_attachment" as const,
        ref: "ext-big",
        label: "External source 1",
        sourceScope: "workspace" as const,
        sourceWorkspaceId: "workspace-1",
        sourceVersion: `external:rev:1:sha256:${bigHash}`,
        sourceHash: bigHash,
        externalProvenance: externalProvenance("ext-big", bigHash),
        originalBytes: Buffer.byteLength(bigText, "utf8"),
        text: bigText,
        alreadyAttached: false,
      },
      {
        index: 1,
        kind: "external_attachment" as const,
        ref: "ext-small",
        label: "External source 2",
        sourceScope: "workspace" as const,
        sourceWorkspaceId: "workspace-1",
        sourceVersion: `external:rev:1:sha256:${smallHash}`,
        sourceHash: smallHash,
        externalProvenance: externalProvenance("ext-small", smallHash),
        originalBytes: Buffer.byteLength(smallText, "utf8"),
        text: smallText,
        alreadyAttached: false,
      },
    ];
    const snapshot = buildChatRoutedContextSnapshot({
      resolved: { sourceRequestHash: requestHash(sources), sources },
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [],
    });
    expect(snapshot.entries[0]).toMatchObject({ disposition: "omitted", admittedText: "", admittedBytes: 0 });
    expect(snapshot.entries[1]).toMatchObject({ disposition: "included", admittedText: smallText });
    expect(snapshot.contextText).not.toContain("external transcript line");
    expect(snapshot.entries.every((entry) => entry.disposition !== "truncated")).toBe(true);
  });

  it("binds the ordered source request and final memory profile scope before sealing", () => {
    const text = "memory";
    const sourceHash = hash(text);
    const source = {
      index: 0,
      kind: "memory_item" as const,
      ref: "m",
      label: "Memory item 1",
      sourceScope: "workspace" as const,
      sourceWorkspaceId: "workspace-1",
      sourceVersion: `updated:2026-07-13T00:00:00.000Z:sha256:${sourceHash}`,
      sourceHash,
      originalBytes: Buffer.byteLength(text),
      text,
      alreadyAttached: false,
    };
    const input = {
      resolved: { sourceRequestHash: requestHash([source]), sources: [source] },
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfile: profile(),
      routeContextWindowTokens: 32_768,
      baseHistoryMessages: [] as [],
    };
    expect(() =>
      buildChatRoutedContextSnapshot({
        ...input,
        resolved: { ...input.resolved, sourceRequestHash: "f".repeat(64) },
      }),
    ).toThrow(/source-request binding is invalid/u);

    const memoryOff = profile();
    memoryOff.selection.memory.mode = "off";
    expect(() => buildChatRoutedContextSnapshot({ ...input, capabilityProfile: memoryOff })).toThrow(
      /does not match the final capability profile scope/u,
    );
  });
});
