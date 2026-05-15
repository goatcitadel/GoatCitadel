import React, { useRef, useState } from "react";
import { create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatContextActions } from "./useChatContextActions";

const hookMocks = vi.hoisted(() => ({
  useChatDelegationPolicyActions: vi.fn(),
  useChatMemoryRefreshActions: vi.fn(),
  useChatSpecialistCapabilityActions: vi.fn(),
}));

vi.mock("./useChatDelegationPolicyActions", () => ({
  useChatDelegationPolicyActions: hookMocks.useChatDelegationPolicyActions,
}));

vi.mock("./useChatMemoryRefreshActions", () => ({
  useChatMemoryRefreshActions: hookMocks.useChatMemoryRefreshActions,
}));

vi.mock("./useChatSpecialistCapabilityActions", () => ({
  useChatSpecialistCapabilityActions: hookMocks.useChatSpecialistCapabilityActions,
}));

let latest: ReturnType<typeof useChatContextActions> | null = null;

const selectedSession = {
  sessionId: "session-1",
  sessionKey: "mission:operator:chat_1",
  workspaceId: "default",
  scope: "mission",
  origin: "operator",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "operator",
  updatedAt: "2026-04-14T00:00:00.000Z",
  lastActivityAt: "2026-04-14T00:00:00.000Z",
  tokenTotal: 0,
  costUsdTotal: 0,
};

function Harness() {
  const [sending, setSending] = useState(false);
  const [prefs, setPrefs] = useState<any>({ sessionId: "session-1", mode: "chat" });
  const [, setProactiveStatus] = useState<any>(null);
  const [, setProactiveRuns] = useState<any[]>([]);
  const [, setLearnedMemory] = useState<any[]>([]);
  const [, setSpecialistCandidates] = useState<any[]>([]);
  const [, setInstalledSkills] = useState<any[]>([]);
  const [, setMcpServers] = useState<any[]>([]);
  const [, setMcpTemplates] = useState<any[]>([]);
  const lastLocalPrefMutationAtRef = useRef(0);
  const executeOutboundItemRef = useRef(async () => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const [, setQueuedOutbound] = useState<any[]>([]);

  latest = useChatContextActions({
    selectedSessionId: "session-1",
    selectedSession: selectedSession as any,
    selectedTurnId: "turn-1",
    thread: { sessionId: "session-1", turns: [] } as any,
    draft: "Draft",
    messages: [],
    prefs,
    sending,
    streamEnabled: true,
    codeModeNeedsProjectBinding: false,
    loadSidebar: async () => undefined,
    ensureSession: async () => selectedSession as any,
    setError: () => undefined,
    setSending,
    setPrefs,
    setProactiveStatus,
    setProactiveRuns,
    learnedMemory: [],
    setLearnedMemory,
    specialistCandidates: [],
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice: () => undefined,
    lastLocalPrefMutationAtRef,
    executeOutboundItemRef: executeOutboundItemRef as any,
    tryBeginOutboundExecutionRef,
    setQueuedOutbound,
  });
  return null;
}

describe("useChatContextActions", () => {
  beforeEach(() => {
    latest = null;
    hookMocks.useChatDelegationPolicyActions.mockReset();
    hookMocks.useChatMemoryRefreshActions.mockReset();
    hookMocks.useChatSpecialistCapabilityActions.mockReset();
    hookMocks.useChatDelegationPolicyActions.mockReturnValue({ handleRunQuickResearch: vi.fn() });
    hookMocks.useChatMemoryRefreshActions.mockReturnValue({ handleRebuildLearnedMemory: vi.fn() });
    hookMocks.useChatSpecialistCapabilityActions.mockReturnValue({ handleInstallCapabilitySuggestion: vi.fn() });
  });

  it("composes delegation, memory, and specialist capability action groups", () => {
    const renderer = create(<Harness />);
    try {
      expect(latest).toEqual({
        handleRunQuickResearch: expect.any(Function),
        handleRebuildLearnedMemory: expect.any(Function),
        handleInstallCapabilitySuggestion: expect.any(Function),
      });
      expect(hookMocks.useChatDelegationPolicyActions).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedSession: expect.objectContaining({ sessionId: "session-1" }),
          draft: "Draft",
          streamEnabled: true,
        }),
      );
      expect(hookMocks.useChatMemoryRefreshActions).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedSession: expect.objectContaining({ sessionId: "session-1" }),
          sending: false,
          setLearnedMemory: expect.any(Function),
        }),
      );
      expect(hookMocks.useChatSpecialistCapabilityActions).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedSessionId: "session-1",
          selectedTurnId: "turn-1",
          setQueuedOutbound: expect.any(Function),
        }),
      );
    } finally {
      renderer.unmount();
    }
  });
});
