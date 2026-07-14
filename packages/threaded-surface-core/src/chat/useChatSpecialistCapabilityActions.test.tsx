import React, { useCallback, useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatSessionRecord,
  ChatSpecialistCandidateRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import { useChatSpecialistCapabilityActions } from "./useChatSpecialistCapabilityActions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const activateImportedAgentCatalogEntryMock = vi.fn();
const createChatSpecialistCandidateMock = vi.fn();
const createCapabilityProposalMock = vi.fn();
const createCodeModeRunMock = vi.fn();
const fetchMcpServersMock = vi.fn();
const fetchMcpTemplatesMock = vi.fn();
const fetchSkillsMock = vi.fn();
const installSkillImportMock = vi.fn();
const updateChatSpecialistCandidateMock = vi.fn();
const updateSkillStateMock = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  activateImportedAgentCatalogEntry: (...args: unknown[]) => activateImportedAgentCatalogEntryMock(...args),
  createChatSpecialistCandidate: (...args: unknown[]) => createChatSpecialistCandidateMock(...args),
  createCapabilityProposal: (...args: unknown[]) => createCapabilityProposalMock(...args),
  createCodeModeRun: (...args: unknown[]) => createCodeModeRunMock(...args),
  fetchMcpServers: (...args: unknown[]) => fetchMcpServersMock(...args),
  fetchMcpTemplates: (...args: unknown[]) => fetchMcpTemplatesMock(...args),
  fetchSkills: (...args: unknown[]) => fetchSkillsMock(...args),
  installSkillImport: (...args: unknown[]) => installSkillImportMock(...args),
  isApiRequestError: (error: unknown) =>
    typeof error === "object" && error !== null && typeof Reflect.get(error, "status") === "number",
  updateChatSpecialistCandidate: (...args: unknown[]) => updateChatSpecialistCandidateMock(...args),
  updateSkillState: (...args: unknown[]) => updateSkillStateMock(...args),
}));

type HookResult = ReturnType<typeof useChatSpecialistCapabilityActions>;

type HarnessSnapshot = {
  result: HookResult;
  errors: string[];
  notices: Array<{ content: string; tone?: string }>;
  specialistCandidates: ChatSpecialistCandidateRecord[];
  installedSkills: SkillListItem[];
  mcpServers: McpServerRecord[];
  mcpTemplates: Array<McpServerTemplateRecord & { installed: boolean }>;
  queuedOutbound: any[];
  executedOutbound: any[];
  sending: boolean;
};

let latestHarness: HarnessSnapshot | null = null;

function makeSession(): ChatSessionRecord {
  return {
    sessionId: "session-1",
    title: "Launch work",
    scope: "mission",
    lifecycleStatus: "active",
    pinned: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  } as ChatSessionRecord;
}

function makeCapabilitySuggestion(
  patch: Partial<ChatCapabilityUpgradeSuggestion> = {},
): ChatCapabilityUpgradeSuggestion {
  return {
    kind: "skill",
    title: "Planning skill",
    rationale: "The failed turn needs a planning skill.",
    recommendedAction: "enable_skill",
    candidateId: "skill-planning",
    riskLevel: "low",
    ...patch,
  } as ChatCapabilityUpgradeSuggestion;
}

function setupApiDefaults() {
  createChatSpecialistCandidateMock.mockResolvedValue({
    candidateId: "candidate-1",
    title: "Launch analyst",
  });
  updateChatSpecialistCandidateMock.mockResolvedValue({
    candidateId: "candidate-1",
    title: "Launch analyst",
    status: "approved",
  });
  activateImportedAgentCatalogEntryMock.mockResolvedValue({
    catalogEntry: { definition: { frontmatter: { name: "Catalog analyst" } } },
    specialist: { candidateId: "candidate-catalog", title: "Catalog analyst" },
  });
  createCapabilityProposalMock.mockResolvedValue({
    proposalId: "proposal-1",
    proposalKind: "skill",
    status: "proposed",
    title: "Build report helper",
    summary: "No current helper can build the report.",
    payload: {},
    candidateId: "candidate-build-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  createCodeModeRunMock.mockResolvedValue({
    runId: "code-run-1",
    status: "approval_pending",
  });
  updateSkillStateMock.mockResolvedValue({ skillId: "skill-planning", state: "enabled" });
  installSkillImportMock.mockResolvedValue({ installedSkillId: "skill-installed" });
  fetchSkillsMock.mockResolvedValue({
    items: [
      { skillId: "skill-planning", revision: 7, state: "enabled" },
      { skillId: "skill-installed", revision: 3, state: "disabled" },
    ],
  });
  fetchMcpServersMock.mockResolvedValue({ items: [{ serverId: "server-1", name: "Filesystem" }] });
  fetchMcpTemplatesMock.mockResolvedValue({ items: [{ templateId: "template-1", name: "GitHub", installed: false }] });
}

