import React, { useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSpecialistCapabilityActions } from "./useChatSpecialistCapabilityActions";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

const apiMocks = vi.hoisted(() => ({
  activateImportedAgentCatalogEntry: vi.fn(),
  createChatSpecialistCandidate: vi.fn(),
  fetchMcpServers: vi.fn(),
  fetchMcpTemplates: vi.fn(),
  fetchSkills: vi.fn(),
  installSkillImport: vi.fn(),
  updateChatSpecialistCandidate: vi.fn(),
  updateSkillState: vi.fn(),
}));

vi.mock("../../api/client", () => apiMocks);

type Notice = { content: string; tone?: "neutral" | "success" | "warning" };
type HarnessState = ReturnType<typeof useChatSpecialistCapabilityActions> & {
  error: string | null;
  sending: boolean;
  specialistCandidates: any[];
  installedSkills: any[];
  mcpServers: any[];
  mcpTemplates: any[];
  notices: Notice[];
  queuedOutbound: OutboundQueueItem[];
  executeOutboundItem: ReturnType<typeof vi.fn>;
  tryBeginOutboundExecution: ReturnType<typeof vi.fn>;
};

let latest: HarnessState | null = null;

const selectedSession = {
  sessionId: "session-1",
  title: "Coverage work",
  mode: "code",
  pinned: false,
  lifecycleStatus: "active",
  scope: "mission",
};

