import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
}));

const uiState = vi.hoisted(() => ({
  mode: "advanced" as "default" | "advanced" | "beginner",
}));

const apiMocks = vi.hoisted(() => ({
  fetchCapabilityCandidate: vi.fn(),
  fetchCapabilityCatalog: vi.fn(),
  fetchCapabilityProposal: vi.fn(),
  fetchCapabilityProposals: vi.fn(),
  fetchHarnessAuditReport: vi.fn(),
  fetchSkillActivationPolicies: vi.fn(),
  fetchSkillImportHistory: vi.fn(),
  fetchSkillLookup: vi.fn(),
  fetchSkillSources: vi.fn(),
  fetchSkills: vi.fn(),
  installSkillImport: vi.fn(),
  patchSkillActivationPolicies: vi.fn(),
  promoteCapabilityCandidate: vi.fn(),
  reloadSkills: vi.fn(),
  revokeCapabilityCandidate: vi.fn(),
  rollbackCapabilityCandidate: vi.fn(),
  updateSkillState: vi.fn(),
  validateSkillImport: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchCapabilityCandidate: apiMocks.fetchCapabilityCandidate,
  fetchCapabilityCatalog: apiMocks.fetchCapabilityCatalog,
  fetchCapabilityProposal: apiMocks.fetchCapabilityProposal,
  fetchCapabilityProposals: apiMocks.fetchCapabilityProposals,
  fetchHarnessAuditReport: apiMocks.fetchHarnessAuditReport,
  fetchSkillActivationPolicies: apiMocks.fetchSkillActivationPolicies,
  fetchSkillImportHistory: apiMocks.fetchSkillImportHistory,
  fetchSkillLookup: apiMocks.fetchSkillLookup,
  fetchSkillSources: apiMocks.fetchSkillSources,
  fetchSkills: apiMocks.fetchSkills,
  installSkillImport: apiMocks.installSkillImport,
  patchSkillActivationPolicies: apiMocks.patchSkillActivationPolicies,
  promoteCapabilityCandidate: apiMocks.promoteCapabilityCandidate,
  reloadSkills: apiMocks.reloadSkills,
  revokeCapabilityCandidate: apiMocks.revokeCapabilityCandidate,
  rollbackCapabilityCandidate: apiMocks.rollbackCapabilityCandidate,
  updateSkillState: apiMocks.updateSkillState,
  validateSkillImport: apiMocks.validateSkillImport,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: () => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../state/ui-preferences", () => ({
  useUiPreferences: () => ({ mode: uiState.mode }),
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({
    center,
    primary,
    secondary,
  }: {
    center?: React.ReactNode;
    primary?: React.ReactNode;
    secondary?: React.ReactNode;
  }) => (
    <div>
      {primary}
      {center}
      {secondary}
    </div>
  ),
}));
vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({
    inspector,
    primary,
    topbar,
  }: {
    inspector?: React.ReactNode;
    primary?: React.ReactNode;
    topbar?: React.ReactNode;
  }) => (
    <div>
      {topbar}
      {primary}
      {inspector}
    </div>
  ),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ actions, subtitle, title }: { actions?: React.ReactNode; subtitle?: string; title?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({
    children,
    subtitle,
    title,
  }: {
    children?: React.ReactNode;
    subtitle?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
    </section>
  ),
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ label }: { label?: string }) => <span>{label}</span>,
}));
vi.mock("../components/ui", () => ({
  GCSelect: ({
    id,
    onChange,
    options,
    value,
  }: {
    id?: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    value: string;
  }) => (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  GCSwitch: ({
    checked,
    label,
    onCheckedChange,
  }: {
    checked: boolean;
    label?: string;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <label>
      <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
      {label}
    </label>
  ),
}));
vi.mock("../components/ui/GCEmptyState", () => ({
  GCEmptyState: ({ subtitle, title }: { subtitle?: React.ReactNode; title?: React.ReactNode }) => (
    <section>
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </section>
  ),
}));
vi.mock("../content/copy", () => ({
  pageCopy: {
    skills: {
      title: "Skills",
      subtitle: "Govern reusable playbooks.",
    },
  },
}));

import { SkillsPage } from "./SkillsPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) =>
      typeof child === "string" ? child : child && typeof child === "object" ? nodeText(child as any) : "",
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function button(renderer: ReactTestRenderer, label: string, occurrence = 0) {
  const found = renderer.root
    .findAll((node) => node.type === "button" && nodeText(node).includes(label))
    .at(occurrence);
  if (!found) {
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

function control(renderer: ReactTestRenderer, id: string) {
  const found = renderer.root
    .findAll((node) => (node.type === "input" || node.type === "select") && node.props.id === id)
    .at(0);
  if (!found) {
    throw new Error(`Control not found: ${id}`);
  }
  return found;
}

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  await act(async () => {
    button(renderer, label, occurrence).props.onClick();
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

const candidateDetail = {
  candidateId: "candidate-1",
  activeVersion: null,
  activationBlocked: true,
  activationBlockers: ["Needs operator review."],
  originatingRun: {
    runId: "run-candidate",
    sandbox: { available: true },
  },
  versions: [
    {
      versionId: "version-1",
      title: "Browser Skill v1",
      lifecycleState: "candidate",
      updatedAt: "2026-05-14T00:00:00.000Z",
      proofArtifact: { relPath: "proof.md" },
      manifestArtifact: { relPath: "SKILL.md" },
      programArtifact: { relPath: "skill.ts" },
    },
  ],
  relatedProposals: [],
};

function installableSource() {
  return {
    canonicalKey: "clawhub:browser",
    name: "Browser Skill",
    description: "Browser automation",
    tags: ["browser", "mcp", "automation", "testing", "extra"],
    skillFamily: "browser_automation",
    sourceProvider: "clawhub",
    alternateProviders: ["github"],
    sourceKind: "marketplace",
    installability: "installable",
    alreadyInstalled: true,
    combinedScore: 0.91,
    matchReason: "browser match",
    sourceUrl: "https://example.test/browser",
    repositoryUrl: undefined,
    upstreamUrl: undefined,
  };
}

describe("SkillsPage loop 13 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    uiState.mode = "advanced";

    apiMocks.fetchSkills.mockResolvedValue({
      items: [
        {
          skillId: "skill-browser",
          name: "Browser Helper",
          source: "workspace",
          declaredTools: ["browser.search"],
          requires: [],
          tags: ["browser"],
          keywords: [],
          state: "disabled",
          note: "",
          trustLabel: "Reviewed",
          reviewWarning: "Needs review",
        },
        {
          skillId: "skill-writer",
          name: "Writer Helper",
          source: "workspace",
          declaredTools: [],
          requires: ["templates"],
          tags: ["writing"],
          keywords: [],
          state: "enabled",
          note: "Keep on",
        },
      ],
    });
    apiMocks.fetchSkillActivationPolicies.mockResolvedValue(null);
    apiMocks.fetchSkillImportHistory.mockResolvedValue({
      items: [
        {
          importId: "import-1",
          createdAt: "2026-05-14T00:00:00.000Z",
          action: "validate",
          outcome: "blocked",
          sourceProvider: "local",
          sourceRef: "F:\\skills\\blocked",
          riskLevel: null,
        },
      ],
    });
    apiMocks.fetchHarnessAuditReport.mockResolvedValue({
      generatedAt: "2026-05-14T00:00:00.000Z",
      summary: "Audit summary",
      overallScore: 61,
      overallStatus: "watch",
      strategyGlossary: [{ tag: "coverage" }],
      pillars: [
        {
          pillarId: "p1",
          label: "Activation",
          score: 40,
          status: "attention",
          nativeDestination: "Skills",
          rationale: "Needs attention",
        },
      ],
    });
    apiMocks.fetchCapabilityCatalog.mockResolvedValue({
      scope: "inspectable",
      items: [
        {
          capabilityId: "cap-candidate",
          kind: "candidate_skill",
          title: "Browser Candidate",
          candidateId: "candidate-1",
          lifecycleState: "candidate",
          trustLabel: "Candidate",
        },
      ],
    });
    apiMocks.fetchCapabilityProposals.mockResolvedValue({
      items: [
        {
          proposalId: "proposal-1",
          title: "Promote Browser Candidate",
          proposalKind: "activation",
          status: "pending",
          summary: "Promote it.",
          candidateId: "candidate-1",
        },
      ],
    });
    apiMocks.fetchSkillSources.mockResolvedValue({
      items: [installableSource()],
      providers: [
        { provider: "clawhub", providerLabel: "ClawHub", status: "degraded", available: false, error: "slow" },
      ],
    });
    apiMocks.fetchSkillLookup.mockResolvedValue({
      items: [installableSource()],
      providers: [{ provider: "clawhub", providerLabel: "ClawHub", status: "available", available: true }],
      bestMatch: undefined,
      parsedSource: { sourceProvider: "github", sourceKind: "git", installability: "installable" },
    });
    apiMocks.reloadSkills.mockResolvedValue({});
    apiMocks.updateSkillState.mockResolvedValue({});
    apiMocks.patchSkillActivationPolicies.mockResolvedValue({
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: false,
    });
    apiMocks.validateSkillImport.mockResolvedValue({
      valid: false,
      riskLevel: "high",
      reviewDisposition: "installable",
      reviewMessage: "Review before use.",
      inferredSkillName: "Blocked Skill",
      declaredTools: [],
      networkSignals: [],
      suspiciousSignals: ["exec"],
      requires: [],
      licenseFiles: [],
      nativeOverlaps: [
        {
          overlapFamily: "browser",
          nativeDestination: "Skills",
          nativeAlternativeName: "Native browser",
          blockingReason: "Use the native path.",
        },
      ],
    });
    apiMocks.installSkillImport.mockResolvedValue({
      installedSkillId: "",
      validation: {
        valid: true,
        riskLevel: "low",
        declaredTools: [],
        networkSignals: [],
        suspiciousSignals: [],
        requires: [],
        licenseFiles: [],
        nativeOverlaps: [],
      },
    });
    apiMocks.fetchCapabilityCandidate.mockResolvedValue(candidateDetail);
    apiMocks.fetchCapabilityProposal.mockResolvedValue({
      proposal: {
        proposalId: "proposal-1",
        title: "Promote Browser Candidate",
        proposalKind: "activation",
        status: "pending",
        summary: "Promote it.",
        candidateId: "candidate-1",
      },
      candidate: candidateDetail,
      events: [
        { eventId: "event-1", eventType: "created", actorId: "operator", createdAt: "2026-05-14T00:00:00.000Z" },
      ],
    });
    apiMocks.promoteCapabilityCandidate.mockResolvedValue({ detail: candidateDetail });
    apiMocks.rollbackCapabilityCandidate.mockResolvedValue({ detail: candidateDetail });
    apiMocks.revokeCapabilityCandidate.mockResolvedValue({ detail: candidateDetail });
  });

  it("surfaces initial load failures", async () => {
    apiMocks.fetchSkills.mockRejectedValueOnce(new Error("load failed"));
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SkillsPage />);
      });
      await flush();

      expect(text(renderer)).toContain("load failed");
    } finally {
      renderer.unmount();
    }
  });

  it("covers empty filters, row keyboard selection, source/import blockers, policy fallback, and candidate actions", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SkillsPage />);
      });
      await flush();

      expect(text(renderer)).toContain("Skills");
      expect(text(renderer)).toContain("Audit summary");
      expect(text(renderer)).toContain("SKILL.md");

      await click(renderer, "Reload Playbook");
      expect(apiMocks.reloadSkills).toHaveBeenCalledTimes(1);
      expect(text(renderer)).toContain("Skills reloaded.");

      const row = renderer.root.findAll((node) => node.type === "tr" && node.props.role === "button").at(1);
      await act(async () => {
        row?.props.onClick();
      });
      await flush();
      expect(control(renderer, "selectedSkillNote").props.value).toBe("Keep on");

      const preventDefault = vi.fn();
      await act(async () => {
        row?.props.onKeyDown({ key: "Escape", preventDefault });
      });
      expect(preventDefault).not.toHaveBeenCalled();
      await act(async () => {
        row?.props.onKeyDown({ key: " ", preventDefault });
      });
      expect(preventDefault).toHaveBeenCalledTimes(1);

      await act(async () => {
        control(renderer, "skillsFilter").props.onChange({ target: { value: "sleep" } });
      });
      await flush();
      expect(text(renderer)).toContain("No installed skills match the current filter.");
      expect(text(renderer)).toContain("Select a skill");

      await act(async () => {
        control(renderer, "skillsFilter").props.onChange({ target: { value: "all" } });
      });
      await flush();

      await click(renderer, "Browse");
      expect(apiMocks.fetchSkillSources).toHaveBeenCalledWith({ limit: 25 });

      await act(async () => {
        control(renderer, "skillSourceQuery").props.onChange({ target: { value: "github source" } });
      });
      await click(renderer, "Lookup");
      expect(apiMocks.fetchSkillLookup).toHaveBeenCalledWith({ q: "github source", limit: 25 });
      expect(text(renderer)).toContain("Lookup:");

      await click(renderer, "Validate import");
      expect(text(renderer)).toContain("Provide a local path, zip file path, or git URL.");

      await click(renderer, "Install (disabled by default)");
      expect(text(renderer)).toContain("Provide a source before install.");

      await act(async () => {
        control(renderer, "importSourceType").props.onChange({ target: { value: "git_url" } });
        control(renderer, "importSourceProvider").props.onChange({ target: { value: "github" } });
        control(renderer, "importSourceRef").props.onChange({
          target: { value: "https://github.com/example/skill.git" },
        });
      });
      await click(renderer, "Validate import");
      expect(text(renderer)).toContain("Native alternative");

      await click(renderer, "Install (disabled by default)");
      expect(text(renderer)).toContain("blocked because it overlaps a native GoatCitadel capability family.");

      apiMocks.validateSkillImport.mockResolvedValueOnce({
        valid: true,
        riskLevel: "low",
        reviewDisposition: "reject",
        reviewMessage: "Rejected by policy.",
        declaredTools: [],
        networkSignals: [],
        suspiciousSignals: [],
        requires: [],
        licenseFiles: [],
        nativeOverlaps: [],
      });
      await click(renderer, "Validate import");
      await click(renderer, "Install (disabled by default)");
      expect(text(renderer)).toContain("Rejected by policy.");

      await act(async () => {
        control(renderer, "skillsThreshold").props.onChange({ target: { value: "not-a-number" } });
      });
      const confirmationSwitch = renderer.root
        .findAllByType("input")
        .filter((node) => node.props.type === "checkbox")
        .at(-1);
      await act(async () => {
        confirmationSwitch?.props.onChange({ target: { checked: false } });
      });
      await click(renderer, "Save policy");
      expect(apiMocks.patchSkillActivationPolicies).toHaveBeenCalledWith({
        guardedAutoThreshold: 0.72,
        requireFirstUseConfirmation: false,
      });

      await click(renderer, "Inspect");
      expect(apiMocks.fetchCapabilityCandidate).toHaveBeenCalledWith("candidate-1");
      expect(text(renderer)).toContain("No active version");
      await click(renderer, "Promote");
      await click(renderer, "Rollback");
      await click(renderer, "Revoke");
      expect(apiMocks.promoteCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-1");
      expect(apiMocks.rollbackCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-1");
      expect(apiMocks.revokeCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-1");

      const inspectButtons = renderer.root.findAllByType("button").filter((node) => nodeText(node).includes("Inspect"));
      await act(async () => {
        inspectButtons.at(1)?.props.onClick();
      });
      await flush();
      expect(apiMocks.fetchCapabilityProposal).toHaveBeenCalledWith("proposal-1");
      expect(text(renderer)).toContain("Proposal detail");

      const policyFetchesBeforeRefresh = apiMocks.fetchSkillActivationPolicies.mock.calls.length;
      await act(async () => {
        await refreshState.callback?.();
      });
      await flush();
      expect(apiMocks.fetchSkillActivationPolicies).toHaveBeenCalledTimes(policyFetchesBeforeRefresh);
    } finally {
      renderer.unmount();
    }
  });
});
