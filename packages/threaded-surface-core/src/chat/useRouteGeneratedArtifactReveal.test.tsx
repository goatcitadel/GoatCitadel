import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { useRouteGeneratedArtifactReveal } from "./useRouteGeneratedArtifactReveal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  fetchChatGeneratedArtifact: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatGeneratedArtifact: apiMocks.fetchChatGeneratedArtifact,
}));

const artifact = {
  artifactId: "artifact-1",
  sessionId: "session-1",
  turnId: "turn-1",
  kind: "document",
  title: "Plan",
  contentType: "text/markdown",
  content: "# Plan",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
} as ChatGeneratedArtifactRecord;

function Harness(props: {
  routeArtifactId: string | null;
  revealGeneratedArtifact: (nextArtifact: ChatGeneratedArtifactRecord) => Promise<void> | void;
  setActiveGeneratedArtifact: (nextArtifact: ChatGeneratedArtifactRecord | null) => void;
}) {
  useRouteGeneratedArtifactReveal({
    routeArtifactId: props.routeArtifactId,
    workspaceId: "workspace-1",
    revealGeneratedArtifact: props.revealGeneratedArtifact,
    setActiveGeneratedArtifact: props.setActiveGeneratedArtifact,
  });
  return null;
}

describe("useRouteGeneratedArtifactReveal", () => {
  beforeEach(() => {
    apiMocks.fetchChatGeneratedArtifact.mockReset();
  });

  it("reveals a fetched route artifact and clears when no route artifact is selected", async () => {
    const revealGeneratedArtifact = vi.fn();
    const setActiveGeneratedArtifact = vi.fn();
    apiMocks.fetchChatGeneratedArtifact.mockResolvedValueOnce({ item: artifact });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Harness
          routeArtifactId="artifact-1"
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
      await Promise.resolve();
    });

    expect(apiMocks.fetchChatGeneratedArtifact).toHaveBeenCalledWith("artifact-1", "workspace-1");
    expect(revealGeneratedArtifact).toHaveBeenCalledWith(artifact);

    await act(async () => {
      renderer.update(
        <Harness
          routeArtifactId={null}
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
    });
    expect(setActiveGeneratedArtifact).toHaveBeenCalledWith(null);
  });

  it("clears active generated artifact on fetch failure and ignores stale fetch completions", async () => {
    const revealGeneratedArtifact = vi.fn();
    const setActiveGeneratedArtifact = vi.fn();
    apiMocks.fetchChatGeneratedArtifact.mockRejectedValueOnce(new Error("missing"));

    await act(async () => {
      create(
        <Harness
          routeArtifactId="missing-artifact"
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
      await Promise.resolve();
    });
    expect(setActiveGeneratedArtifact).toHaveBeenCalledWith(null);

    let resolveStale!: (value: { item: ChatGeneratedArtifactRecord }) => void;
    apiMocks.fetchChatGeneratedArtifact.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Harness
          routeArtifactId="stale-artifact"
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
    });
    await act(async () => {
      renderer.update(
        <Harness
          routeArtifactId={null}
          revealGeneratedArtifact={revealGeneratedArtifact}
          setActiveGeneratedArtifact={setActiveGeneratedArtifact}
        />,
      );
    });
    await act(async () => {
      resolveStale({ item: artifact });
      await Promise.resolve();
    });

    expect(revealGeneratedArtifact).not.toHaveBeenCalledWith(artifact);
  });
});
