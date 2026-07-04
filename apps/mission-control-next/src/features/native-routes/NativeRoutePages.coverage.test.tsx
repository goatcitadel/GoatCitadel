import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getErrorMessage,
  NativeRoutePages,
  readPayloadEvidenceRefs,
  readPayloadPath,
  readPayloadString,
} from "./NativeRoutePages";

const routeMocks = vi.hoisted(() => {
  const fn = (value: unknown = {}) => vi.fn(async () => value);
  return {
    activateImprovementCandidate: fn(),
    addTaskDeliverable: fn(),
    approveImprovementCandidate: fn(),
    archiveAgentProfile: fn(),
    createAgentProfile: fn(),
    createFileFromTemplate: fn(),
    createSkillEvaluationProposal: fn(),
    createTask: fn(),
    deleteTask: fn(),
    downloadFile: fn(),
    fetchAgents: fn(),
    fetchCapabilityCatalog: vi.fn(),
    fetchCapabilityProposal: fn(),
    fetchChatGeneratedArtifacts: fn(),
    fetchCuratorReviewItem: fn(),
    fetchFileTemplates: fn(),
    fetchFilesList: fn(),
    fetchImportedAgentCatalog: fn(),
    fetchMemoryFiles: fn(),
    fetchMemoryQmdStats: fn(),
    fetchOperators: fn(),
    fetchAgenticRuns: fn(),
    fetchSkillActivationPolicies: fn(),
    fetchSkillEvaluations: fn(),
    fetchSkillImportHistory: fn(),
    fetchSkillSources: fn(),
    fetchSkills: fn(),
    fetchTaskDeliverables: fn(),
    fetchTasksByView: vi.fn(),
    previewSkillEvaluation: fn(),
    promoteImprovementCandidate: fn(),
    rejectImprovementCandidate: fn(),
    reloadSkills: fn(),
    restoreAgentProfile: fn(),
    restoreTask: fn(),
    runSkillEvaluation: fn(),
    snoozeImprovementCandidate: fn(),
    updateAgentProfile: fn(),
    updateSkillState: fn(),
    updateTask: fn(),
    validateImprovementCandidate: fn(),
  };
});

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  activateImprovementCandidate: routeMocks.activateImprovementCandidate,
  addTaskDeliverable: routeMocks.addTaskDeliverable,
  approveImprovementCandidate: routeMocks.approveImprovementCandidate,
  archiveAgentProfile: routeMocks.archiveAgentProfile,
  createAgentProfile: routeMocks.createAgentProfile,
  createFileFromTemplate: routeMocks.createFileFromTemplate,
  createSkillEvaluationProposal: routeMocks.createSkillEvaluationProposal,
  createTask: routeMocks.createTask,
  deleteTask: routeMocks.deleteTask,
  downloadFile: routeMocks.downloadFile,
  fetchAgents: routeMocks.fetchAgents,
  fetchCapabilityCatalog: routeMocks.fetchCapabilityCatalog,
  fetchCapabilityProposal: routeMocks.fetchCapabilityProposal,
  fetchChatGeneratedArtifacts: routeMocks.fetchChatGeneratedArtifacts,
  fetchCuratorReviewItem: routeMocks.fetchCuratorReviewItem,
  fetchFileTemplates: routeMocks.fetchFileTemplates,
  fetchFilesList: routeMocks.fetchFilesList,
  fetchImportedAgentCatalog: routeMocks.fetchImportedAgentCatalog,
  fetchMemoryFiles: routeMocks.fetchMemoryFiles,
  fetchMemoryQmdStats: routeMocks.fetchMemoryQmdStats,
  fetchOperators: routeMocks.fetchOperators,
  fetchAgenticRuns: routeMocks.fetchAgenticRuns,
  fetchSkillActivationPolicies: routeMocks.fetchSkillActivationPolicies,
  fetchSkillEvaluations: routeMocks.fetchSkillEvaluations,
  fetchSkillImportHistory: routeMocks.fetchSkillImportHistory,
  fetchSkillSources: routeMocks.fetchSkillSources,
  fetchSkills: routeMocks.fetchSkills,
  fetchTaskDeliverables: routeMocks.fetchTaskDeliverables,
  fetchTasksByView: routeMocks.fetchTasksByView,
  previewSkillEvaluation: routeMocks.previewSkillEvaluation,
  promoteImprovementCandidate: routeMocks.promoteImprovementCandidate,
  rejectImprovementCandidate: routeMocks.rejectImprovementCandidate,
  reloadSkills: routeMocks.reloadSkills,
  restoreAgentProfile: routeMocks.restoreAgentProfile,
  restoreTask: routeMocks.restoreTask,
  runSkillEvaluation: routeMocks.runSkillEvaluation,
  snoozeImprovementCandidate: routeMocks.snoozeImprovementCandidate,
  updateAgentProfile: routeMocks.updateAgentProfile,
  updateSkillState: routeMocks.updateSkillState,
  updateTask: routeMocks.updateTask,
  validateImprovementCandidate: routeMocks.validateImprovementCandidate,
}));

