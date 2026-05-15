import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatToolArtifactInspector } from "./ChatToolArtifactInspector";
import { formatChatToolArtifactBytes } from "./chat-tool-artifact-inspector-helpers";

const apiMocks = vi.hoisted(() => ({
  fetchChatToolArtifact: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  fetchChatToolArtifact: apiMocks.fetchChatToolArtifact,
}));

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

async function clickFirstButton(renderer: ReactTestRenderer): Promise<void> {
  const button = renderer.root.findByType("button");
  await act(async () => {
    button.props.onClick();
    await Promise.resolve();
  });
}

describe("formatChatToolArtifactBytes", () => {
  it.each([
    [undefined, null],
    [Number.NaN, null],
    [0, null],
    [512, "512 B"],
    [1536, "1.5 KB"],
    [2 * 1024 * 1024, "2.0 MB"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatChatToolArtifactBytes(input)).toBe(expected);
  });
});

describe("ChatToolArtifactInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads an artifact once, displays metadata, and closes without refetching", async () => {
    apiMocks.fetchChatToolArtifact.mockResolvedValue({
      content: '{"ok":true}',
      artifact: { contentType: "application/json" },
    });
    const renderer = create(
      <ChatToolArtifactInspector
        artifactId="artifact-1"
        workspaceId="workspace-1"
        artifactPath="artifacts/result.json"
        originalByteLength={1536}
      />,
    );

    await clickFirstButton(renderer);

    const opened = collectText(renderer.toJSON());
    expect(opened).toContain("Hide raw artifact");
    expect(opened).toContain("artifacts/result.json · 1.5 KB");
    expect(opened).toMatch(/Content type:\s+application\/json/);
    expect(opened).toContain('{"ok":true}');

    await clickFirstButton(renderer);
    await clickFirstButton(renderer);

    expect(apiMocks.fetchChatToolArtifact).toHaveBeenCalledTimes(1);
  });

  it("shows the fetch error and no caption when artifact metadata is absent", async () => {
    apiMocks.fetchChatToolArtifact.mockRejectedValue(new Error("artifact missing"));
    const renderer = create(<ChatToolArtifactInspector artifactId="artifact-2" workspaceId="workspace-1" />);

    await clickFirstButton(renderer);

    const text = collectText(renderer.toJSON());
    expect(text).toContain("artifact missing");
    expect(text).not.toContain(" · ");
  });
});
