import { act } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { useRouteGeneratedArtifactReveal } from "./useRouteGeneratedArtifactReveal";

const fetchChatGeneratedArtifactMock = vi.fn();

vi.mock("../../api/client", () => ({
  fetchChatGeneratedArtifact: (artifactId: string, workspaceId: string) =>
    fetchChatGeneratedArtifactMock(artifactId, workspaceId),
}));

function makeArtifact(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "sess-artifact",
    workspaceId: "default",
    turnId: "turn-artifact",
    title: "Generated artifact",
    kind: "code",
    content: "export const answer = 42;",
    language: "ts",
    sourceSurface: "code",
    version: 1,
    providerId: "openai",
    model: "gpt-4.1",
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    ...overrides,
  };
}

function Harness({
  routeArtifactId,
  workspaceId = "default",
  revealGeneratedArtifact,
  setActiveGeneratedArtifact,
}: {
  routeArtifactId: string | null;
  workspaceId?: string;
  revealGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord) => Promise<void> | void;
  setActiveGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord | null) => void;
}) {
  useRouteGeneratedArtifactReveal({
    routeArtifactId,
    workspaceId,
    revealGeneratedArtifact,
    setActiveGeneratedArtifact,
  });
  return null;
}

describe("useRouteGeneratedArtifactReveal", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    fetchChatGeneratedArtifactMock.mockReset();
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
    }
    renderer = null;
  });

  it("fetches the route artifact and reveals it through the stronger reveal path", async () => {
    const artifact = makeArtifact();
    const revealGeneratedArtifact = vi.fn(async () => undefined);
    const setActiveGeneratedArtifact = vi.fn();
    fetchChatGeneratedArtifactMock.mockResolvedValue({
      item: artifact,
    });

    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          routeArtifactId={artifact.artifactId}
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchChatGeneratedArtifactMock).toHaveBeenCalledWith(artifact.artifactId, "default");
    expect(revealGeneratedArtifact).toHaveBeenCalledWith(artifact);
    expect(setActiveGeneratedArtifact).not.toHaveBeenCalledWith(null);
  });

  it("clears the active artifact when route loading fails", async () => {
    const revealGeneratedArtifact = vi.fn(async () => undefined);
    const setActiveGeneratedArtifact = vi.fn();
    fetchChatGeneratedArtifactMock.mockRejectedValue(new Error("missing"));

    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          routeArtifactId="artifact-missing"
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(revealGeneratedArtifact).not.toHaveBeenCalled();
    expect(setActiveGeneratedArtifact).toHaveBeenCalledWith(null);
  });
});
