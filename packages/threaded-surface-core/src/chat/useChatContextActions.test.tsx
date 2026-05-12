import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const childHookMocks = vi.hoisted(() => ({
  useChatDelegationPolicyActions: vi.fn(),
  useChatMemoryRefreshActions: vi.fn(),
  useChatSpecialistCapabilityActions: vi.fn(),
}));

vi.mock("./useChatDelegationPolicyActions", () => ({
  useChatDelegationPolicyActions: childHookMocks.useChatDelegationPolicyActions,
}));

vi.mock("./useChatMemoryRefreshActions", () => ({
  useChatMemoryRefreshActions: childHookMocks.useChatMemoryRefreshActions,
}));

vi.mock("./useChatSpecialistCapabilityActions", () => ({
  useChatSpecialistCapabilityActions: childHookMocks.useChatSpecialistCapabilityActions,
}));

import { useChatContextActions } from "./useChatContextActions";

let latestActions: ReturnType<typeof useChatContextActions> | null = null;

function Harness() {
  const input = {
    selectedSessionId: "session-1",
    selectedSession: { sessionId: "session-1" },
    selectedTurnId: "turn-1",
    thread: { turns: [] },
    draft: "draft",
    messages: [],
    prefs: { sessionId: "session-1", mode: "chat" },
    selectedProviderId: "openai",
    selectedModel: "gpt-5.5",
    surfaceMode: "chat",
    sending: false,
    streamEnabled: true,
    codeModeNeedsProjectBinding: false,
    loadSidebar: vi.fn(),
    ensureSession: vi.fn(),
    setError: vi.fn(),
    setSending: vi.fn(),
    setPrefs: vi.fn(),
    setProactiveStatus: vi.fn(),
    setProactiveRuns: vi.fn(),
    learnedMemory: [],
    setLearnedMemory: vi.fn(),
    specialistCandidates: [],
    setSpecialistCandidates: vi.fn(),
    setInstalledSkills: vi.fn(),
    setMcpServers: vi.fn(),
    setMcpTemplates: vi.fn(),
    pushLocalNotice: vi.fn(),
    lastLocalPrefMutationAtRef: { current: 0 },
    executeOutboundItemRef: { current: vi.fn() },
    tryBeginOutboundExecutionRef: { current: vi.fn() },
    setQueuedOutbound: vi.fn(),
  } as Parameters<typeof useChatContextActions>[0];
  latestActions = useChatContextActions(input);
  return null;
}

describe("useChatContextActions", () => {
  beforeEach(() => {
    latestActions = null;
    childHookMocks.useChatDelegationPolicyActions.mockReset();
    childHookMocks.useChatMemoryRefreshActions.mockReset();
    childHookMocks.useChatSpecialistCapabilityActions.mockReset();
    childHookMocks.useChatDelegationPolicyActions.mockReturnValue({ delegationAction: vi.fn() });
    childHookMocks.useChatMemoryRefreshActions.mockReturnValue({ memoryAction: vi.fn() });
    childHookMocks.useChatSpecialistCapabilityActions.mockReturnValue({ specialistAction: vi.fn() });
  });

  it("composes delegation, memory, and specialist action hooks with scoped inputs", async () => {
    await act(async () => {
      create(<Harness />);
    });

    expect(childHookMocks.useChatDelegationPolicyActions).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSessionId: "session-1",
        selectedTurnId: "turn-1",
        selectedProviderId: "openai",
      }),
    );
    expect(childHookMocks.useChatMemoryRefreshActions).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSession: { sessionId: "session-1" },
        sending: false,
      }),
    );
    expect(childHookMocks.useChatSpecialistCapabilityActions).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSessionId: "session-1",
        selectedTurnId: "turn-1",
        sending: false,
      }),
    );
    expect(Object.keys(latestActions ?? {}).sort()).toEqual(["delegationAction", "memoryAction", "specialistAction"]);
  });
});
