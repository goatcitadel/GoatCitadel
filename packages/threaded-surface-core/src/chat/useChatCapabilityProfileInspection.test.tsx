import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type {
  ChatRoutedContextInspection,
  ChatThreadTurnRecord,
  ChatTurnCapabilityProfileRecord,
} from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useChatCapabilityProfileInspection,
  verifyChatCapabilityProfileAgainstTurn,
  type ChatCapabilityProfileInspection,
} from "./useChatCapabilityProfileInspection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { fetchProfile } = vi.hoisted(() => ({ fetchProfile: vi.fn() }));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatTurnCapabilityProfile: (...args: unknown[]) => fetchProfile(...args),
}));

function makeTurn(overrides: Partial<ChatThreadTurnRecord["trace"]> = {}): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    userMessage: { messageId: "user-1", content: "hello" },
    trace: {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "root",
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      effectiveToolAutonomy: "manual",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "profile-hash-1",
      startedAt: "2026-07-13T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5" },
      ...overrides,
    },
  } as ChatThreadTurnRecord;
}

function makeProfile(overrides: Partial<ChatTurnCapabilityProfileRecord> = {}): ChatTurnCapabilityProfileRecord {
  return {
    profileId: "profile-1",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      citadelId: "citadel-1",
    },
    source: { channel: "chat", account: "operator" },
    catalog: {
      snapshotId: "snapshot-1",
      inspectableHash: "inspectable",
      callableHash: "callable",
      inspectableCount: 1,
      callableCount: 1,
    },
    selection: {
      contentHash: "content",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "auto",
      memory: {
        mode: "auto",
        retrievalMode: "standard",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        contextManifestRef: "manifest-1",
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      toolAutonomy: "manual",
      tools: [],
      modelNameAllowMap: [],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: { profileId: "safe", approvalMode: "approve_all", profileHash: "permission-hash" },
      policyDecisions: [],
      authReadiness: [],
      approval: { mode: "approve_all", selectedToolCount: 0, toolsRequiringApproval: [], approvalGranted: false },
    },
    hashes: {
      identityHash: "identity",
      sourceHash: "source",
      catalogHash: "catalog",
      selectionHash: "selection",
      governanceHash: "governance",
      profileHash: "profile-hash-1",
    },
    preflightFingerprint: "fingerprint-1",
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeRoutedContext(overrides: Partial<ChatRoutedContextInspection> = {}): ChatRoutedContextInspection {
  return {
    snapshotId: "context-snapshot-1",
    snapshotHash: "a".repeat(64),
    sourceRequestHash: "b".repeat(64),
    contentHash: "c".repeat(64),
    includedCount: 1,
    truncatedCount: 0,
    omittedCount: 0,
    alreadyAttachedCount: 0,
    budget: {
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5",
      contextWindowTokens: 16_384,
      promptReservedTokens: 1_024,
      outputReservedTokens: 2_048,
      hardCapTokens: 4_096,
      effectiveBudgetTokens: 4_096,
      usedTokens: 32,
      usedBytes: 100,
      estimatorVersion: "gc-approx-tokens.v1",
      budgetPolicyVersion: "chat.routed-context-budget.v1",
    },
    entries: [
      {
        index: 0,
        kind: "memory_item",
        ref: "memory-1",
        label: "Memory 1",
        disposition: "included",
        sourceScope: "workspace",
        sourceWorkspaceId: "workspace-1",
        sourceVersion: "2026-07-13T00:00:00.000Z",
        sourceHash: "d".repeat(64),
        originalBytes: 100,
        admittedBytes: 100,
        admittedTokens: 32,
      },
    ],
    ...overrides,
  };
}

async function renderInspection(turn: ChatThreadTurnRecord): Promise<{
  latest: () => ChatCapabilityProfileInspection | undefined;
  renderer: ReactTestRenderer;
  update: (turn: ChatThreadTurnRecord) => Promise<void>;
}> {
  let value: ChatCapabilityProfileInspection | undefined;
  function Harness({ selectedTurn }: { selectedTurn: ChatThreadTurnRecord }) {
    value = useChatCapabilityProfileInspection({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turn: selectedTurn,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness selectedTurn={turn} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    latest: () => value,
    renderer,
    update: async (selectedTurn) => {
      await act(async () => {
        renderer.update(<Harness selectedTurn={selectedTurn} />);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

describe("useChatCapabilityProfileInspection", () => {
  beforeEach(() => {
    fetchProfile.mockReset();
  });

  it("fetches in the selected workspace scope and exposes only an exact trace/profile match", async () => {
    fetchProfile.mockResolvedValue({ state: "available", profile: makeProfile() });
    const result = await renderInspection(makeTurn());

    expect(fetchProfile).toHaveBeenCalledWith("session-1", "turn-1", "workspace-1");
    expect(result.latest()).toEqual(expect.objectContaining({ status: "verified", mismatchFields: [] }));
    expect(result.latest()?.profile?.hashes.profileHash).toBe("profile-hash-1");
    act(() => result.renderer.unmount());
  });

  it("hides profile detail when the immutable hash or execution selection differs", async () => {
    fetchProfile.mockResolvedValue({
      state: "available",
      profile: makeProfile({
        hashes: { ...makeProfile().hashes, profileHash: "wrong-hash" },
        selection: { ...makeProfile().selection, effectiveModel: "different-model" },
      }),
    });
    const result = await renderInspection(makeTurn());

    expect(result.latest()?.status).toBe("invalid");
    expect(result.latest()?.profile).toBeNull();
    expect(result.latest()?.mismatchFields).toEqual(expect.arrayContaining(["profile hash", "effective model"]));
    act(() => result.renderer.unmount());
  });

  it("exposes only routed-context evidence that exactly matches the turn trace", async () => {
    const routedContext = makeRoutedContext();
    fetchProfile.mockResolvedValue({ state: "available", profile: makeProfile(), routedContext });
    const result = await renderInspection(
      makeTurn({ routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5", routedContext } }),
    );

    expect(result.latest()).toMatchObject({ status: "verified", routedContext: { snapshotId: "context-snapshot-1" } });
    act(() => result.renderer.unmount());

    fetchProfile.mockResolvedValue({
      state: "available",
      profile: makeProfile(),
      routedContext: makeRoutedContext({ snapshotHash: "e".repeat(64) }),
    });
    const mismatched = await renderInspection(
      makeTurn({ routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5", routedContext } }),
    );
    expect(mismatched.latest()?.status).toBe("invalid");
    expect(mismatched.latest()?.routedContext).toBeUndefined();
    expect(mismatched.latest()?.mismatchFields).toContain("routed context snapshot hash");
    act(() => mismatched.renderer.unmount());
  });

  it("refetches inspection when only the routed-context trace binding changes", async () => {
    const firstContext = makeRoutedContext();
    const nextContext = makeRoutedContext({
      snapshotId: "context-snapshot-2",
      snapshotHash: "e".repeat(64),
      sourceRequestHash: "f".repeat(64),
      contentHash: "0".repeat(64),
    });
    fetchProfile
      .mockResolvedValueOnce({ state: "available", profile: makeProfile(), routedContext: firstContext })
      .mockResolvedValueOnce({ state: "available", profile: makeProfile(), routedContext: nextContext });
    const result = await renderInspection(
      makeTurn({ routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5", routedContext: firstContext } }),
    );
    expect(result.latest()?.routedContext?.snapshotId).toBe("context-snapshot-1");

    await result.update(
      makeTurn({ routing: { effectiveProviderId: "openai", effectiveModel: "gpt-5", routedContext: nextContext } }),
    );
    expect(fetchProfile).toHaveBeenCalledTimes(2);
    expect(result.latest()?.status).toBe("verified");
    expect(result.latest()?.routedContext?.snapshotId).toBe("context-snapshot-2");
    act(() => result.renderer.unmount());
  });

  it.each([
    [401, "forbidden", "outside the current operator or workspace scope"],
    [403, "forbidden", "outside the current operator or workspace scope"],
    [404, "not_found", "No persisted capability profile"],
  ])("maps HTTP %s to a scoped, non-sensitive inspection state", async (status, expectedStatus, copy) => {
    fetchProfile.mockRejectedValue({ status, message: "sensitive upstream detail" });
    const result = await renderInspection(makeTurn());

    expect(result.latest()?.status).toBe(expectedStatus);
    expect(result.latest()?.message).toContain(copy);
    expect(result.latest()?.message).not.toContain("sensitive upstream detail");
    expect(result.latest()?.profile).toBeNull();
    act(() => result.renderer.unmount());
  });

  it("labels unbound legacy turns without issuing an inspection request", async () => {
    const result = await renderInspection(
      makeTurn({ capabilityProfileId: undefined, capabilityProfileHash: undefined }),
    );
    expect(result.latest()?.status).toBe("legacy_missing");
    expect(fetchProfile).not.toHaveBeenCalled();
    act(() => result.renderer.unmount());
  });
});

describe("verifyChatCapabilityProfileAgainstTurn", () => {
  it("checks exact hash, identity, provider/model, memory, and execution selections", () => {
    expect(
      verifyChatCapabilityProfileAgainstTurn({
        profile: makeProfile(),
        sessionId: "session-1",
        workspaceId: "workspace-1",
        turn: makeTurn(),
      }),
    ).toEqual([]);
  });
});
