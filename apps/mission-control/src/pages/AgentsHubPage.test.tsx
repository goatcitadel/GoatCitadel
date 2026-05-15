import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/EmbeddedPageChrome", () => ({
  EmbeddedPageChromeProvider: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/ConfigureHubLayout", () => ({
  ConfigureHubLayout: ({
    title,
    subtitle,
    summaries,
    tabItems,
    activeTab,
    onTabChange,
    children,
  }: {
    title: string;
    subtitle: string;
    summaries: Array<{ label: string; value: string; note?: string }>;
    tabItems: Array<{ id: string; label: string }>;
    activeTab: string;
    onTabChange: (value: string) => void;
    children?: React.ReactNode;
  }) => (
    <section data-active-tab={activeTab}>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {summaries.map((summary) => (
        <article key={summary.label}>
          {summary.label}: {summary.value} {summary.note}
        </article>
      ))}
      {tabItems.map((item) => (
        <button key={item.id} type="button" onClick={() => onTabChange(item.id)}>
          {item.label}
        </button>
      ))}
      {children}
    </section>
  ),
}));

vi.mock("./AgentsPage", () => ({
  AgentsPage: () => <div>Agents overview page</div>,
}));

vi.mock("./AgentsBoardPage", () => ({
  AgentsBoardPage: () => <div>Agents board page</div>,
}));

vi.mock("./AgentsCatalogPage", () => ({
  AgentsCatalogPage: ({ workspaceId, sessionId }: { workspaceId?: string; sessionId?: string }) => (
    <div>
      Agents catalog page {workspaceId} {sessionId}
    </div>
  ),
}));

vi.mock("./SkillsPage", () => ({
  SkillsPage: () => <div>Skills page</div>,
}));

import { AgentsHubPage } from "./AgentsHubPage";
import type { AgentsTab } from "../content/page-registry";

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

describe("AgentsHubPage", () => {
  it.each([
    ["overview", "Agents overview page", "Agent availability"],
    ["board", "Agents board page", "Review the board"],
    ["skills", "Skills page", "Behavior shaping"],
    ["catalog", "Agents catalog page workspace-1 session-1", "Dormant specialists"],
  ] as Array<[AgentsTab, string, string]>)(
    "routes the %s tab into the right embedded page",
    (tab, pageText, summaryText) => {
      const onTabChange = vi.fn();
      const renderer = create(
        <AgentsHubPage activeTab={tab} workspaceId="workspace-1" sessionId="session-1" onTabChange={onTabChange} />,
      );
      try {
        const text = rendererText(renderer);
        expect(text).toContain("Agents");
        expect(text).toContain(pageText);
        expect(text).toContain(summaryText);

        const catalogButton = renderer.root.findAllByType("button").find((node) => node.children.includes("Catalog"));
        act(() => {
          catalogButton?.props.onClick();
        });
        expect(onTabChange).toHaveBeenCalledWith("catalog");
      } finally {
        renderer.unmount();
      }
    },
  );
});
