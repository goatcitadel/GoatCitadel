import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const integrationsPageMock = vi.hoisted(() => vi.fn());
const channelSetupPageMock = vi.hoisted(() => vi.fn());

vi.mock("./IntegrationsPage", () => ({
  IntegrationsPage: ({ view }: { view?: "overview" | "channels" }) => {
    integrationsPageMock(view);
    return <div>{`IntegrationsPage:${view ?? "overview"}`}</div>;
  },
}));

vi.mock("./ChannelSetupPage", () => ({
  ChannelSetupPage: () => {
    channelSetupPageMock();
    return <div>ChannelSetupPage</div>;
  },
}));

vi.mock("./McpPage", () => ({
  McpPage: () => <div>McpPage</div>,
}));

import { IntegrationsHubPage } from "./IntegrationsHubPage";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("IntegrationsHubPage", () => {
  beforeEach(() => {
    integrationsPageMock.mockClear();
    channelSetupPageMock.mockClear();
  });

  it("routes the channels tab to the dedicated channels view", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsHubPage activeTab="channels" onTabChange={() => undefined} />);
      });

      expect(integrationsPageMock).not.toHaveBeenCalled();
      expect(channelSetupPageMock).toHaveBeenCalled();
      expect(rendererText(renderer)).toContain("ChannelSetupPage");
      expect(rendererText(renderer)).toContain("Open details");
      expect(rendererText(renderer)).toContain(
        "Connections, transport hooks, and MCP reach stay framed as operator decisions instead of a connector catalog.",
      );
    } finally {
      renderer.unmount();
    }
  });

  it("renders the dedicated MCP page instead of the shared integrations view", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsHubPage activeTab="mcp" onTabChange={() => undefined} />);
      });

      expect(integrationsPageMock).not.toHaveBeenCalled();
      expect(rendererText(renderer)).toContain("McpPage");
      expect(rendererText(renderer)).toContain("Open details");
    } finally {
      renderer.unmount();
    }
  });
});
