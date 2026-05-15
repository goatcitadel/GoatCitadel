import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const renderedSettingsTabs = vi.hoisted(() => vi.fn());
const renderedWorkspaceProps = vi.hoisted(() => vi.fn());

vi.mock("../components/EmbeddedPageChrome", () => ({
  EmbeddedPageChromeProvider: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/ConfigureHubLayout", () => ({
  ConfigureHubLayout: ({
    title,
    subtitle,
    guideTitle,
    guideBody,
    tabItems,
    activeTab,
    onTabChange,
    children,
  }: {
    title: string;
    subtitle: string;
    guideTitle: string;
    guideBody: string;
    tabItems: Array<{ id: string; label: string }>;
    activeTab: string;
    onTabChange: (tab: string) => void;
    children?: React.ReactNode;
  }) => (
    <section data-active-tab={activeTab}>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <strong>{guideTitle}</strong>
      <span>{guideBody}</span>
      {tabItems.map((item) => (
        <button key={item.id} type="button" onClick={() => onTabChange(item.id)}>
          {item.label}
        </button>
      ))}
      {children}
    </section>
  ),
}));

vi.mock("../components/PageTabs", () => ({
  PageTabs: ({
    items,
    activeId,
    onSelect,
  }: {
    items: Array<{ id: string; label: string }>;
    activeId: string;
    onSelect: (value: string) => void;
  }) => (
    <nav data-active-tab={activeId}>
      {items.map((item) => (
        <button key={item.id} type="button" onClick={() => onSelect(item.id)}>
          {item.label}
        </button>
      ))}
    </nav>
  ),
}));

vi.mock("../components/SectionTitle", () => ({
  SectionTitle: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
}));

vi.mock("./ActivityPage", () => ({
  ActivityPage: () => <div>Activity live feed page</div>,
}));

vi.mock("./CronPage", () => ({
  CronPage: () => <div>Scheduler page</div>,
}));

vi.mock("./ImprovementPage", () => ({
  ImprovementPage: ({ workspaceId }: { workspaceId?: string }) => <div>Improvement page {workspaceId}</div>,
}));

vi.mock("./OnboardingPage", () => ({
  OnboardingPage: ({ onCompleted }: { onCompleted?: () => void }) => (
    <button type="button" onClick={onCompleted}>
      Onboarding page
    </button>
  ),
}));

vi.mock("./SettingsPage", () => ({
  SettingsPage: ({ activeTab }: { activeTab: string }) => {
    renderedSettingsTabs(activeTab);
    return <div>Settings page {activeTab}</div>;
  },
}));

vi.mock("./AddonsPage", () => ({
  AddonsPage: () => <div>Add-ons page</div>,
}));

vi.mock("./WorkspacesPage", () => ({
  WorkspacesPage: ({
    activeWorkspaceId,
    onWorkspaceChange,
  }: {
    activeWorkspaceId: string;
    onWorkspaceChange: (workspaceId: string) => void;
  }) => {
    renderedWorkspaceProps({ activeWorkspaceId });
    return (
      <button type="button" onClick={() => onWorkspaceChange("workspace-next")}>
        Workspaces page {activeWorkspaceId}
      </button>
    );
  },
}));

import { ActivityHubPage } from "./ActivityHubPage";
import { GeneralHubPage, type GeneralTab } from "./GeneralHubPage";
import { WorkspacesHubPage, type WorkspacesTab } from "./WorkspacesHubPage";
import type { ActivityTab } from "../content/page-registry";

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

