import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
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
  promoteCapabilityCandidate: vi.fn(),
  patchSkillActivationPolicies: vi.fn(),
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
  promoteCapabilityCandidate: apiMocks.promoteCapabilityCandidate,
  patchSkillActivationPolicies: apiMocks.patchSkillActivationPolicies,
  reloadSkills: apiMocks.reloadSkills,
  revokeCapabilityCandidate: apiMocks.revokeCapabilityCandidate,
  rollbackCapabilityCandidate: apiMocks.rollbackCapabilityCandidate,
  updateSkillState: apiMocks.updateSkillState,
  validateSkillImport: apiMocks.validateSkillImport,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../state/ui-preferences", () => ({
  useUiPreferences: () => ({
    mode: "default",
  }),
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
  ),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: () => <span>HelpHint</span>,
}));

vi.mock("../components/ui", () => ({
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  GCSwitch: (props: { checked: boolean; onCheckedChange: (checked: boolean) => void; label?: string }) => (
    <label>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onCheckedChange(event.target.checked)}
      />
      {props.label}
    </label>
  ),
}));

import { SkillsPage } from "./SkillsPage";

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function control(renderer: ReactTestRenderer, id: string) {
  const node = renderer.root
    .findAll(
      (candidate) =>
        (candidate.type === "input" || candidate.type === "select" || candidate.type === "textarea") &&
        candidate.props.id === id,
    )
    .at(0);
  if (!node) {
    throw new Error(`Unable to find control ${id}`);
  }
  return node;
}

function button(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root.findAllByType("button").find((candidate) => candidate.props.children === label);
  if (!node) {
    throw new Error(`Unable to find button ${label}`);
  }
  return node;
}

