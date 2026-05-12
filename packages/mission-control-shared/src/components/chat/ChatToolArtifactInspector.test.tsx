import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatToolArtifactInspector } from "./ChatToolArtifactInspector";

const apiMocks = vi.hoisted(() => ({
  fetchChatToolArtifact: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  fetchChatToolArtifact: apiMocks.fetchChatToolArtifact,
}));

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

async function clickToggle(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.root.findByType("button").props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ChatToolArtifactInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchChatToolArtifact.mockResolvedValue({
      artifact: { contentType: "application/json" },
      content: '{"ok":true}',
    });
  });

  it("loads, hides, and reopens artifact content without refetching", async () => {
    const renderer = create(
      <ChatToolArtifactInspector
        artifactId="artifact-1"
        workspaceId="default"
        artifactPath="tool-artifacts/a.json"
        originalByteLength={1536}
      />,
    );

    expect(textOf(renderer.toJSON())).toContain("tool-artifacts/a.json · 1.5 KB");
    await clickToggle(renderer);
    expect(apiMocks.fetchChatToolArtifact).toHaveBeenCalledWith("artifact-1", "default");
    expect(textOf(renderer.toJSON()).replace(/\s+/g, " ")).toContain("Content type: application/json");
    expect(textOf(renderer.toJSON())).toContain('{"ok":true}');

    await clickToggle(renderer);
    expect(textOf(renderer.toJSON())).not.toContain('{"ok":true}');
    await clickToggle(renderer);
    expect(apiMocks.fetchChatToolArtifact).toHaveBeenCalledTimes(1);
    expect(textOf(renderer.toJSON())).toContain('{"ok":true}');
  });

  it("renders byte units and failed artifact loads", async () => {
    apiMocks.fetchChatToolArtifact.mockRejectedValueOnce(new Error("artifact missing"));
    const bytes = create(
      <ChatToolArtifactInspector
        artifactId="small"
        workspaceId="default"
        artifactPath="small.txt"
        originalByteLength={99}
      />,
    );
    expect(textOf(bytes.toJSON())).toContain("small.txt · 99 B");
    await clickToggle(bytes);
    expect(textOf(bytes.toJSON())).toContain("artifact missing");

    const megabytes = create(
      <ChatToolArtifactInspector artifactId="large" workspaceId="default" originalByteLength={2 * 1024 * 1024} />,
    );
    expect(textOf(megabytes.toJSON())).toContain("2.0 MB");

    const noCaption = create(
      <ChatToolArtifactInspector artifactId="none" workspaceId="default" originalByteLength={0} />,
    );
    expect(noCaption.root.findAllByProps({ className: "chat-tool-artifact-caption" })).toHaveLength(0);
  });
});
