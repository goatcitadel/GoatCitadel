// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import {
  GeneratedArtifactActionsContext,
  GeneratedArtifactViewer,
} from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { ArtifactRenderActions, renderCockpitArtifactActions } from "./ArtifactRenderActions";

const api = vi.hoisted(() => ({
  renderChatGeneratedArtifact: vi.fn(),
  critiqueChatGeneratedArtifact: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  renderChatGeneratedArtifact: api.renderChatGeneratedArtifact,
  critiqueChatGeneratedArtifact: api.critiqueChatGeneratedArtifact,
}));

// The gateway may live on another origin and require header auth, so images load through
// an authenticated fetch into a blob URL rather than a bare <img src>.
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  buildGatewayUrl: (path: string) => `http://gateway.test${path}`,
  readGatewayAuthHeaders: () => ({ Authorization: "Bearer test-token" }),
}));

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["png"]) }));
let objectUrls = 0;

const now = "2026-10-12T10:00:00.000Z";
const renders = [
  {
    artifactId: "artifact-1",
    contentHash: "a".repeat(64),
    viewport: "desktop",
    attachmentId: "att-desktop",
    sha256: "b".repeat(64),
    width: 1440,
    height: 900,
    createdAt: now,
  },
  {
    artifactId: "artifact-1",
    contentHash: "a".repeat(64),
    viewport: "phone",
    attachmentId: "att-phone",
    sha256: "c".repeat(64),
    width: 390,
    height: 844,
    createdAt: now,
  },
];

function artifact(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "sess-1",
    workspaceId: "workspace-a",
    turnId: "turn-1",
    title: "Landing page",
    kind: "html",
    content: "<!doctype html><html><body>hi</body></html>",
    sourceSurface: "chat",
    version: 1,
    contentHash: "a".repeat(64),
    createdAt: now,
    ...overrides,
  } as ChatGeneratedArtifactRecord;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  api.renderChatGeneratedArtifact.mockReset();
  api.critiqueChatGeneratedArtifact.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => `blob:render-${(objectUrls += 1)}`);
  URL.revokeObjectURL = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === name);
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

describe("ArtifactRenderActions", () => {
  it("renders an html artifact to two viewport images through the API", async () => {
    api.renderChatGeneratedArtifact.mockResolvedValue({
      artifactId: "artifact-1",
      contentHash: "a".repeat(64),
      renders,
    });
    act(() => root.render(<ArtifactRenderActions artifact={artifact()} />));

    await act(async () => button("Render").click());

    expect(api.renderChatGeneratedArtifact).toHaveBeenCalledWith("artifact-1", "workspace-a");
    const images = Array.from(container.querySelectorAll("img"));
    expect(images.map((img) => img.getAttribute("alt"))).toEqual([
      "desktop render (1440×900)",
      "phone render (390×844)",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway.test/api/v1/chat/attachments/att-desktop/content?disposition=inline",
      {
        headers: { Authorization: "Bearer test-token" },
      },
    );
    expect(images[0]?.getAttribute("src")).toMatch(/^blob:render-/);
    expect(container.textContent).toContain("Rendered 2 snapshots");
  });

  it("reports a sent critique and the text-only marker from the response", async () => {
    api.critiqueChatGeneratedArtifact.mockResolvedValue({
      sessionId: "sess-1",
      turnId: "turn-2",
      visuallyInspected: false,
      renders,
    });
    act(() => root.render(<ArtifactRenderActions artifact={artifact()} workspaceId="workspace-b" />));

    await act(async () => button("Critique render").click());

    expect(api.critiqueChatGeneratedArtifact).toHaveBeenCalledWith("artifact-1", "workspace-b");
    expect(container.textContent).toContain("Critique sent to the conversation");
    expect(container.textContent).toContain("(sent without images: the current model has no vision capability)");
    expect(container.querySelectorAll("img")).toHaveLength(2);

    api.critiqueChatGeneratedArtifact.mockResolvedValue({
      sessionId: "sess-1",
      turnId: "turn-3",
      visuallyInspected: true,
      renders,
    });
    await act(async () => button("Critique render").click());
    expect(container.textContent).not.toContain("sent without images");
  });

  it("mounts under every shared viewer through the cockpit actions slot", () => {
    act(() =>
      root.render(
        <GeneratedArtifactActionsContext.Provider value={renderCockpitArtifactActions}>
          <GeneratedArtifactViewer artifact={artifact()} compact />
          <GeneratedArtifactViewer artifact={artifact({ artifactId: "artifact-2", kind: "markdown" })} compact />
        </GeneratedArtifactActionsContext.Provider>,
      ),
    );

    expect(container.querySelectorAll("[aria-label='Artifact render actions']")).toHaveLength(1);
    expect(button("Render")).toBeDefined();
  });

  it("shows the API failure and renders nothing for non-html or redacted artifacts", async () => {
    api.renderChatGeneratedArtifact.mockRejectedValue(new Error("Only html artifacts can be rendered."));
    act(() => root.render(<ArtifactRenderActions artifact={artifact()} />));
    await act(async () => button("Render").click());
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Only html artifacts can be rendered.");

    act(() => root.render(<ArtifactRenderActions artifact={artifact({ kind: "markdown" })} />));
    expect(container.querySelectorAll("button")).toHaveLength(0);
    act(() =>
      root.render(
        <ArtifactRenderActions
          artifact={artifact({
            publicProjection: {
              contentRedacted: true,
              redactedPaths: ["content"],
              canonicalContentHashRefersToStoredArtifact: true,
            },
          })}
        />,
      ),
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