describe("SkillsPage refresh discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchSkills.mockResolvedValue({
      items: [
        {
          skillId: "skill-1",
          name: "Browser Helper",
          source: "workspace",
          declaredTools: [],
          requires: [],
          tags: [],
          keywords: [],
          state: "disabled",
          note: "",
        },
      ],
    });
    apiMocks.fetchCapabilityCatalog.mockResolvedValue({
      scope: "inspectable",
      items: [],
    });
    apiMocks.fetchCapabilityProposals.mockResolvedValue({
      items: [],
    });
    apiMocks.fetchSkillActivationPolicies.mockResolvedValue({
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: true,
    });
    apiMocks.fetchSkillImportHistory.mockResolvedValue({ items: [] });
    apiMocks.fetchHarnessAuditReport.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      summary: "Harness audit summary",
      overallScore: 82,
      overallStatus: "strong",
      pillars: [],
      strategyGlossary: [],
    });
    apiMocks.fetchSkillSources.mockResolvedValue({
      items: [],
      providers: [],
    });
    apiMocks.fetchSkillLookup.mockResolvedValue({
      items: [],
      providers: [],
      bestMatch: undefined,
      parsedSource: undefined,
    });
  });

  it("skips static policy/history fetches during background refresh and preserves dirty drafts", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SkillsPage />);
      });
      await flush();

      const noteInput = renderer.root.findByProps({ placeholder: "Optional reason" });
      await act(async () => {
        noteInput.props.onChange({ target: { value: "Keep this local note" } });
      });

      expect(apiMocks.fetchSkills).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSkillActivationPolicies).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSkillImportHistory).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "skills",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchSkills).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchSkillActivationPolicies).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSkillImportHistory).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByProps({ placeholder: "Optional reason" }).props.value).toBe("Keep this local note");
    } finally {
      renderer.unmount();
    }
  });

  it("saves visible skill and policy forms, imports a source, and inspects review entries", async () => {
    apiMocks.fetchCapabilityCatalog.mockResolvedValue({
      scope: "inspectable",
      items: [
        {
          capabilityId: "cap-browser",
          kind: "candidate_skill",
          title: "Browser Skill",
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
          title: "Promote Browser Skill",
          proposalKind: "activation",
          status: "pending",
          summary: "Promote the browser skill.",
          candidateId: "candidate-1",
        },
      ],
    });
    const sourceResult = {
      canonicalKey: "clawhub:browser",
      name: "Browser Skill",
      description: "Browser automation",
      tags: ["browser"],
      skillFamily: "browser_automation",
      sourceProvider: "clawhub",
      alternateProviders: [],
      sourceKind: "marketplace",
      installability: "installable",
      alreadyInstalled: false,
      combinedScore: 0.91,
      matchReason: "browser match",
      sourceUrl: "https://example.test/browser",
      repositoryUrl: undefined,
      upstreamUrl: undefined,
    };
    apiMocks.fetchSkillLookup.mockResolvedValue({
      items: [sourceResult],
      providers: [{ provider: "clawhub", providerLabel: "ClawHub", status: "available", available: true }],
      bestMatch: sourceResult,
      parsedSource: undefined,
    });
    const validation = {
      valid: true,
      riskLevel: "low",
      reviewDisposition: "installable",
      inferredSkillName: "Browser Skill",
      declaredTools: ["browser.search"],
      networkSignals: [],
      suspiciousSignals: [],
      requires: [],
      licenseFiles: ["LICENSE"],
      nativeOverlaps: [],
    };
    apiMocks.validateSkillImport.mockResolvedValue(validation);
    apiMocks.installSkillImport.mockResolvedValue({
      installedSkillId: "skill-browser",
      validation,
    });
    apiMocks.fetchCapabilityCandidate.mockResolvedValue({
      candidateId: "candidate-1",
      activeVersion: { versionId: "version-1" },
      versions: [
        {
          versionId: "version-1",
          title: "Browser Skill v1",
          lifecycleState: "candidate",
          updatedAt: "2026-05-14T00:00:00.000Z",
          proofArtifact: { relPath: "proof.md" },
          manifestArtifact: { relPath: "SKILL.md" },
        },
      ],
      relatedProposals: [{ proposalId: "proposal-1", title: "Promote Browser Skill", status: "pending" }],
      activationBlocked: false,
      activationBlockers: [],
      originatingRun: {
        runId: "run-1",
        sandbox: { available: false, failClosedReason: "sandbox unavailable" },
      },
    });
    apiMocks.fetchCapabilityProposal.mockResolvedValue({
      proposal: {
        proposalId: "proposal-1",
        title: "Promote Browser Skill",
        proposalKind: "activation",
        status: "pending",
        summary: "Promote the browser skill.",
        candidateId: "candidate-1",
      },
      candidate: null,
      events: [
        { eventId: "event-1", eventType: "created", actorId: "operator", createdAt: "2026-05-14T00:00:00.000Z" },
      ],
    });
    apiMocks.updateSkillState.mockResolvedValue({});
    apiMocks.patchSkillActivationPolicies.mockResolvedValue({
      guardedAutoThreshold: 0.9,
      requireFirstUseConfirmation: true,
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SkillsPage />);
      });
      await flush();

      await act(async () => {
        control(renderer, "selectedSkillState").props.onChange({ target: { value: "sleep" } });
        control(renderer, "selectedSkillNote").props.onChange({ target: { value: "Needs guarded activation" } });
      });
      await act(async () => {
        button(renderer, "Save").props.onClick();
      });
      await flush();

      expect(apiMocks.updateSkillState).toHaveBeenCalledWith("skill-1", {
        state: "sleep",
        note: "Needs guarded activation",
      });

      await act(async () => {
        control(renderer, "skillsThreshold").props.onChange({ target: { value: "0.9" } });
      });
      await act(async () => {
        button(renderer, "Save policy").props.onClick();
      });
      await flush();

      expect(apiMocks.patchSkillActivationPolicies).toHaveBeenCalledWith({
        guardedAutoThreshold: 0.9,
        requireFirstUseConfirmation: true,
      });

      await act(async () => {
        control(renderer, "skillSourceQuery").props.onChange({ target: { value: "browser" } });
      });
      await act(async () => {
        button(renderer, "Lookup").props.onClick();
      });
      await flush();

      expect(apiMocks.fetchSkillLookup).toHaveBeenCalledWith({ q: "browser", limit: 25 });
      expect(rendererText(renderer)).toContain("Best fit:");

      await act(async () => {
        control(renderer, "importSourceRef").props.onChange({ target: { value: "F:\\skills\\browser" } });
      });
      await act(async () => {
        button(renderer, "Validate import").props.onClick();
      });
      await flush();
      await act(async () => {
        button(renderer, "Install (disabled by default)").props.onClick();
      });
      await flush();

      expect(apiMocks.validateSkillImport).toHaveBeenCalledWith({
        sourceRef: "F:\\skills\\browser",
        sourceType: "local_path",
        sourceProvider: "local",
      });
      expect(apiMocks.installSkillImport).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceRef: "F:\\skills\\browser",
          confirmHighRisk: false,
          force: false,
        }),
      );

      const inspectButtons = renderer.root
        .findAllByType("button")
        .filter((candidate) => candidate.props.children === "Inspect");
      await act(async () => {
        inspectButtons[0]?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Candidate detail");

      await act(async () => {
        inspectButtons[1]?.props.onClick();
      });
      await flush();

      expect(apiMocks.fetchCapabilityCandidate).toHaveBeenCalledWith("candidate-1");
      expect(apiMocks.fetchCapabilityProposal).toHaveBeenCalledWith("proposal-1");
      expect(rendererText(renderer)).toContain("Proposal detail");
    } finally {
      renderer.unmount();
    }
  });
});
