import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";

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

function findByClassName(renderer: ReactTestRenderer, className: string) {
  return renderer.root.findAll(
    (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes(className),
  );
}

async function clickToggle(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.root.findByType("button").props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createToolRun(overrides: Partial<ChatToolRunRecord> = {}): ChatToolRunRecord {
  return {
    toolRunId: "tool-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolName: "fs.patch",
    status: "executed",
    startedAt: "2026-05-15T00:00:00.000Z",
    finishedAt: "2026-05-15T00:00:01.000Z",
    ...overrides,
  };
}

const REALISTIC_DIFF = ["--- a/src/foo.ts", "+++ b/src/foo.ts", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");

describe("ChatToolArtifactInspector", () => {
  beforeEach(() => {
    apiMocks.fetchChatToolArtifact.mockReset();
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

  it.each([
    { artifactId: "replacement", workspaceId: "workspace-a" },
    { artifactId: "original", workspaceId: "workspace-b" },
  ])("clears cached content when the mounted tool run changes scope to $workspaceId/$artifactId", async (scope) => {
    apiMocks.fetchChatToolArtifact
      .mockResolvedValueOnce({ artifact: { contentType: "text/plain" }, content: "Former artifact content" })
      .mockResolvedValueOnce({ artifact: { contentType: "application/json" }, content: '{"current":true}' });
    const run = createToolRun();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatToolArtifactInspector artifactId="original" workspaceId="workspace-a" run={run} />);
    });
    await clickToggle(renderer);
    expect(textOf(renderer.toJSON())).toContain("Former artifact content");

    await act(async () => renderer.update(<ChatToolArtifactInspector {...scope} run={run} />));
    expect(textOf(renderer.toJSON())).not.toContain("Former artifact content");
    expect(textOf(renderer.toJSON())).not.toContain("Content type:");
    expect(apiMocks.fetchChatToolArtifact).toHaveBeenCalledTimes(1);
    await clickToggle(renderer);
    expect(apiMocks.fetchChatToolArtifact).toHaveBeenLastCalledWith(scope.artifactId, scope.workspaceId);
    expect(textOf(renderer.toJSON())).toContain('{"current":true}');
    await act(async () => renderer.unmount());
  });

  it("ignores a late artifact response after the mounted tool run changes scope", async () => {
    let resolvePrevious!: (value: { artifact: { contentType: string }; content: string }) => void;
    apiMocks.fetchChatToolArtifact
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePrevious = resolve;
          }),
      )
      .mockResolvedValueOnce({ artifact: { contentType: "text/plain" }, content: "Current artifact content" });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatToolArtifactInspector artifactId="original" workspaceId="workspace-a" />);
    });
    await clickToggle(renderer);
    expect(textOf(renderer.toJSON())).toContain("Loading artifact");

    await act(async () => {
      renderer.update(<ChatToolArtifactInspector artifactId="replacement" workspaceId="workspace-b" />);
    });
    await clickToggle(renderer);
    await act(async () => {
      resolvePrevious({ artifact: { contentType: "text/plain" }, content: "Former artifact content" });
    });
    expect(apiMocks.fetchChatToolArtifact).toHaveBeenLastCalledWith("replacement", "workspace-b");
    expect(textOf(renderer.toJSON())).toContain("Current artifact content");
    expect(textOf(renderer.toJSON())).not.toContain("Former artifact content");
    await act(async () => renderer.unmount());
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

  it("renders the diff block instead of the raw dump when run.result carries a qualifying diff", async () => {
    apiMocks.fetchChatToolArtifact.mockResolvedValue({
      artifact: { contentType: "text/plain" },
      content: "irrelevant fetched artifact content",
    });
    const run = createToolRun({ result: { patch: REALISTIC_DIFF } });
    const renderer = create(<ChatToolArtifactInspector artifactId="artifact-1" workspaceId="default" run={run} />);
    await clickToggle(renderer);

    expect(findByClassName(renderer, "mc-next-tool-diff")).toHaveLength(1);
    expect(textOf(renderer.toJSON())).not.toContain("irrelevant fetched artifact content");
  });

  it("renders exactly as before (raw text dump) for a run with plain-text output and no run prop", async () => {
    const renderer = create(
      <ChatToolArtifactInspector
        artifactId="artifact-1"
        workspaceId="default"
        artifactPath="tool-artifacts/a.json"
        originalByteLength={1536}
      />,
    );
    await clickToggle(renderer);

    expect(findByClassName(renderer, "mc-next-tool-diff")).toHaveLength(0);
    expect(textOf(renderer.toJSON())).toContain('{"ok":true}');
  });

  it("renders exactly as before (raw text dump) for a run whose result has plain-text output", async () => {
    const run = createToolRun({ result: { output: "plain text output, not a diff at all" } });
    const renderer = create(<ChatToolArtifactInspector artifactId="artifact-1" workspaceId="default" run={run} />);
    await clickToggle(renderer);

    expect(findByClassName(renderer, "mc-next-tool-diff")).toHaveLength(0);
    expect(textOf(renderer.toJSON())).toContain('{"ok":true}');
  });
});
