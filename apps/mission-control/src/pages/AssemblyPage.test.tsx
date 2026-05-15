import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createAssemblyRun: vi.fn(),
  fetchAssemblyReputations: vi.fn(),
  fetchAssemblyRunDetail: vi.fn(),
  fetchAssemblyRuns: vi.fn(),
  fetchLlmConfig: vi.fn(),
  fetchLlmModels: vi.fn(),
}));

vi.mock("../api/client", () => ({
  createAssemblyRun: apiMocks.createAssemblyRun,
  fetchAssemblyReputations: apiMocks.fetchAssemblyReputations,
  fetchAssemblyRunDetail: apiMocks.fetchAssemblyRunDetail,
  fetchAssemblyRuns: apiMocks.fetchAssemblyRuns,
  fetchLlmConfig: apiMocks.fetchLlmConfig,
  fetchLlmModels: apiMocks.fetchLlmModels,
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ label, text }: { label: string; text: string }) => (
    <span>
      {label}: {text}
    </span>
  ),
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: ({ what, when }: { what?: string; when?: string }) => (
    <aside>
      {what} {when}
    </aside>
  ),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children?: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {subtitle}
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import { AssemblyPage } from "./AssemblyPage";

function makeRun(overrides?: Record<string, unknown>) {
  return {
    runId: "assembly-run-1",
    title: "Hardening plan",
    status: "completed",
    currentStage: "synthesis",
    currentRoundIndex: 2,
    settings: {
      participantModels: [
        { participantId: "participant-1", providerId: "openai", model: "gpt-5.1", label: "OpenAI" },
        { participantId: "participant-2", providerId: "anthropic", model: "claude-4.2", label: "Anthropic" },
      ],
    },
    result: {
      recommendation: "Ship the smallest defensible hardening pass.",
      disagreements: [{ clusterId: "risk", topic: "Risk", summary: "One reviewer wanted a wider pass." }],
      implementationPlan: ["Patch the focused surface", "Run coverage"],
      minorityReport: { summary: "Keep scope tight.", reasons: ["Dirty worktree"] },
      exports: [{ target: "artifact", status: "created", detail: "artifact-1" }],
      modelContributionSummary: [
        { modelRef: "openai/gpt-5.1", contributionRole: "synthesizer", summary: "Summarized tradeoffs." },
      ],
    },
    ...overrides,
  };
}

function makeRunDetail() {
  return {
    run: makeRun(),
    rounds: [
      {
        roundId: "round-1",
        stage: "critique",
        status: "completed",
        artifactIds: ["artifact-1"],
        stopCheck: { shouldStop: false },
      },
      {
        roundId: "round-2",
        stage: "synthesis",
        status: "completed",
        artifactIds: ["artifact-2", "artifact-3"],
        stopCheck: { shouldStop: true },
      },
    ],
    artifacts: [
      { artifactId: "artifact-1", artifactType: "critique" },
      { artifactId: "artifact-2", artifactType: "synthesis" },
      { artifactId: "artifact-3", artifactType: "synthesis" },
    ],
  };
}

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("AssemblyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchLlmConfig.mockResolvedValue({
      providers: [
        { providerId: "openai", label: "OpenAI", defaultModel: "gpt-5.1" },
        { providerId: "anthropic", label: "Anthropic", defaultModel: "claude-4.2" },
      ],
    });
    apiMocks.fetchLlmModels.mockImplementation(async (providerId: string) => ({
      items:
        providerId === "openai"
          ? [{ id: "gpt-5.1" }, { id: "gpt-5.1-mini" }]
          : [{ id: "claude-4.2" }, { id: "claude-4.2-haiku" }],
    }));
    apiMocks.fetchAssemblyRuns.mockResolvedValue({ items: [makeRun()] });
    apiMocks.fetchAssemblyRunDetail.mockResolvedValue(makeRunDetail());
    apiMocks.fetchAssemblyReputations.mockResolvedValue({
      items: [{ modelRef: "openai/gpt-5.1", overall: 0.91 }],
    });
    apiMocks.createAssemblyRun.mockResolvedValue({ runId: "assembly-run-2" });
  });

  it("loads providers, renders run detail, and launches an adversarial assembly payload", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AssemblyPage workspaceId="workspace-1" />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Hardening plan");
      expect(rendererText(renderer)).toContain("Ship the smallest defensible hardening pass.");
      expect(rendererText(renderer)).toContain("synthesis : 2");
      expect(apiMocks.fetchLlmModels).toHaveBeenCalledWith("openai");
      expect(apiMocks.fetchLlmModels).toHaveBeenCalledWith("anthropic");

      const textarea = renderer.root.findByType("textarea");
      await act(async () => {
        textarea.props.onChange({ target: { value: "Review the release hardening plan." } });
      });

      const checkboxInputs = renderer.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
      await act(async () => {
        checkboxInputs[0]?.props.onChange({ target: { checked: true } });
      });

      const selects = renderer.root.findAllByType("select");
      await act(async () => {
        selects[0]?.props.onChange({ target: { value: "architecture" } });
        selects[1]?.props.onChange({ target: { value: "debate" } });
      });

      const startButton = renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Start Assembly"));
      await act(async () => {
        startButton?.props.onClick();
      });
      await flush();

      expect(apiMocks.createAssemblyRun).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          prompt: "Review the release hardening plan.",
          settings: expect.objectContaining({
            domainPreset: "architecture",
            mode: "debate",
            exportTargets: ["artifact", "task", "chat"],
          }),
          adversarialSettings: expect.objectContaining({ enabled: true }),
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces load failures and keeps the empty-state panels renderable", async () => {
    apiMocks.fetchAssemblyRuns.mockRejectedValueOnce(new Error("assembly service offline"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AssemblyPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("assembly service offline");
      expect(text).toContain("No Assembly runs yet.");
      expect(text).toContain("Select a run to inspect the timeline.");
      expect(text).toContain("No reputation data recorded yet.");
    } finally {
      renderer.unmount();
    }
  });
});
