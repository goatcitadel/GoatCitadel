import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  PageHeader: ({ actions, subtitle, title }: { actions?: React.ReactNode; subtitle?: string; title: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children, subtitle, title }: { children?: React.ReactNode; subtitle?: React.ReactNode; title: string }) => (
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

vi.mock("../content/copy", () => ({
  pageCopy: {
    assembly: {
      guide: {
        actions: ["Start a run"],
        terms: [],
        what: "Multi-model assembly",
        when: "Use it for decisions",
      },
      subtitle: "Coordinate model deliberation.",
      title: "Assembly",
    },
  },
}));

import { AssemblyPage } from "./AssemblyPage";

function makeRun(overrides?: Record<string, unknown>) {
  return {
    currentRoundIndex: 1,
    currentStage: "intake",
    result: null,
    runId: "assembly-run-1",
    settings: {
      participantModels: [
        { label: "OpenAI", model: "gpt-5.1", participantId: "participant-1", providerId: "openai" },
        { label: "Anthropic", model: "claude-4.2", participantId: "participant-2", providerId: "anthropic" },
      ],
    },
    status: "completed",
    title: "Runtime review",
    ...overrides,
  };
}

function makeRunDetail(overrides?: Record<string, unknown>) {
  return {
    artifacts: [
      { artifactId: "artifact-1", artifactType: "critique" },
      { artifactId: "artifact-2", artifactType: "synthesis" },
    ],
    rounds: [
      {
        artifactIds: ["artifact-1"],
        roundId: "round-1",
        stage: "critique",
        status: "completed",
        stopCheck: { shouldStop: false },
      },
    ],
    run: makeRun(),
    ...overrides,
  };
}

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? nodeText(child) : ""))
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

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("AssemblyPage loop 42 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.stubGlobal("window", {
      clearInterval: (intervalId: ReturnType<typeof setInterval>) => clearInterval(intervalId),
      setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    });

    apiMocks.fetchLlmConfig.mockResolvedValue({
      providers: [
        { defaultModel: "gpt-5.1", label: "OpenAI", providerId: "openai" },
        { defaultModel: "claude-4.2", label: "Anthropic", providerId: "anthropic" },
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
    apiMocks.fetchAssemblyReputations.mockResolvedValue({ items: [{ modelRef: "openai/gpt-5.1", overall: 0.88 }] });
    apiMocks.createAssemblyRun.mockResolvedValue({ runId: "assembly-run-created" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("wires numeric, participant, and adversarial controls into the launch payload", async () => {
    apiMocks.fetchAssemblyRuns.mockResolvedValue({
      items: [makeRun(), makeRun({ runId: "assembly-run-2", status: "failed", title: "Second review" })],
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AssemblyPage workspaceId="workspace-loop42" />);
      });
      await flush();

      apiMocks.fetchAssemblyRunDetail.mockResolvedValueOnce(
        makeRunDetail({ run: makeRun({ runId: "assembly-run-2", status: "failed", title: "Second review" }) }),
      );
      await act(async () => {
        button(renderer, "Second review").props.onClick();
      });
      await flush();
      expect(apiMocks.fetchAssemblyRunDetail).toHaveBeenCalledWith("assembly-run-2");

      await act(async () => {
        renderer.root.findByType("textarea").props.onChange({
          target: { value: "Stress test the assembly decision path." },
        });
      });

      const numberInputs = () => renderer.root.findAllByType("input").filter((node) => node.props.type === "number");
      await act(async () => {
        numberInputs()[0]?.props.onChange({ target: { value: "" } });
        numberInputs()[1]?.props.onChange({ target: { value: "0.91" } });
        numberInputs()[2]?.props.onChange({ target: { value: "" } });
        numberInputs()[3]?.props.onChange({ target: { value: "2.5" } });
      });

      await act(async () => {
        button(renderer, "Add model").props.onClick();
        button(renderer, "Add model").props.onClick();
        button(renderer, "Add model").props.onClick();
        button(renderer, "Add model").props.onClick();
      });

      let selects = renderer.root.findAllByType("select");
      await act(async () => {
        selects[2]?.props.onChange({ target: { value: "anthropic" } });
      });
      selects = renderer.root.findAllByType("select");
      await act(async () => {
        selects[5]?.props.onChange({ target: { value: "gpt-5.1-mini" } });
      });
      await act(async () => {
        button(renderer, "Remove", 2).props.onClick();
      });

      await act(async () => {
        renderer.root
          .findAllByType("input")
          .find((node) => node.props.type === "checkbox")
          ?.props.onChange({
            target: { checked: true },
          });
      });

      await act(async () => {
        numberInputs()
          .at(-1)
          ?.props.onChange({ target: { value: "" } });
      });
      selects = renderer.root.findAllByType("select");
      await act(async () => {
        selects.at(-2)?.props.onChange({ target: { value: "auto_selected_by_reputation" } });
        selects.at(-1)?.props.onChange({ target: { value: "aggressive" } });
      });

      const adversarialChecks = renderer.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
      await act(async () => {
        adversarialChecks.slice(1).forEach((node, index) => {
          node.props.onChange({ target: { checked: index % 2 === 0 } });
        });
      });

      await act(async () => {
        button(renderer, "Start Assembly").props.onClick();
      });
      await flush();

      expect(apiMocks.createAssemblyRun).toHaveBeenCalledWith(
        expect.objectContaining({
          adversarialSettings: expect.objectContaining({
            defenseRoundEnabled: true,
            enabled: true,
            minorityReportRequired: true,
            repetitiveObjectionCutoff: false,
            requireEvidenceTags: false,
            requireMitigations: true,
            reviewerCount: 1,
            selectionStrategy: "auto_selected_by_reputation",
            strictness: "aggressive",
          }),
          prompt: "Stress test the assembly decision path.",
          settings: expect.objectContaining({
            convergenceThreshold: 0.91,
            costBudgetUsd: 2.5,
            maxRounds: 1,
            participantModels: expect.arrayContaining([
              expect.objectContaining({ model: "claude-4.2", providerId: "anthropic" }),
              expect.objectContaining({ model: "gpt-5.1-mini", providerId: "anthropic" }),
            ]),
            tokenBudget: 1000,
          }),
          workspaceId: "workspace-loop42",
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("polls running runs and surfaces polling failures", async () => {
    vi.useFakeTimers();
    const runningRun = makeRun({ status: "running" });
    apiMocks.fetchAssemblyRunDetail
      .mockResolvedValueOnce(makeRunDetail({ run: runningRun }))
      .mockRejectedValueOnce(new Error("poll failed"));
    apiMocks.fetchAssemblyRuns
      .mockResolvedValueOnce({ items: [runningRun] })
      .mockResolvedValueOnce({ items: [runningRun] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AssemblyPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("running");

      await act(async () => {
        vi.advanceTimersByTime(3500);
      });
      await flush();

      expect(apiMocks.fetchAssemblyRunDetail).toHaveBeenCalledWith("assembly-run-1");
      expect(rendererText(renderer)).toContain("poll failed");
    } finally {
      renderer.unmount();
    }
  });
});
