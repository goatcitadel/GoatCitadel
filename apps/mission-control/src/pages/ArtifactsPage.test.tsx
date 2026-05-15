import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchChatGeneratedArtifacts: vi.fn(async () => ({
    items: [
      {
        artifactId: "artifact-1",
        sessionId: "session-alpha",
        title: "Architecture brief",
        kind: "markdown",
        version: 2,
        sourceSurface: "cowork",
        createdAt: "2026-03-10T18:00:00.000Z",
        content: "Long markdown artifact content",
      },
      {
        artifactId: "artifact-2",
        sessionId: "session-beta",
        title: "Preview",
        kind: "html",
        version: 1,
        sourceSurface: "chat",
        createdAt: "not-a-date",
        content: "<main>preview</main>",
      },
    ],
  })),
  fetchChatSessions: vi.fn(async () => ({
    items: [
      { sessionId: "session-alpha", title: "Alpha session" },
      { sessionId: "session-beta", title: "" },
    ],
  })),
}));

vi.mock("../api/client", () => ({
  fetchChatGeneratedArtifacts: apiMocks.fetchChatGeneratedArtifacts,
  fetchChatSessions: apiMocks.fetchChatSessions,
}));

vi.mock("./FilesPage", () => ({
  FilesPage: ({ workspaceId }: { workspaceId?: string }) => <div>files page {workspaceId}</div>,
}));

vi.mock("./MemoryPage", () => ({
  MemoryPage: ({ workspaceId }: { workspaceId?: string }) => <div>memory page {workspaceId}</div>,
}));

import { ArtifactsPage } from "./ArtifactsPage";

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

function normalizedText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function reactNodeText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => reactNodeText(child)).join(" ");
  }
  if (typeof value === "object" && "props" in value) {
    return reactNodeText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ArtifactsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders delegated files and memory tabs", () => {
    const onTabChange = vi.fn();
    const renderer = create(<ArtifactsPage activeTab="memory" workspaceId="workspace-1" onTabChange={onTabChange} />);
    expect(normalizedText(renderer)).toContain("memory page workspace-1");

    renderer.update(<ArtifactsPage activeTab="files" workspaceId="workspace-1" onTabChange={onTabChange} />);
    expect(normalizedText(renderer)).toContain("files page workspace-1");

    const filesTab = renderer.root
      .findAllByType("button")
      .find((button) => collectText(button.props.children).includes("Files"))!;
    act(() => {
      filesTab.props.onClick();
    });
    expect(onTabChange).toHaveBeenCalledWith("files");
    renderer.unmount();
  });

  it("loads generated artifacts, filters them, and opens a selected artifact", async () => {
    const onOpen = vi.fn();
    const renderer = create(
      <ArtifactsPage
        activeTab="generated"
        workspaceId="workspace-1"
        onTabChange={() => undefined}
        onOpenGeneratedArtifact={onOpen}
      />,
    );

    expect(collectText(renderer.toJSON())).toContain("Loading generated artifacts");
    await flush();

    expect(apiMocks.fetchChatGeneratedArtifacts).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 500 });
    expect(apiMocks.fetchChatSessions).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scope: "all",
      view: "all",
      limit: 300,
    });
    expect(collectText(renderer.toJSON())).toContain("Alpha session");
    expect(collectText(renderer.toJSON())).toContain("Session n-beta");

    const cards = renderer.root
      .findAllByType("button")
      .filter(
        (button) =>
          typeof button.props.className === "string" && button.props.className.includes("artifacts-generated-card"),
      );
    expect(cards).toHaveLength(2);
    await act(async () => {
      cards[1]!.props.onClick();
    });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "artifact-2" }));

    const chatFilter = renderer.root
      .findAllByType("button")
      .find((button) => reactNodeText(button.props.children).trim() === "chat")!;
    await act(async () => {
      chatFilter.props.onClick();
    });

    expect(collectText(renderer.toJSON())).toContain("Preview");
    expect(collectText(renderer.toJSON())).not.toContain("Architecture brief");
    renderer.unmount();
  });

  it("shows generated artifact load errors", async () => {
    apiMocks.fetchChatGeneratedArtifacts.mockRejectedValueOnce(new Error("artifact-service-down"));
    const renderer = create(<ArtifactsPage activeTab="generated" onTabChange={() => undefined} />);
    await flush();

    expect(collectText(renderer.toJSON())).toContain("artifact-service-down");
    renderer.unmount();
  });

  it("shows a generated artifact empty state when filters have no matches", async () => {
    apiMocks.fetchChatGeneratedArtifacts.mockResolvedValueOnce({ items: [] });
    apiMocks.fetchChatSessions.mockResolvedValueOnce({ items: [] });

    const renderer = create(<ArtifactsPage activeTab="generated" onTabChange={() => undefined} />);
    await flush();

    const text = collectText(renderer.toJSON());
    expect(text).toContain("No generated artifacts match the current filters yet.");
    expect(text).not.toContain("Loading generated artifacts");
    renderer.unmount();
  });
});
