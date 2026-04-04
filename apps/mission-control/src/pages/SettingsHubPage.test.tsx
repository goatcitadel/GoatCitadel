import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const settingsPageMock = vi.hoisted(() => vi.fn());

vi.mock("./SettingsPage", () => ({
  SettingsPage: ({ activeTab }: { activeTab?: string }) => {
    settingsPageMock(activeTab);
    return <div>{`SettingsPage:${activeTab ?? "none"}`}</div>;
  },
}));

vi.mock("./MeshPage", () => ({
  MeshPage: () => <div>MeshPage</div>,
}));

vi.mock("./NpuPage", () => ({
  NpuPage: () => <div>NpuPage</div>,
}));

vi.mock("./WorkspacesPage", () => ({
  WorkspacesPage: () => <div>WorkspacesPage</div>,
}));

vi.mock("./AddonsPage", () => ({
  AddonsPage: () => <div>AddonsPage</div>,
}));

vi.mock("./OnboardingPage", () => ({
  OnboardingPage: () => <div>OnboardingPage</div>,
}));

import { SettingsHubPage } from "./SettingsHubPage";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("SettingsHubPage", () => {
  it("passes the providers tab through to the shared settings view", async () => {
    settingsPageMock.mockClear();

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <SettingsHubPage
            activeTab="providers"
            activeWorkspaceId="workspace-1"
            onWorkspaceChange={() => undefined}
            onTabChange={() => undefined}
          />,
        );
      });

      expect(settingsPageMock).toHaveBeenCalledWith("providers");
      expect(rendererText(renderer)).toContain("SettingsPage:providers");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps runtime guidance in the hub while still rendering the shared runtime settings section", async () => {
    settingsPageMock.mockClear();

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <SettingsHubPage
            activeTab="runtime"
            activeWorkspaceId="workspace-1"
            onWorkspaceChange={() => undefined}
            onTabChange={() => undefined}
          />,
        );
      });

      expect(settingsPageMock).toHaveBeenCalledWith("runtime");
      const text = rendererText(renderer);
      expect(text).toContain("SettingsPage:runtime");
      expect(text).toContain("MeshPage");
      expect(text).toContain("NpuPage");
    } finally {
      renderer.unmount();
    }
  });
});