function Harness(props: {
  selectedSession?: any | null;
  selectedTurnId?: string | null;
  selectedSessionId?: string | null;
  canBeginOutbound?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [specialistCandidates, setSpecialistCandidates] = useState<any[]>([]);
  const [installedSkills, setInstalledSkills] = useState<any[]>([]);
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<any[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [queuedOutbound, setQueuedOutbound] = useState<OutboundQueueItem[]>([]);
  const executeOutboundItem = useRef(vi.fn(async () => undefined));
  const tryBeginOutboundExecution = useRef(vi.fn(() => props.canBeginOutbound ?? true));

  const hook = useChatSpecialistCapabilityActions({
    selectedSessionId: props.selectedSessionId ?? "session-1",
    selectedSession: props.selectedSession === undefined ? selectedSession : props.selectedSession,
    selectedTurnId: props.selectedTurnId ?? "turn-1",
    sending,
    setError,
    setSending,
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice: (content, tone) => setNotices((current) => [...current, { content, tone }]),
    executeOutboundItemRef: executeOutboundItem,
    tryBeginOutboundExecutionRef: tryBeginOutboundExecution,
    setQueuedOutbound,
  });

  latest = {
    ...hook,
    error,
    sending,
    specialistCandidates,
    installedSkills,
    mcpServers,
    mcpTemplates,
    notices,
    queuedOutbound,
    executeOutboundItem: executeOutboundItem.current,
    tryBeginOutboundExecution: tryBeginOutboundExecution.current,
  };
  return null;
}

describe("useChatSpecialistCapabilityActions", () => {
  beforeEach(() => {
    latest = null;
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      location: {
        hash: "",
      },
    });
    window.location.hash = "";
    apiMocks.createChatSpecialistCandidate.mockResolvedValue({
      candidateId: "candidate-created",
      title: "Repository reviewer",
      status: "draft",
    });
    apiMocks.updateChatSpecialistCandidate.mockResolvedValue({
      candidateId: "candidate-created",
      title: "Repository reviewer",
      status: "approved",
    });
    apiMocks.activateImportedAgentCatalogEntry.mockResolvedValue({
      catalogEntry: {
        definition: {
          frontmatter: {
            name: "Docs analyst",
          },
        },
      },
      specialist: {
        candidateId: "catalog-specialist",
        title: "Docs analyst",
        status: "approved",
      },
    });
    apiMocks.updateSkillState.mockResolvedValue({ skillId: "skill-reviewer" });
    apiMocks.installSkillImport.mockResolvedValue({ installedSkillId: "skill-installed" });
    apiMocks.fetchSkills.mockResolvedValue({ items: [{ skillId: "skill-reviewer", state: "enabled" }] });
    apiMocks.fetchMcpServers.mockResolvedValue({ items: [{ serverId: "server-1" }] });
    apiMocks.fetchMcpTemplates.mockResolvedValue({ items: [{ templateId: "template-1", installed: false }] });
  });

  it("creates, patches, and activates specialist candidates with local list updates", async () => {
    create(<Harness />);
    const suggestion = {
      title: "Repository reviewer",
      summary: "Review the current implementation.",
      role: "Reviewer",
    } as any;

    await act(async () => {
      await latest?.handleCreateSpecialistDraft(suggestion);
    });

    expect(apiMocks.createChatSpecialistCandidate).toHaveBeenCalledWith("session-1", {
      turnId: "turn-1",
      suggestion,
    });
    expect(latest?.specialistCandidates).toEqual([
      expect.objectContaining({ candidateId: "candidate-created", status: "draft" }),
    ]);
    expect(latest?.notices.at(-1)).toEqual({
      content: "Drafted specialist candidate: Repository reviewer.",
      tone: "success",
    });

    await act(async () => {
      await latest?.handleSpecialistCandidatePatch(
        "candidate-created",
        { status: "approved" } as any,
        "Specialist approved.",
      );
    });

    expect(apiMocks.updateChatSpecialistCandidate).toHaveBeenCalledWith("session-1", "candidate-created", {
      status: "approved",
    });
    expect(latest?.specialistCandidates).toEqual([
      expect.objectContaining({ candidateId: "candidate-created", status: "approved" }),
    ]);

    await act(async () => {
      await latest?.handleActivateCatalogSpecialist({
        candidateId: "catalog-entry-1",
        title: "Docs analyst",
      } as any);
    });

    expect(apiMocks.activateImportedAgentCatalogEntry).toHaveBeenCalledWith("catalog-entry-1", {
      sessionId: "session-1",
    });
    expect(latest?.specialistCandidates[0]).toEqual(expect.objectContaining({ candidateId: "catalog-specialist" }));
    expect(latest?.notices.at(-1)).toEqual({
      content: "Activated Docs analyst for this session as a manual-only specialist.",
      tone: "success",
    });
  });

  it("confirms an enable-skill suggestion, refreshes skills, and queues resume when outbound is busy", async () => {
    create(<Harness canBeginOutbound={false} />);
    const suggestion = {
      kind: "skill",
      title: "Reviewer skill",
      candidateId: "skill-reviewer",
      recommendedAction: "enable_skill",
      riskLevel: "medium",
    } as any;

    await act(async () => {
      latest?.setCapabilitySuggestions([suggestion]);
    });
    await act(async () => {
      latest?.handleCapabilitySuggestionAction(suggestion);
    });

    expect(latest?.capabilitySuggestionConfirm).toEqual(suggestion);
    expect(latest?.capabilityConfirmationCopy).toEqual(
      expect.objectContaining({
        title: "Enable skill",
        confirmLabel: "Enable and resume",
      }),
    );
    expect(apiMocks.updateSkillState).not.toHaveBeenCalled();

    await act(async () => {
      await latest?.confirmCapabilitySuggestionAction();
    });

    expect(apiMocks.updateSkillState).toHaveBeenCalledWith("skill-reviewer", {
      state: "enabled",
      note: "Enabled from chat capability suggestion.",
    });
    expect(apiMocks.fetchSkills).toHaveBeenCalledTimes(1);
    expect(latest?.installedSkills).toEqual([{ skillId: "skill-reviewer", state: "enabled" }]);
    expect(latest?.capabilitySuggestions).toEqual([]);
    expect(latest?.queuedOutbound).toEqual([
      expect.objectContaining({
        action: "retry",
        sessionId: "session-1",
        targetTurnId: "turn-1",
      }),
    ]);
    expect(latest?.executeOutboundItem).not.toHaveBeenCalled();
    expect(latest?.notices.map((notice) => notice.content)).toContain(
      "Capability upgraded. The original request has been queued to resume automatically.",
    );
  });

  it("installs disabled skills for review and routes the operator to Skills", async () => {
    create(<Harness />);
    const suggestion = {
      kind: "skill",
      title: "Hosted researcher",
      sourceRef: "https://example.test/skill.md",
      sourceProvider: "url",
      recommendedAction: "install_skill_disabled",
      riskLevel: "low",
    } as any;

    await act(async () => {
      latest?.handleCapabilitySuggestionAction(suggestion);
    });
    await act(async () => {
      await latest?.confirmCapabilitySuggestionAction();
    });

    expect(apiMocks.installSkillImport).toHaveBeenCalledWith({
      sourceRef: "https://example.test/skill.md",
      sourceProvider: "url",
      confirmHighRisk: false,
    });
    expect(apiMocks.fetchSkills).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("skills");
    expect(latest?.notices.at(-1)).toEqual({
      content: "Installed skill-installed. It remains disabled by default until you enable it.",
      tone: "success",
    });
  });

  it("routes MCP and tool profile suggestions without mutating specialists", async () => {
    create(<Harness />);
    const mcpSuggestion = {
      kind: "mcp",
      title: "Filesystem MCP",
      sourceRef: "mcp-template://filesystem/local",
      recommendedAction: "add_mcp_template",
      riskLevel: "low",
    } as any;

    await act(async () => {
      latest?.handleCapabilitySuggestionAction(mcpSuggestion);
    });
    await act(async () => {
      await latest?.confirmCapabilitySuggestionAction();
    });

    expect(apiMocks.fetchMcpTemplates).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("mcp?template=filesystem%2Flocal");

    await act(async () => {
      latest?.handleCapabilitySuggestionAction({
        kind: "profile",
        title: "Tool profile",
        recommendedAction: "switch_tool_profile",
        riskLevel: "low",
      } as any);
    });

    expect(window.location.hash).toBe("tools");

    await act(async () => {
      await latest?.handleCapabilitySuggestionAction({
        kind: "mcp",
        title: "Connect MCP",
        recommendedAction: "connect_mcp",
        riskLevel: "low",
      } as any);
    });

    expect(apiMocks.fetchMcpServers).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchMcpTemplates).toHaveBeenCalledTimes(2);
    expect(latest?.mcpServers).toEqual([{ serverId: "server-1" }]);
    expect(latest?.mcpTemplates).toEqual([{ templateId: "template-1", installed: false }]);
    expect(window.location.hash).toBe("mcp");
  });

  it("reports missing identifiers instead of calling unsafe capability mutations", async () => {
    create(<Harness />);

    await act(async () => {
      await latest?.handleActivateCatalogSpecialist({ title: "Broken catalog entry" } as any);
    });
    expect(apiMocks.activateImportedAgentCatalogEntry).not.toHaveBeenCalled();
    expect(latest?.error).toBe("Catalog suggestion is missing its entry identifier.");

    await act(async () => {
      latest?.handleCapabilitySuggestionAction({
        kind: "skill",
        title: "Broken enable",
        recommendedAction: "enable_skill",
        riskLevel: "low",
      } as any);
    });
    await act(async () => {
      await latest?.confirmCapabilitySuggestionAction();
    });

    expect(apiMocks.updateSkillState).not.toHaveBeenCalled();
    expect(latest?.error).toBe("This suggestion is missing the installed skill identifier.");
  });
});