function Harness(props: {
  selectedSession?: ChatSessionRecord | null;
  selectedTurnId?: string | null;
  surfaceMode?: "chat" | "cowork" | "code";
  sendingInitial?: boolean;
  tryBegin?: boolean;
}) {
  const [sending, setSending] = useState(Boolean(props.sendingInitial));
  const [specialistCandidates, setSpecialistCandidates] = useState<ChatSpecialistCandidateRecord[]>([
    { candidateId: "candidate-old", title: "Old specialist" } as ChatSpecialistCandidateRecord,
  ]);
  const [installedSkills, setInstalledSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<Array<McpServerTemplateRecord & { installed: boolean }>>([]);
  const [queuedOutbound, setQueuedOutbound] = useState<any[]>([]);
  const errorsRef = useRef<string[]>([]);
  const noticesRef = useRef<Array<{ content: string; tone?: string }>>([]);
  const executedOutboundRef = useRef<any[]>([]);
  const selectedSession = props.selectedSession === undefined ? makeSession() : props.selectedSession;
  const setError = useCallback((value: string | null) => {
    if (value) {
      errorsRef.current.push(value);
    }
  }, []);
  const pushLocalNotice = useCallback((content: string, tone?: "neutral" | "success" | "warning") => {
    noticesRef.current.push({ content, tone });
  }, []);
  const executeOutboundItemRef = useRef(async (item: any) => {
    executedOutboundRef.current.push(item);
  });
  const tryBeginOutboundExecutionRef = useRef(() => props.tryBegin ?? true);

  const result = useChatSpecialistCapabilityActions({
    selectedSessionId: selectedSession?.sessionId ?? null,
    selectedSession,
    selectedTurnId: props.selectedTurnId === undefined ? "turn-1" : props.selectedTurnId,
    surfaceMode: props.surfaceMode ?? "chat",
    sending,
    setError,
    setSending,
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    setQueuedOutbound,
  });

  latestHarness = {
    result,
    errors: errorsRef.current,
    notices: noticesRef.current,
    specialistCandidates,
    installedSkills,
    mcpServers,
    mcpTemplates,
    queuedOutbound,
    executedOutbound: executedOutboundRef.current,
    sending,
  };
  return null;
}

async function flushEffects(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("useChatSpecialistCapabilityActions", () => {
  beforeEach(() => {
    latestHarness = null;
    vi.clearAllMocks();
    setupApiDefaults();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { hash: "" } },
    });
  });

  it("creates patches and activates specialist candidates", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });

    const suggestion = {
      title: "Launch analyst",
      role: "Analyst",
      instructions: "Watch launch risk.",
    } as any;
    await act(async () => {
      latestHarness?.result.setSpecialistSuggestions([suggestion, { title: "Other" } as any]);
    });
    await act(async () => {
      await latestHarness?.result.handleCreateSpecialistDraft(suggestion);
    });

    expect(createChatSpecialistCandidateMock).toHaveBeenCalledWith("session-1", {
      turnId: "turn-1",
      suggestion,
    });
    expect(latestHarness?.specialistCandidates[0]?.candidateId).toBe("candidate-1");
    expect(latestHarness?.result.specialistSuggestions).toEqual([{ title: "Other" }]);

    await act(async () => {
      await latestHarness?.result.handleSpecialistCandidatePatch(
        "candidate-1",
        { status: "approved" } as any,
        "Approved",
      );
    });

    expect(updateChatSpecialistCandidateMock).toHaveBeenCalledWith("session-1", "candidate-1", { status: "approved" });
    expect(latestHarness?.notices.at(-1)).toEqual({ content: "Approved", tone: "success" });

    await act(async () => {
      await latestHarness?.result.handleActivateCatalogSpecialist({ title: "Broken catalog" } as any);
    });
    expect(latestHarness?.errors).toContain("Catalog suggestion is missing its entry identifier.");

    await act(async () => {
      latestHarness?.result.setSpecialistSuggestions([{ candidateId: "catalog-1", title: "Catalog analyst" } as any]);
    });
    await act(async () => {
      await latestHarness?.result.handleActivateCatalogSpecialist({
        candidateId: "catalog-1",
        title: "Catalog analyst",
      } as any);
    });

    expect(activateImportedAgentCatalogEntryMock).toHaveBeenCalledWith("catalog-1", { sessionId: "session-1" });
    expect(latestHarness?.specialistCandidates[0]?.candidateId).toBe("candidate-catalog");
  });

  it("confirms skill enablement and resumes the failed turn", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });
    const suggestion = makeCapabilitySuggestion();
    await act(async () => {
      latestHarness?.result.setCapabilitySuggestions([suggestion]);
      latestHarness?.result.handleCapabilitySuggestionAction(suggestion);
    });

    expect(latestHarness?.result.capabilitySuggestionConfirm?.title).toBe("Planning skill");
    expect(latestHarness?.result.capabilityConfirmationCopy?.title).toBe("Enable skill");

    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(updateSkillStateMock).toHaveBeenCalledWith("skill-planning", {
      expectedRevision: 7,
      state: "enabled",
      note: "Enabled from chat capability suggestion.",
    });
    expect(fetchSkillsMock).toHaveBeenCalled();
    expect(latestHarness?.executedOutbound[0]).toEqual(
      expect.objectContaining({
        action: "retry",
        sessionId: "session-1",
        targetTurnId: "turn-1",
      }),
    );
    expect(latestHarness?.result.capabilitySuggestions).toEqual([]);
  });

  it("fails closed without a canonical skill revision and never resumes automatically", async () => {
    fetchSkillsMock.mockResolvedValue({ items: [{ skillId: "skill-planning", revision: 0, state: "enabled" }] });
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });
    const suggestion = makeCapabilitySuggestion();
    await act(async () => {
      latestHarness?.result.setCapabilitySuggestions([suggestion]);
      latestHarness?.result.handleCapabilitySuggestionAction(suggestion);
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(updateSkillStateMock).not.toHaveBeenCalled();
    expect(latestHarness?.executedOutbound).toEqual([]);
    expect(latestHarness?.errors).toContain(
      "Skill skill-planning is missing a positive canonical revision. Refresh skills and retry explicitly.",
    );
    expect(latestHarness?.result.capabilitySuggestions).toEqual([suggestion]);
  });

  it("does not replay a capability suggestion after a stale revision conflict", async () => {
    fetchSkillsMock
      .mockResolvedValueOnce({ items: [{ skillId: "skill-planning", revision: 7, state: "disabled" }] })
      .mockResolvedValueOnce({ items: [{ skillId: "skill-planning", revision: 8, state: "disabled" }] });
    updateSkillStateMock.mockRejectedValueOnce(
      Object.assign(new Error("Skill state changed elsewhere; refresh and retry explicitly."), {
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { expectedRevision: 7, currentRevision: 8 } },
      }),
    );
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });
    const suggestion = makeCapabilitySuggestion();
    await act(async () => {
      latestHarness?.result.setCapabilitySuggestions([suggestion]);
      latestHarness?.result.handleCapabilitySuggestionAction(suggestion);
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(updateSkillStateMock).toHaveBeenCalledTimes(1);
    expect(fetchSkillsMock).toHaveBeenCalledTimes(2);
    expect(latestHarness?.installedSkills).toEqual([
      expect.objectContaining({ skillId: "skill-planning", revision: 8 }),
    ]);
    expect(latestHarness?.executedOutbound).toEqual([]);
    expect(latestHarness?.queuedOutbound).toEqual([]);
    expect(latestHarness?.errors).toContain(
      "Skill skill-planning changed elsewhere. Canonical skills were refreshed; no update or turn retry was replayed. Review the refreshed state and retry explicitly.",
    );
    expect(latestHarness?.result.capabilitySuggestions).toEqual([suggestion]);
  });

  it("retains an enable-only intent after install conflicts without reinstalling or resuming", async () => {
    fetchSkillsMock
      .mockResolvedValueOnce({ items: [{ skillId: "skill-installed", revision: 3, state: "disabled" }] })
      .mockResolvedValueOnce({ items: [{ skillId: "skill-installed", revision: 4, state: "disabled" }] })
      .mockResolvedValueOnce({ items: [{ skillId: "skill-installed", revision: 4, state: "disabled" }] })
      .mockResolvedValueOnce({ items: [{ skillId: "skill-installed", revision: 5, state: "enabled" }] });
    updateSkillStateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Skill state changed elsewhere."), {
          status: 409,
          body: { code: "WRITE_CONFLICT", details: { expectedRevision: 3, currentRevision: 4 } },
        }),
      )
      .mockResolvedValueOnce({ skillId: "skill-installed", state: "enabled" });
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });
    const suggestion = makeCapabilitySuggestion({
      kind: "skill_import",
      recommendedAction: "install_skill_enable",
      title: "Hosted skill",
      candidateId: undefined,
      sourceRef: "skill://hosted",
      sourceProvider: "github",
    });
    await act(async () => {
      latestHarness?.result.setCapabilitySuggestions([suggestion]);
      latestHarness?.result.handleCapabilitySuggestionAction(suggestion);
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(installSkillImportMock).toHaveBeenCalledTimes(1);
    expect(updateSkillStateMock).toHaveBeenCalledTimes(1);
    expect(updateSkillStateMock).toHaveBeenCalledWith("skill-installed", {
      expectedRevision: 3,
      state: "enabled",
      note: "Enabled immediately from chat capability suggestion.",
    });
    expect(fetchSkillsMock).toHaveBeenCalledTimes(2);
    expect(latestHarness?.executedOutbound).toEqual([]);
    expect(latestHarness?.queuedOutbound).toEqual([]);
    expect(latestHarness?.result.capabilitySuggestions).toEqual([
      expect.objectContaining({
        kind: "existing_but_disabled",
        recommendedAction: "enable_skill",
        candidateId: "skill-installed",
        sourceProvider: undefined,
        sourceRef: undefined,
      }),
    ]);
    expect(latestHarness?.installedSkills).toEqual([
      expect.objectContaining({ skillId: "skill-installed", revision: 4, state: "disabled" }),
    ]);
    expect(latestHarness?.errors.at(-1)).toContain("no update or turn retry was replayed");

    const retainedIntent = latestHarness?.result.capabilitySuggestions[0];
    expect(retainedIntent).toBeDefined();
    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(retainedIntent!);
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(installSkillImportMock).toHaveBeenCalledTimes(1);
    expect(updateSkillStateMock).toHaveBeenCalledTimes(2);
    expect(updateSkillStateMock).toHaveBeenLastCalledWith("skill-installed", {
      expectedRevision: 4,
      state: "enabled",
      note: "Enabled from chat capability suggestion.",
    });
    expect(latestHarness?.executedOutbound).toHaveLength(1);
    expect(latestHarness?.result.capabilitySuggestions).toEqual([]);
  });

  it("queues resume work when outbound execution cannot start and warns without a selected turn", async () => {
    await act(async () => {
      create(<Harness tryBegin={false} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
      latestHarness?.result.handleCapabilitySuggestionAction(makeCapabilitySuggestion());
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(latestHarness?.queuedOutbound[0]).toEqual(
      expect.objectContaining({ action: "retry", targetTurnId: "turn-1" }),
    );
    expect(latestHarness?.notices.at(-1)?.content).toContain("queued to resume");

    await act(async () => {
      create(<Harness selectedTurnId={null} />);
      await flushEffects();
    });
    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(makeCapabilitySuggestion());
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(latestHarness?.notices.at(-1)?.content).toContain("there is no failed turn selected");
  });

  it("handles install template navigation and connection capability actions", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({
          recommendedAction: "install_skill_disabled",
          title: "Offline research",
          sourceRef: "skill://offline",
          sourceProvider: "github",
        }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(installSkillImportMock).toHaveBeenCalledWith({
      sourceRef: "skill://offline",
      sourceProvider: "github",
      confirmHighRisk: false,
    });
    expect((globalThis.window as any).location.hash).toBe("skills");

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({
          recommendedAction: "install_skill_enable",
          title: "Hosted skill",
          sourceRef: "skill://hosted",
          sourceProvider: "mcp_template",
          riskLevel: "high",
        }),
      );
    });
    expect(latestHarness?.result.capabilityConfirmationCopy?.danger).toBe(true);
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(updateSkillStateMock).toHaveBeenCalledWith("skill-installed", {
      expectedRevision: 3,
      state: "enabled",
      note: "Enabled immediately from chat capability suggestion.",
    });

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({
          recommendedAction: "add_mcp_template",
          title: "GitHub MCP",
          sourceRef: "mcp-template://github",
        }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect((globalThis.window as any).location.hash).toBe("mcp?template=github");

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "switch_tool_profile" }),
      );
      await flushEffects();
    });
    expect((globalThis.window as any).location.hash).toBe("tools");

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "connect_mcp" }),
      );
      await flushEffects();
    });
    expect(latestHarness?.mcpServers[0]?.serverId).toBe("server-1");
    expect(latestHarness?.mcpTemplates[0]?.templateId).toBe("template-1");
    expect((globalThis.window as any).location.hash).toBe("mcp");
  });

  it("creates a proposal and Code Mode run for reusable capability build suggestions", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });

    const suggestion = makeCapabilitySuggestion({
      kind: "code_mode_build",
      recommendedAction: "build_code_mode_skill_candidate",
      candidateId: "candidate-build-1",
      title: "Build report helper",
      summary: "No current helper can build the report.",
      reason: "No existing capability matched.",
      sourceProvider: "code_mode",
      sourceSessionId: "session-1",
      sourceTurnId: "turn-1",
      intendedBehavior: "Turn report requests into reusable report helper skills.",
      candidateType: "self_generated_skill",
      requiredPermissions: [],
      validationExpectation: "The governed capability build must stage candidate proof.",
      rollbackPosture: "Candidate remains inactive until approved.",
    });

    await act(async () => {
      latestHarness?.result.setCapabilitySuggestions([suggestion]);
      latestHarness?.result.handleCapabilitySuggestionAction(suggestion);
    });
    expect(latestHarness?.result.capabilityConfirmationCopy?.title).toBe("Build reusable capability");

    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });

    expect(createCapabilityProposalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalKind: "skill",
        candidateId: "candidate-build-1",
        payload: expect.objectContaining({
          proposalSource: "chat_capability_gap",
          codeMode: expect.objectContaining({
            sourceSessionId: "session-1",
            sourceTurnId: "turn-1",
            candidateType: "self_generated_skill",
          }),
        }),
      }),
    );
    expect(createCodeModeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "javascript",
        originSurface: "chat",
        sessionId: "session-1",
        turnId: "turn-1",
        saveCandidateOnSuccess: true,
        requestedOutputIntent: "Turn report requests into reusable report helper skills.",
        input: expect.objectContaining({
          capabilityProposal: expect.objectContaining({
            proposalId: "proposal-1",
            candidateId: "candidate-build-1",
          }),
          candidateSkillMarkdown: expect.stringContaining("## When to use"),
        }),
      }),
    );
    expect(latestHarness?.executedOutbound).toEqual([]);
    expect(latestHarness?.result.capabilitySuggestions).toEqual([]);
    expect(latestHarness?.notices.at(-1)?.content).toContain("queued governed capability build code-run-1");
    expect((globalThis.window as any).location.hash).toBe("");
  });

  it("surfaces unsupported and malformed capability actions", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "connect_mcp" }),
      );
      await flushEffects();
    });
    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "install_skill_disabled", sourceRef: undefined }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(latestHarness?.errors).toContain("This suggestion is missing the import source.");

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "unsupported_action" as any }),
      );
      await flushEffects();
    });
    expect(latestHarness?.errors).toContain("Unsupported capability action: unsupported_action");
  });

  it("covers guarded specialist actions and capability install edge cases", async () => {
    const suggestion = { title: "Launch analyst", role: "Analyst" } as any;
    await act(async () => {
      create(<Harness selectedSession={null} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleCreateSpecialistDraft(suggestion);
      await latestHarness?.result.handleSpecialistCandidatePatch(
        "candidate-1",
        { status: "approved" } as any,
        "Approved",
      );
      await latestHarness?.result.handleActivateCatalogSpecialist({
        candidateId: "catalog-1",
        title: "Catalog",
      } as any);
    });
    expect(createChatSpecialistCandidateMock).not.toHaveBeenCalled();
    expect(updateChatSpecialistCandidateMock).not.toHaveBeenCalled();
    expect(activateImportedAgentCatalogEntryMock).not.toHaveBeenCalled();

    await act(async () => {
      create(<Harness sendingInitial />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleCreateSpecialistDraft(suggestion);
      await latestHarness?.result.handleSpecialistCandidatePatch(
        "candidate-1",
        { status: "approved" } as any,
        "Approved",
      );
      await latestHarness?.result.handleActivateCatalogSpecialist({
        candidateId: "catalog-1",
        title: "Catalog",
      } as any);
    });
    expect(createChatSpecialistCandidateMock).not.toHaveBeenCalled();

    createChatSpecialistCandidateMock.mockRejectedValueOnce(new Error("draft failed"));
    updateChatSpecialistCandidateMock.mockRejectedValueOnce(new Error("patch failed"));
    activateImportedAgentCatalogEntryMock.mockRejectedValueOnce(new Error("activate failed"));
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleCreateSpecialistDraft(suggestion);
      await latestHarness?.result.handleSpecialistCandidatePatch(
        "candidate-1",
        { status: "approved" } as any,
        "Approved",
      );
      await latestHarness?.result.handleActivateCatalogSpecialist({
        candidateId: "catalog-1",
        title: "Catalog",
      } as any);
    });
    expect(latestHarness?.errors).toEqual(expect.arrayContaining(["draft failed", "patch failed", "activate failed"]));

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "enable_skill", candidateId: undefined }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(latestHarness?.errors).toContain("This suggestion is missing the installed skill identifier.");

    installSkillImportMock.mockResolvedValueOnce({});
    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({
          recommendedAction: "install_skill_disabled",
          sourceRef: "skill://plain",
          sourceProvider: "mcp_template",
        }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(installSkillImportMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceProvider: undefined, confirmHighRisk: false }),
    );
    expect(latestHarness?.notices.at(-1)?.content).toBe(
      "Installed the suggested skill. It remains disabled by default until you enable it.",
    );

    installSkillImportMock.mockResolvedValueOnce({});
    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({
          recommendedAction: "install_skill_enable",
          sourceRef: "skill://missing-id",
          sourceProvider: "github",
        }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(latestHarness?.errors).toContain(
      "The skill installed, but GoatCitadel could not resolve its installed skill identifier.",
    );

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "add_mcp_template", sourceRef: undefined }),
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(latestHarness?.errors).toContain("This suggestion is missing the template reference.");

    await act(async () => {
      latestHarness?.result.handleCapabilitySuggestionAction(
        makeCapabilitySuggestion({ recommendedAction: "install_skill_enable", sourceRef: undefined }),
      );
    });
    await act(async () => {
      await latestHarness?.result.confirmCapabilitySuggestionAction();
    });
    expect(latestHarness?.errors).toContain("This suggestion is missing the import source.");
  });
});
