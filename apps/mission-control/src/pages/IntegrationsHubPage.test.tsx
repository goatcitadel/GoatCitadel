import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const integrationsPageMock = vi.hoisted(() => vi.fn());

vi.mock("./IntegrationsPage", () => ({
  IntegrationsPage: ({ view }: { view?: "overview" | "channels" }) => {
    integrationsPageMock(view);
    return <div>{`IntegrationsPage:${view ?? "overview"}`}</div>;
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
  });

  it("routes the channels tab to the dedicated channels view", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <IntegrationsHubPage activeTab="channels" onTabChange={() => undefined} />,
        );
      });

      expect(integrationsPageMock).toHaveBeenCalledWith("channels");
      expect(rendererText(renderer)).toContain("IntegrationsPage:channels");
    } finally {
      renderer.unmount();
    }
  });

  it("renders the dedicated MCP page instead of the shared integrations view", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <IntegrationsHubPage activeTab="mcp" onTabChange={() => undefined} />,
        );
      });

      expect(integrationsPageMock).not.toHaveBeenCalled();
      expect(rendererText(renderer)).toContain("McpPage");
    } finally {
      renderer.unmount();
    }
  });
});