describe("ActivityHubPage", () => {
  it.each([
    ["activity", "Activity live feed page"],
    ["scheduler", "Scheduler page"],
    ["improvement", "Improvement page workspace-1"],
  ] as Array<[ActivityTab, string]>)("routes %s to the expected embedded page", (activeTab, expectedText) => {
    const onTabChange = vi.fn();
    const renderer = create(
      <ActivityHubPage activeTab={activeTab} workspaceId="workspace-1" onTabChange={onTabChange} />,
    );
    try {
      expect(rendererText(renderer)).toContain("Activity");
      expect(rendererText(renderer)).toContain(expectedText);

      const schedulerButton = renderer.root.findAllByType("button").find((node) => node.children.includes("Scheduler"));
      act(() => {
        schedulerButton?.props.onClick();
      });
      expect(onTabChange).toHaveBeenCalledWith("scheduler");
    } finally {
      renderer.unmount();
    }
  });
});

describe("GeneralHubPage", () => {
  it.each([
    ["general", "Set the base defaults Mission Control will reuse everywhere else."],
    ["providers", "Choose the provider and model defaults every Work surface inherits."],
    ["access", "Lock down tokens, device grants, and gateway entry before broader tuning."],
    ["budget", "Keep spend and read access defaults aligned with runtime risk."],
  ] as Array<[GeneralTab, string]>)("routes %s to SettingsPage with contextual copy", (activeTab, expectedSubtitle) => {
    renderedSettingsTabs.mockClear();
    const onTabChange = vi.fn();
    const renderer = create(<GeneralHubPage activeTab={activeTab} onTabChange={onTabChange} />);
    try {
      expect(renderedSettingsTabs).toHaveBeenCalledWith(activeTab);
      expect(rendererText(renderer)).toContain(`Settings page ${activeTab}`);
      expect(rendererText(renderer)).toContain(expectedSubtitle);

      const budgetButton = renderer.root.findAllByType("button").find((node) => node.children.includes("Budget"));
      act(() => {
        budgetButton?.props.onClick();
      });
      expect(onTabChange).toHaveBeenCalledWith("budget");
    } finally {
      renderer.unmount();
    }
  });

  it("routes onboarding to the onboarding surface and forwards completion", () => {
    const onTabChange = vi.fn();
    const onOnboardingCompleted = vi.fn();
    const renderer = create(
      <GeneralHubPage activeTab="onboarding" onTabChange={onTabChange} onOnboardingCompleted={onOnboardingCompleted} />,
    );
    try {
      expect(rendererText(renderer)).toContain("Use onboarding to tighten defaults before the workspace gets busy.");
      const onboardingButton = renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Onboarding page"));
      act(() => {
        onboardingButton?.props.onClick();
      });
      expect(onOnboardingCompleted).toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });
});

describe("WorkspacesHubPage", () => {
  it.each([
    ["workspaces", "Workspaces page workspace-1"],
    ["addons", "Add-ons page"],
  ] as Array<[WorkspacesTab, string]>)(
    "routes %s to the expected workspace control surface",
    (activeTab, expectedText) => {
      renderedWorkspaceProps.mockClear();
      const onWorkspaceChange = vi.fn();
      const onTabChange = vi.fn();
      const renderer = create(
        <WorkspacesHubPage
          activeTab={activeTab}
          activeWorkspaceId="workspace-1"
          onWorkspaceChange={onWorkspaceChange}
          onTabChange={onTabChange}
        />,
      );
      try {
        expect(rendererText(renderer)).toContain(expectedText);

        const addonsButton = renderer.root.findAllByType("button").find((node) => node.children.includes("Add-ons"));
        act(() => {
          addonsButton?.props.onClick();
        });
        expect(onTabChange).toHaveBeenCalledWith("addons");

        if (activeTab === "workspaces") {
          expect(renderedWorkspaceProps).toHaveBeenCalledWith({ activeWorkspaceId: "workspace-1" });
          const workspacesButton = renderer.root
            .findAllByType("button")
            .find((node) =>
              rendererText({ toJSON: () => node } as unknown as ReactTestRenderer).includes("Workspaces page"),
            );
          act(() => {
            workspacesButton?.props.onClick();
          });
          expect(onWorkspaceChange).toHaveBeenCalledWith("workspace-next");
        }
      } finally {
        renderer.unmount();
      }
    },
  );
});