vi.mock("./SettingsNativePage", () => ({
  SettingsNativePage: () => "Settings child route",
}));

vi.mock("./library/MemoryRoutePage", () => ({
  MemoryRoutePage: () => "Memory child route",
}));

vi.mock("./library/CuratorRoutePage", () => ({
  CuratorRoutePage: () => "Curator child route",
}));

vi.mock("./ops/ApprovalsRoutePage", () => ({
  ApprovalsRoutePage: () => "Approvals child route",
}));

vi.mock("./ops/RuntimeRoutePage", () => ({
  RuntimeRoutePage: () => "Runtime child route",
}));

vi.mock("./projects/ProjectsRoutePage", () => ({
  ProjectsRoutePage: () => "Projects child route",
}));

const agent = {
  agentId: "agent-1",
  roleId: "architect",
  name: "Architect",
  title: "Systems architect",
  summary: "Reviews architecture and tradeoffs.",
  specialties: ["architecture", "interfaces"],
  aliases: ["design"],
  defaultTools: ["browser.search"],
  editable: true,
  lifecycleStatus: "active",
  sessionCount: 3,
};

const skill = {
  skillId: "skill-1",
  name: "Safe improvement",
  state: "enabled",
  callable: true,
  source: "bundled",
  requires: ["filesystem"],
  declaredTools: ["shell"],
  instructionBody: "Review evidence before changing skills.",
  dir: "skills/safe-improvement",
  trustLabel: "trusted",
  lifecycleState: "active",
  capabilityCategory: "review",
};

const evaluationRun = {
  runId: "eval-1",
  skillId: "skill-1",
  skillName: "Safe improvement",
  status: "proposal_created",
  targetPassRate: 0.8,
  baselineResult: { score: { passRate: 0.5 } },
  candidateResult: { score: { passRate: 0.82 } },
  improvementDelta: 0.32,
  accepted: true,
  scenarios: [{ title: "Trace", prompt: "Trace it", expectedOutcome: "Grounded evidence" }],
  criteria: [{ label: "Grounded", description: "Uses evidence", requiredTerms: ["evidence"] }],
  mutation: { summary: "Tighten evidence review.", patchPreview: "- old\n+ new" },
  operatorTruth: "Review-first.",
  improvementCandidateId: "candidate-1",
  proposalId: "proposal-1",
  updatedAt: "2026-05-02T19:00:00.000Z",
};

const evaluationRunWithoutProposal = {
  ...evaluationRun,
  runId: "eval-ready",
  status: "completed",
  proposalId: null,
};

const curatorReview = {
  candidate: { candidateId: "candidate-1", status: "approved" },
  observedIssue: "Evidence handling was too weak.",
  proposedChange: "Require traceable proof.",
  risk: "medium",
  callableImpact: "skill callable remains gated",
  rollbackRef: "snapshot-1",
  mutationApplied: false,
  approvalRequired: true,
  runtimeProvenCallable: false,
  corruptionStatus: "clean",
  evidence: [{ refType: "run", refId: "eval-ready", hash: "abc123", metadata: { score: 0.82 } }],
  disabledReasons: {},
  actionStatuses: {
    validate: "ready",
    approve: "ready",
    reject: "ready",
    snooze: "ready",
    activate: "ready",
    promote: "ready",
  },
  latestActivation: {
    activationId: "activation-1",
    status: "approved",
    approvalId: "approval-1",
    preActivationSnapshot: { refId: "snapshot-1" },
  },
};

