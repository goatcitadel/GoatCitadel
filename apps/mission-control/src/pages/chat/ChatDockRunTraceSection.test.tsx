import React from "react";
import { create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{subtitle}</p>
      <div>{actions}</div>
      {children}
    </section>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ tone, children }: { tone?: string; children?: React.ReactNode }) => (
    <span>
      chip:{tone}:{children}
    </span>
  ),
}));

vi.mock("../../components/ChatTraceCard", () => ({
  ChatTraceCard: ({
    trace,
    workspaceId,
    defaultCollapsed,
  }: {
    trace: { status: string };
    workspaceId: string;
    defaultCollapsed?: boolean;
  }) => (
    <div>
      trace-card:{workspaceId}:{trace.status}:{defaultCollapsed ? "collapsed" : "expanded"}
    </div>
  ),
}));

vi.mock("../../components/chat/ChatExecutionPlanSummary", () => ({
  ChatExecutionPlanSummary: ({ plan }: { plan: { title?: string } }) => <div>plan:{plan.title}</div>,
}));

vi.mock("../../components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { ChatDockRunTraceSection } from "./ChatDockRunTraceSection";

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

function compactText(value: string): string {
  return value.replace(/\s+/g, "");
}

const selectedTrace = {
  status: "failed",
  mode: "cowork",
  model: "gpt-5.4-mini",
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  startedAt: "2026-05-14T10:00:00.000Z",
  finishedAt: "2026-05-14T10:01:00.000Z",
  failure: { message: "Tool policy blocked write access." },
  executionPlan: { title: "Fix and verify" },
  toolRuns: [
    {
      toolRunId: "tool-1",
      toolName: "shell",
      status: "failed",
      error: "approval required",
    },
  ],
  citations: [],
  routing: {
    primaryProviderId: "openai",
    primaryModel: "gpt-5.4",
    primaryApiStyle: "responses",
    effectiveProviderId: "openai",
    effectiveModel: "gpt-5.4-mini",
    effectiveApiStyle: "chat",
    fallbackUsed: true,
    fallbackReason: "primary failed",
  },
};

const selectedTurn = {
  trace: selectedTrace,
} as never;

describe("ChatDockRunTraceSection", () => {
  it("renders the compact Chat trace card for non-Cowork surfaces", () => {
    const renderer = create(
      <ChatDockRunTraceSection
        isChatSurface
        workspaceId="default"
        selectedTurn={{ trace: { ...selectedTrace, status: "completed" } } as never}
      />,
    );

    const text = collectText(renderer.toJSON());
    const compact = compactText(text);
    expect(text).toContain("Run status");
    expect(compact).toContain("chip:success:completed");
    expect(compact).toContain("trace-card:default:completed:collapsed");
  });

  it("renders Cowork summary, routing, timeline, tools, and raw trace details", () => {
    const renderer = create(
      <ChatDockRunTraceSection
        isChatSurface={false}
        isCoworkSurface
        workspaceId="default"
        selectedTurn={selectedTurn}
        providerLabelById={new Map([["openai", "OpenAI"]])}
        routePreflight={
          {
            effectiveProviderId: "openai",
            effectiveModel: "gpt-5.4-mini",
            normalizationReason: "Session model was normalized to a configured model.",
          } as never
        }
        coworkViewModel={
          {
            selectionLabel: "Selected turn from delegated run.",
            timelineItems: {
              items: [
                {
                  id: "checkpoint-1",
                  title: "Checkpoint captured",
                  status: "done",
                  meta: "QA",
                  note: "Validated handoff.",
                },
              ],
              overflow: 2,
            },
            raw: { runId: "cowork-1" },
          } as never
        }
      />,
    );

    const text = collectText(renderer.toJSON());
    const compact = compactText(text);
    expect(text).toContain("Run details");
    expect(compact).toContain("chip:critical:failed");
    expect(text).toContain("openai · gpt-5.4 · responses");
    expect(text).toContain("openai · gpt-5.4-mini · chat");
    expect(text).toContain("Fallback used · primary failed");
    expect(text).toContain("Tool policy blocked write access.");
    expect(text).toContain("Session model was normalized to a configured model.");
    expect(text).toContain("Selected turn from delegated run.");
    expect(compact).toContain("plan:Fixandverify");
    expect(text).toContain("Checkpoint captured");
    expect(compact).toContain("+2earliertimelineitem(s)");
    expect(text).toContain("shell");
    expect(text).toContain("approval required");
    expect(text).toContain('"cowork"');
  });
});