function setupResponses() {
  routeMocks.fetchAgents.mockResolvedValue({ items: [agent] });
  routeMocks.fetchImportedAgentCatalog.mockResolvedValue({
    workspaceId: "default",
    divisions: [],
    items: [
      {
        entryId: "imported-1",
        division: "engineering",
        state: "available",
        definition: {
          frontmatter: {
            name: "Imported reviewer",
            description: "Imported review specialist",
          },
        },
      },
    ],
  });
  routeMocks.createAgentProfile.mockResolvedValue({ ...agent, agentId: "agent-created", name: "Operator" });
  routeMocks.updateAgentProfile.mockResolvedValue({ ...agent, name: "Architect Updated" });
  routeMocks.archiveAgentProfile.mockResolvedValue({ ...agent, lifecycleStatus: "archived" });
  routeMocks.restoreAgentProfile.mockResolvedValue({ ...agent, lifecycleStatus: "active" });
  routeMocks.fetchOperators.mockResolvedValue({
    items: [
      {
        operatorId: "operator-1",
        sessionCount: 4,
        activeSessions: 2,
        lastActivityAt: "2026-05-02T00:00:00.000Z",
      },
    ],
  });
  routeMocks.fetchAgenticRuns.mockResolvedValue({ items: [] });
  routeMocks.fetchTasksByView.mockImplementation(async (view: string) => ({
    view,
    items:
      view === "trash"
        ? [
            {
              taskId: "task-deleted",
              title: "Deleted task",
              description: "Restore me",
              status: "blocked",
              priority: "urgent",
              deletedAt: "2026-05-01T00:00:00.000Z",
              assignedAgentId: "agent-1",
            },
          ]
        : [
            {
              taskId: "task-planning",
              title: "Plan coverage",
              description: "Plan the remaining coverage work.",
              status: "planning",
              priority: "normal",
              assignedAgentId: "agent-1",
            },
            {
              taskId: "task-active",
              title: "Run tests",
              description: "Run the coverage lane.",
              status: "in_progress",
              priority: "high",
            },
            {
              taskId: "task-review",
              title: "Review gates",
              description: "Review failing gates.",
              status: "review",
              priority: "urgent",
            },
            {
              taskId: "task-done",
              title: "Storage tail",
              description: "",
              status: "done",
              priority: "low",
            },
          ],
  }));
  routeMocks.createTask.mockResolvedValue({
    taskId: "task-created",
    title: "Created task",
    description: "Created from test.",
    status: "planning",
    priority: "high",
  });
  routeMocks.updateTask.mockResolvedValue({ taskId: "task-planning", title: "Updated task" });
  routeMocks.deleteTask.mockResolvedValue({ taskId: "task-planning", deletedAt: "2026-05-02T00:00:00.000Z" });
  routeMocks.restoreTask.mockResolvedValue({ taskId: "task-deleted", deletedAt: null });
  routeMocks.fetchTaskDeliverables.mockResolvedValue({
    items: [
      {
        deliverableId: "deliverable-1",
        taskId: "task-planning",
        title: "Coverage proof",
        deliverableType: "artifact",
        path: "artifacts/coverage.md",
        description: "Coverage proof",
      },
    ],
  });
  routeMocks.addTaskDeliverable.mockResolvedValue({ deliverableId: "deliverable-2" });
  routeMocks.fetchSkills.mockResolvedValue({ items: [skill] });
  routeMocks.fetchSkillSources.mockResolvedValue({
    generatedAt: "2026-05-02T00:00:00.000Z",
    providers: ["local"],
    items: [
      {
        sourceUrl: "local://skills/review",
        name: "Review skill",
        description: "Review source",
        sourceProvider: "local",
        installability: "installable",
      },
    ],
  });
  routeMocks.fetchSkillImportHistory.mockResolvedValue({
    items: [
      {
        importId: "import-1",
        sourceRef: "local://skills/review",
        sourceProvider: "local",
        action: "install",
        outcome: "success",
        createdAt: "2026-05-02T00:00:00.000Z",
      },
    ],
  });
  routeMocks.fetchSkillActivationPolicies.mockResolvedValue({
    policies: [],
    guardedAutoThreshold: 0.9,
    requireFirstUseConfirmation: true,
  });
  routeMocks.fetchSkillEvaluations.mockResolvedValue({ items: [evaluationRun] });
  routeMocks.reloadSkills.mockResolvedValue({ reloaded: true });
  routeMocks.updateSkillState.mockResolvedValue({ updated: true });
  routeMocks.previewSkillEvaluation.mockResolvedValue({
    run: {
      ...evaluationRunWithoutProposal,
      runId: "preview-1",
      status: "previewed",
    },
  });
  routeMocks.runSkillEvaluation.mockResolvedValue({
    run: {
      ...evaluationRunWithoutProposal,
      runId: "run-2",
      status: "completed",
    },
  });
  routeMocks.createSkillEvaluationProposal.mockResolvedValue({
    run: { ...evaluationRun, proposalId: "proposal-2" },
    proposal: {
      proposalId: "proposal-2",
      candidateId: "candidate-1",
      status: "draft",
      title: "Evidence proposal",
      summary: "Tighten evidence handling.",
      activationTargetId: "skill-1",
      payload: { observedIssue: "Weak evidence", proposedChange: "Add evidence checks" },
    },
  });
  routeMocks.fetchCapabilityProposal.mockResolvedValue({
    proposal: {
      proposalId: "proposal-1",
      candidateId: "candidate-1",
      status: "draft",
      title: "Evidence proposal",
      summary: "Tighten evidence handling.",
      activationTargetId: "skill-1",
      payload: {
        observedIssue: "Weak evidence",
        proposedChange: "Add evidence checks",
        risk: "medium",
        evidenceRefs: [{ refType: "run", refId: "eval-ready", metadata: { score: 0.82 } }],
      },
    },
    events: [],
    candidate: undefined,
  });
  routeMocks.fetchCuratorReviewItem.mockResolvedValue(curatorReview);
  for (const action of [
    routeMocks.validateImprovementCandidate,
    routeMocks.approveImprovementCandidate,
    routeMocks.rejectImprovementCandidate,
    routeMocks.snoozeImprovementCandidate,
    routeMocks.activateImprovementCandidate,
    routeMocks.promoteImprovementCandidate,
  ]) {
    action.mockResolvedValue({ review: curatorReview, mutationApplied: true });
  }
  routeMocks.fetchCapabilityCatalog.mockImplementation(async (scope: string) => ({
    scope,
    items:
      scope === "callable"
        ? [
            {
              capabilityId: "tool-shell",
              title: "Shell tool",
              kind: "tool",
              category: "filesystem",
              summary: "Runs approved commands.",
              callable: true,
              toolName: "shell.run",
              trustLabel: "trusted",
              lifecycleState: "active",
              declaredTools: [],
              requires: [],
            },
          ]
        : [
            {
              capabilityId: "proposal-1",
              title: "Review proposal",
              kind: "proposal",
              category: "skills",
              summary: "Candidate skill revision awaiting review.",
              callable: false,
              proposalId: "proposal-1",
              candidateId: "candidate-1",
              lifecycleState: "active",
              reviewWarning: "Needs operator review.",
              declaredTools: ["shell"],
              requires: ["approval"],
            },
            {
              capabilityId: "provider-openai",
              title: "OpenAI provider",
              kind: "provider",
              category: "llm",
              summary: "Configured provider lane.",
              callable: false,
              sourceProvider: "openai",
              lifecycleState: "active",
              declaredTools: [],
              requires: [],
            },
          ],
  }));
  routeMocks.fetchMemoryFiles.mockResolvedValue({
    items: [{ relativePath: "memory/workspace.md", size: 512, modifiedAt: "2026-05-01T00:00:00.000Z" }],
  });
  routeMocks.fetchMemoryQmdStats.mockResolvedValue({
    totalRuns: 2,
    generatedRuns: 2,
    cacheHitRuns: 1,
    fallbackRuns: 0,
    compressionPercent: 45,
    efficiencyLabel: "reduced",
    recent: [
      {
        contextId: "ctx-1",
        scope: "chat",
        contextText: "Distilled context.",
        quality: { status: "ok" },
        citations: [{ sourceId: "src-1" }],
      },
    ],
  });
  routeMocks.fetchFilesList.mockResolvedValue({
    items: [{ relativePath: "docs/brief.md", size: 1024, modifiedAt: "2026-05-01T00:00:00.000Z" }],
  });
  routeMocks.fetchFileTemplates.mockResolvedValue({
    items: [
      {
        templateId: "brief",
        title: "Mission brief",
        description: "Create a mission brief",
        defaultPath: "docs/mission-brief.md",
      },
    ],
  });
  routeMocks.downloadFile.mockResolvedValue({ content: "# Mission brief\nEvidence.", contentType: "text/markdown" });
  routeMocks.createFileFromTemplate.mockResolvedValue({ relativePath: "docs/new-brief.md" });
  routeMocks.fetchChatGeneratedArtifacts.mockResolvedValue({
    items: [
      {
        artifactId: "artifact-1",
        title: "Release notes",
        kind: "markdown",
        sourceSurface: "cowork",
        content: "# Release\nProof.",
        version: 2,
        providerId: "openai",
        model: "gpt-5",
        sessionId: "session-1",
        turnId: "turn-1",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ],
  });
}

function renderRoute(area: string, section?: string, extras: Record<string, unknown> = {}) {
  return create(
    <NativeRoutePages
      route={{ area, section, theme: "ops" } as any}
      activeCitadelId="company"
      activeCitadelName="Company"
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={1}
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
      {...extras}
    />,
  );
}

async function mount(area: string, section?: string, extras: Record<string, unknown> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderRoute(area, section, extras);
  });
  await flush();
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child as ReactTestInstance);
    })
    .join(" ");
}

function findButton(root: ReactTestInstance, label: string) {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Missing button ${label}`);
  }
  return button;
}

function exactButton(root: ReactTestInstance, label: string) {
  const button = root.findAll((node) => node.type === "button" && collectText(node).trim() === label)[0];
  if (!button) {
    throw new Error(`Missing exact button ${label}`);
  }
  return button;
}

function field(root: ReactTestInstance, label: string, control: "input" | "textarea" | "select") {
  return fieldAt(root, label, control, 0);
}

function fieldAt(root: ReactTestInstance, label: string, control: "input" | "textarea" | "select", index: number) {
  const wrapper = root.findAll((node) => node.type === "label" && collectText(node).includes(label))[index];
  if (!wrapper) {
    throw new Error(`Missing field ${label} at index ${index}`);
  }
  return wrapper.findByType(control);
}

async function click(button: ReactTestInstance) {
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

async function change(node: ReactTestInstance, value: string) {
  await act(async () => {
    node.props.onChange({ target: { value } });
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  setupResponses();
});

describe("NativeRoutePages library coverage", () => {
  it("normalizes capability proposal payload helpers defensively", () => {
    const payload = {
      observedIssue: "  Repeated model fallback  ",
      nested: { score: 0.82, empty: "   " },
      evidenceRefs: [
        {
          refType: "skill_evaluation_run",
          refId: "eval-1",
          hash: "abc123",
          metadata: { passRate: 0.82 },
        },
        { refType: "memory_item" },
        ["bad"],
        null,
      ],
    };

    expect(readPayloadString(payload, ["nested.empty", "observedIssue"])).toBe("Repeated model fallback");
    expect(readPayloadString(payload, ["nested.score"])).toBe("0.82");
    expect(readPayloadString(payload, ["missing", "nested.empty"])).toBeUndefined();
    expect(readPayloadString(null, ["observedIssue"])).toBeUndefined();
    expect(readPayloadPath(payload, "nested.score")).toBe(0.82);
    expect(readPayloadPath(null, "nested.score")).toBeUndefined();
    expect(readPayloadPath(["bad"], "nested.score")).toBeUndefined();
    expect(readPayloadPath({ nested: [] }, "nested.score")).toBeUndefined();
    expect(readPayloadEvidenceRefs(payload)).toEqual([
      {
        refType: "skill_evaluation_run",
        refId: "eval-1",
        hash: "abc123",
        metadata: { passRate: 0.82 },
      },
    ]);
    expect(readPayloadEvidenceRefs({ evidenceRefs: "bad" })).toEqual([]);
    expect(readPayloadEvidenceRefs({ evidenceRefs: [{ refType: "run", refId: "eval-2", metadata: [] }] })).toEqual([
      { refType: "run", refId: "eval-2", hash: undefined, metadata: undefined },
    ]);
    expect(getErrorMessage(new Error("Gateway offline"))).toBe("Gateway offline");
    expect(getErrorMessage(new Error(""))).toBe("Something went wrong.");
    expect(getErrorMessage("plain failure")).toBe("plain failure");
    expect(getErrorMessage({ message: "Provider rejected", code: "AUTH_FAILED" })).toBe(
      "Provider rejected (AUTH_FAILED)",
    );
    expect(getErrorMessage({ code: "RATE_LIMITED" })).toBe("Request failed (RATE_LIMITED)");
    expect(getErrorMessage({ reason: "hidden" })).toBe("Something went wrong.");
  });

  it("covers agent profile maintenance and route dispatch fallbacks", async () => {
    const navigate = vi.fn();
    const agents = await mount("library", "agents", { navigate });
    expect(collectText(agents.root)).toContain("Agent profiles");
    await click(findButton(agents.root, "Architect"));
    await click(findButton(agents.root, "Refresh"));
    await change(field(agents.root, "Specialties", "input"), "architecture, test coverage");
    await change(field(agents.root, "Aliases", "input"), "design, review");
    await change(field(agents.root, "Default tools", "input"), "browser.search, shell.run");
    await click(findButton(agents.root, "Save changes"));
    expect(routeMocks.updateAgentProfile).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        name: "Architect",
        specialties: ["architecture", "test coverage"],
        aliases: ["design", "review"],
        defaultTools: ["browser.search", "shell.run"],
      }),
    );
    await click(findButton(agents.root, "Archive"));
    expect(routeMocks.archiveAgentProfile).toHaveBeenCalledWith("agent-1");
    await click(findButton(agents.root, "New profile"));
    await change(field(agents.root, "Role ID", "input"), "operator");
    await change(field(agents.root, "Name", "input"), "Operator");
    await change(field(agents.root, "Title", "input"), "Mission operator");
    await change(field(agents.root, "Summary", "textarea"), "Coordinates missions.");
    await click(findButton(agents.root, "Create agent"));
    expect(routeMocks.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: "operator", name: "Operator" }),
    );
    await click(findButton(agents.root, "Skills"));
    expect(navigate).toHaveBeenCalledWith({ area: "library", section: "skills", theme: "ops" });

    expect(collectText((await mount("ops", "approvals")).root)).toContain("Approvals child route");
    expect(collectText((await mount("ops", "runtime")).root)).toContain("Runtime child route");
    expect(collectText((await mount("projects", "alpha")).root)).toContain("Projects child route");
    expect(collectText((await mount("settings", "general")).root)).toContain("Settings child route");
    const memoryText = collectText((await mount("library", "memory")).root);
    expect(memoryText).toContain("Memory child route");
    expect(memoryText).not.toContain("Durable memory posture");
    const curatorText = collectText((await mount("library", "curator")).root);
    expect(curatorText).toContain("Curator child route");
    expect(curatorText).not.toContain("Agents");
  });

  it("covers skills, capability browsing, knowledge, files, and artifacts", async () => {
    const skills = await mount("library", "skills");
    expect(collectText(skills.root)).toContain("Installed skills");
    expect(collectText(skills.root)).toContain("Validation lane");
    expect(collectText(skills.root)).toContain("Proposal review");
    await click(findButton(skills.root, "Reload skills"));
    await click(exactButton(skills.root, "Enable"));
    await click(exactButton(skills.root, "Sleep"));
    await click(exactButton(skills.root, "Disable"));
    expect(routeMocks.reloadSkills).toHaveBeenCalledTimes(1);
    expect(routeMocks.updateSkillState).toHaveBeenCalledWith("skill-1", { state: "enabled" });
    expect(routeMocks.updateSkillState).toHaveBeenCalledWith("skill-1", { state: "sleep" });
    expect(routeMocks.updateSkillState).toHaveBeenCalledWith("skill-1", { state: "disabled" });

    const capabilities = await mount("library", "capabilities");
    expect(collectText(capabilities.root)).toContain("Capability browser");
    expect(collectText(capabilities.root)).toContain("can inspect or use when callable");
    expect(collectText(capabilities.root)).toContain("Why this state");
    expect(collectText(capabilities.root)).toContain("Activation path");
    await click(findButton(capabilities.root, "Degraded"));
    expect(collectText(capabilities.root)).toContain("Review proposal");
    await click(findButton(capabilities.root, "Review proposal"));
    expect(collectText(capabilities.root)).toContain("Needs operator review.");
    await click(findButton(capabilities.root, "Available"));
    expect(collectText(capabilities.root)).toContain("Shell tool");
    await click(findButton(capabilities.root, "Refresh catalog"));
    expect(routeMocks.fetchCapabilityCatalog).toHaveBeenCalledWith("inspectable");

    const knowledge = await mount("library", "knowledge");
    await flush();
    expect(collectText(knowledge.root)).toContain("Knowledge sources");
    expect(collectText(knowledge.root)).toContain("Distilled context.");
    expect(collectText(knowledge.root)).toContain("Ingestion health");
    expect(collectText(knowledge.root)).toContain("Retrieval test");
    expect(routeMocks.downloadFile).toHaveBeenCalledWith("memory/workspace.md");
    await change(knowledge.root.findByProps({ placeholder: "Search the knowledge file list" }), "workspace");
    expect(collectText(knowledge.root)).toContain("memory/workspace.md");

    const files = await mount("library", "files");
    await flush();
    expect(collectText(files.root)).toContain("Workspace files");
    expect(collectText(files.root)).toContain("Import / upload");
    expect(collectText(files.root)).toContain("Link to project");
    await change(files.root.findByProps({ placeholder: "Search relative path" }), "brief");
    expect(collectText(files.root)).toContain("docs/brief.md");
    await change(field(files.root, "Template", "select"), "brief");
    await change(files.root.findByProps({ placeholder: "Optional target path override" }), "docs/new-brief.md");
    await click(findButton(files.root, "Create file"));
    expect(routeMocks.createFileFromTemplate).toHaveBeenCalledWith("brief", "docs/new-brief.md", {
      citadelId: "company",
      workspaceId: "default",
    });

    const artifacts = await mount("library", "artifacts");
    expect(collectText(artifacts.root)).toContain("Generated artifacts");
    expect(collectText(artifacts.root)).toContain("Release notes");
    expect(collectText(artifacts.root)).toContain("Use in Work");
    expect(collectText(artifacts.root)).toContain("Validation");
    await click(findButton(artifacts.root, "Plan"));
    await change(artifacts.root.findByProps({ placeholder: "Search title or kind" }), "release");
    expect(collectText(artifacts.root)).toContain("# Release");
    await click(findButton(artifacts.root, "Refresh"));
    expect(routeMocks.fetchChatGeneratedArtifacts).toHaveBeenCalledWith({
      citadelId: "company",
      workspaceId: "default",
      limit: 80,
    });
  });

  it("covers Cowork task creation, editing, deliverables, trash restore, and board lanes", async () => {
    const navigate = vi.fn();
    const cowork = await mount("cowork", undefined, { navigate });
    expect(collectText(cowork.root)).toContain("Task board");
    expect(collectText(cowork.root)).toContain("Plan coverage");
    expect(collectText(cowork.root)).toContain("Execution at a glance");
    expect(collectText(cowork.root)).toContain("Phase timeline");
    expect(collectText(cowork.root)).toContain("Next checkpoint");

    routeMocks.fetchTasksByView.mockClear();
    await click(findButton(cowork.root, "Refresh"));
    expect(routeMocks.fetchTasksByView).toHaveBeenCalledWith("active", undefined, "default", {
      citadelId: "company",
      cursor: undefined,
      limit: 100,
    });
    expect(routeMocks.fetchTasksByView).toHaveBeenCalledWith("trash", undefined, "default", {
      citadelId: "company",
      cursor: undefined,
      limit: 100,
    });

    await click(findButton(cowork.root, "Create task"));
    expect(collectText(cowork.root)).toContain("Task title is required.");

    await change(cowork.root.findByProps({ placeholder: "Write release notes" }), "Created task");
    await change(field(cowork.root, "Description", "textarea"), "Created from the native task board.");
    await change(field(cowork.root, "Priority", "select"), "high");
    await click(findButton(cowork.root, "Create task"));
    expect(routeMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        citadelId: "company",
        workspaceId: "default",
        title: "Created task",
        priority: "high",
      }),
    );

    await change(field(cowork.root, "Title", "input"), "Plan coverage updated");
    await change(field(cowork.root, "Status", "select"), "testing");
    await change(fieldAt(cowork.root, "Priority", "select", 1), "urgent");
    await change(fieldAt(cowork.root, "Description", "textarea", 1), "Updated coverage plan.");
    await click(findButton(cowork.root, "Save task"));
    expect(routeMocks.updateTask).toHaveBeenCalledWith(
      "task-planning",
      expect.objectContaining({
        citadelId: "company",
        title: "Plan coverage updated",
        description: "Updated coverage plan.",
        status: "testing",
        priority: "urgent",
      }),
    );

    await click(findButton(cowork.root, "Add deliverable"));
    expect(collectText(cowork.root)).toContain("Deliverable title is required.");
    await change(field(cowork.root, "Deliverable title", "input"), "Coverage report");
    await change(field(cowork.root, "Type", "select"), "file");
    await change(field(cowork.root, "Path or link", "input"), "artifacts/coverage.md");
    await click(findButton(cowork.root, "Add deliverable"));
    expect(routeMocks.addTaskDeliverable).toHaveBeenCalledWith(
      "task-planning",
      expect.objectContaining({
        citadelId: "company",
        title: "Coverage report",
        deliverableType: "file",
        path: "artifacts/coverage.md",
      }),
    );

    await click(findButton(cowork.root, "Move to trash"));
    expect(routeMocks.deleteTask).toHaveBeenCalledWith("task-planning", {
      citadelId: "company",
      mode: "soft",
      deletedBy: "operator",
      workspaceId: "default",
    });

    await click(findButton(cowork.root, "Open approvals"));
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "approvals", theme: "ops" });

    routeMocks.restoreTask.mockClear();
    routeMocks.fetchTasksByView.mockImplementation(async (view: string) => ({
      view,
      items:
        view === "trash"
          ? [
              {
                taskId: "task-deleted",
                title: "Deleted task",
                description: "Restore me",
                status: "blocked",
                priority: "urgent",
                deletedAt: "2026-05-01T00:00:00.000Z",
              },
            ]
          : [],
    }));
    const trashOnly = await mount("cowork");
    await click(exactButton(trashOnly.root, "Restore"));
    expect(routeMocks.restoreTask).toHaveBeenCalledWith("task-deleted", "default", "company");

    setupResponses();
    const board = await mount("cowork", "board");
    expect(collectText(board.root)).toContain("Agent Board");
    expect(collectText(board.root)).toContain("operator-1");
    await click(findButton(board.root, "Review gates"));
    expect(collectText(board.root)).toContain("Review gates");
  });

  it("covers skill evaluation proposal creation, review, and lifecycle actions", async () => {
    routeMocks.fetchSkillEvaluations.mockResolvedValue({ items: [evaluationRunWithoutProposal] });
    const skills = await mount("library", "skills");
    expect(collectText(skills.root)).toContain("Safe improvement");

    await click(findButton(skills.root, "Generate scenarios"));
    expect(routeMocks.previewSkillEvaluation).toHaveBeenCalledWith("skill-1");

    await change(field(skills.root, "Scenarios", "textarea"), "Traceability | Prove the source | Evidence is cited");
    await change(field(skills.root, "Criteria", "textarea"), "Grounded | Uses citations | evidence, source");
    await click(findButton(skills.root, "Run baseline"));
    expect(routeMocks.previewSkillEvaluation).toHaveBeenCalledWith(
      "skill-1",
      expect.objectContaining({
        scenarios: [{ title: "Traceability", prompt: "Prove the source", expectedOutcome: "Evidence is cited" }],
        criteria: [{ label: "Grounded", description: "Uses citations", requiredTerms: ["evidence", "source"] }],
      }),
    );

    await click(findButton(skills.root, "Run improvement"));
    expect(routeMocks.runSkillEvaluation).toHaveBeenCalledWith(
      "skill-1",
      expect.objectContaining({ scenarios: expect.any(Array), criteria: expect.any(Array) }),
    );

    await click(findButton(skills.root, "Create proposal"));
    expect(routeMocks.createSkillEvaluationProposal).toHaveBeenCalledWith("eval-ready");

    routeMocks.fetchSkillEvaluations.mockResolvedValue({ items: [evaluationRun] });
    const skillsWithProposal = await mount("library", "skills");
    await click(findButton(skillsWithProposal.root, "Open proposal"));
    expect(routeMocks.fetchCapabilityProposal).toHaveBeenCalledWith("proposal-1");
    await click(findButton(skillsWithProposal.root, "Trust review"));
    expect(routeMocks.fetchCuratorReviewItem).toHaveBeenCalledWith("candidate-1");
    expect(collectText(skillsWithProposal.root)).toContain("Evidence handling was too weak.");

    await click(exactButton(skillsWithProposal.root, "Validate"));
    await click(exactButton(skillsWithProposal.root, "Approve"));
    await click(exactButton(skillsWithProposal.root, "Reject"));
    await click(exactButton(skillsWithProposal.root, "Snooze"));
    await click(exactButton(skillsWithProposal.root, "Activate"));
    await click(exactButton(skillsWithProposal.root, "Promote"));

    expect(routeMocks.validateImprovementCandidate).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ reason: expect.stringContaining("validate") }),
    );
    expect(routeMocks.approveImprovementCandidate).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ reason: expect.stringContaining("approve") }),
    );
    expect(routeMocks.rejectImprovementCandidate).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ reason: expect.stringContaining("reject") }),
    );
    expect(routeMocks.snoozeImprovementCandidate).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ snoozeUntil: expect.any(String) }),
    );
    expect(routeMocks.activateImprovementCandidate).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ reason: expect.stringContaining("activate") }),
    );
    expect(routeMocks.promoteImprovementCandidate).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ reason: expect.stringContaining("promote") }),
    );

    setupResponses();
    routeMocks.fetchSkillEvaluations.mockResolvedValue({ items: [evaluationRunWithoutProposal, evaluationRun] });
    const skillsWithStoredRun = await mount("library", "skills");
    await click(exactButton(skillsWithStoredRun.root, "Open"));
    expect(collectText(skillsWithStoredRun.root)).toContain("proposal_created");
  });

  it("surfaces action failures and proposal payload fallbacks without mutating hidden state", async () => {
    routeMocks.fetchTaskDeliverables.mockRejectedValueOnce(new Error("deliverables offline"));
    routeMocks.updateTask.mockRejectedValueOnce(new Error("task save failed"));
    routeMocks.addTaskDeliverable.mockRejectedValueOnce(new Error("deliverable add failed"));
    routeMocks.deleteTask.mockRejectedValueOnce(new Error("task delete failed"));

    const cowork = await mount("cowork");
    expect(collectText(cowork.root)).toContain("deliverables offline");
    await click(findButton(cowork.root, "Save task"));
    expect(collectText(cowork.root)).toContain("task save failed");
    await change(field(cowork.root, "Deliverable title", "input"), "Failed deliverable");
    await click(findButton(cowork.root, "Add deliverable"));
    expect(collectText(cowork.root)).toContain("deliverable add failed");
    await click(findButton(cowork.root, "Move to trash"));
    expect(collectText(cowork.root)).toContain("task delete failed");

    setupResponses();
    routeMocks.fetchAgents.mockResolvedValueOnce({ items: [{ ...agent, lifecycleStatus: "archived" }] });
    routeMocks.restoreAgentProfile.mockRejectedValueOnce(new Error("restore failed"));
    const agents = await mount("library", "agents");
    await click(findButton(agents.root, "Restore"));
    expect(collectText(agents.root)).toContain("restore failed");

    setupResponses();
    routeMocks.reloadSkills.mockRejectedValueOnce(new Error("reload failed"));
    routeMocks.updateSkillState.mockRejectedValueOnce(new Error("state failed"));
    routeMocks.fetchSkillEvaluations.mockRejectedValueOnce(new Error("runs offline"));
    const skillsWithFailures = await mount("library", "skills");
    expect(collectText(skillsWithFailures.root)).toContain("runs offline");
    await click(findButton(skillsWithFailures.root, "Reload skills"));
    expect(collectText(skillsWithFailures.root)).toContain("reload failed");
    await click(exactButton(skillsWithFailures.root, "Enable"));
    expect(collectText(skillsWithFailures.root)).toContain("state failed");

    setupResponses();
    routeMocks.fetchFilesList.mockRejectedValueOnce(new Error("files offline"));
    const filesWithWarning = await mount("library", "files");
    expect(collectText(filesWithWarning.root)).toContain("files offline");
    await click(findButton(filesWithWarning.root, "Retry"));
    expect(routeMocks.fetchFilesList).toHaveBeenCalledTimes(2);

    setupResponses();
    routeMocks.fetchSkillEvaluations.mockResolvedValue({
      items: [
        {
          ...evaluationRun,
          runId: "eval-payload",
          proposalId: "proposal-payload",
          improvementCandidateId: undefined,
        },
      ],
    });
    routeMocks.fetchCapabilityProposal.mockResolvedValue({
      proposal: {
        proposalId: "proposal-payload",
        candidateId: undefined,
        status: "draft",
        title: "Payload proposal",
        summary: "Payload summary",
        activationTargetId: "skill-1",
        payload: {
          observedIssue: "Payload issue",
          mutation: { summary: "Payload change" },
          risk: "low",
          callableImpact: "none",
          rollbackRef: "rollback-payload",
          evidenceRefs: [{ refType: "run", refId: "eval-payload", hash: "hash-payload" }],
        },
      },
      events: [{ eventId: "event-1" }],
      candidate: undefined,
    } as never);
    const proposalFallback = await mount("library", "skills");
    await click(findButton(proposalFallback.root, "Open proposal"));
    const proposalText = collectText(proposalFallback.root);
    expect(proposalText).toContain("Payload issue");
    expect(proposalText).toContain("Payload change");
    expect(proposalText).toContain("rollback-payload");
    expect(proposalText).toContain("Open the trust review to see action guards and lifecycle state.");
  });
});
