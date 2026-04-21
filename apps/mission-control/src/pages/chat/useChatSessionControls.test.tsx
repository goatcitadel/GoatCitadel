import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionControls } from "./useChatSessionControls";

const archiveWorkspaceChatSessionsMock = vi.fn();
const deleteChatSessionMock = vi.fn();
const setChatSessionBindingMock = vi.fn();

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<object>("../../api/client");
  return {
    ...actual,
    archiveWorkspaceChatSessions: (...args: unknown[]) => archiveWorkspaceChatSessionsMock(...args),
    deleteChatSession: (...args: unknown[]) => deleteChatSessionMock(...args),
    setChatSessionBinding: (...args: unknown[]) => setChatSessionBindingMock(...args),
  };
});

type HarnessState = ReturnType<typeof useChatSessionControls> & {
  selectedSessionId: string | null;
  queuedCount: number;
  binding: unknown;
};

let latest: HarnessState | null = null;

function Harness() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>("session-1");
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedProjectId, setSelectedProjectId] = useState("all");
  const [queuedOutbound, setQueuedOutbound] = useState<any[]>([
    { id: "queue-1", sessionId: "session-1" },
    { id: "queue-2", sessionId: "session-2" },
  ]);
  const [, setThread] = useState<any>({ sessionId: "session-1" });
  const [binding, setBinding] = useState<any>(null);

  const hook = useChatSessionControls({
    workspaceId: "default",
    historyView,
    selectedProjectId,
    selectedSession: {
      sessionId: "session-1",
      pinned: false,
      lifecycleStatus: "active",
      title: "Release checklist",
      scope: "external",
    } as any,
    renameTitle: "Release checklist",
    folderName: "Launch",
    tagsValue: "release, checklist",
    setSelectedProjectId,
    setSelectedSessionId,
    setHistoryView,
    setError: vi.fn(),
    setSending: vi.fn(),
    setQueuedOutbound,
    setThread,
    loadSidebar: vi.fn(async () => undefined),
    setBinding,
  });

  latest = {
    ...hook,
    selectedSessionId,
    queuedCount: queuedOutbound.length,
    binding,
  };
  return null;
}

describe("useChatSessionControls", () => {
  beforeEach(() => {
    latest = null;
    archiveWorkspaceChatSessionsMock.mockReset();
    deleteChatSessionMock.mockReset();
    setChatSessionBindingMock.mockReset();
  });

  it("deletes a session and clears queued work for that session only", async () => {
    deleteChatSessionMock.mockResolvedValue({ deleted: true, sessionId: "session-1" });
    create(<Harness />);

    act(() => {
      latest?.handleDeleteSession("Release checklist");
    });

    await act(async () => {
      await latest?.confirmDeleteSession();
    });

    expect(deleteChatSessionMock).toHaveBeenCalledWith("session-1");
    expect(latest?.selectedSessionId).toBeNull();
    expect(latest?.queuedCount).toBe(1);
  });

  it("saves an external binding through the extracted control hook", async () => {
    setChatSessionBindingMock.mockResolvedValue({ transport: "integration", writable: true, target: "#ops" });
    create(<Harness />);

    act(() => {
      latest?.setIntegrationConnectionId("slack:workspace-a");
      latest?.setIntegrationTarget("#ops");
    });

    await act(async () => {
      await latest?.handleSaveExternalBinding();
    });

    expect(setChatSessionBindingMock).toHaveBeenCalledWith("session-1", {
      transport: "integration",
      connectionId: "slack:workspace-a",
      target: "#ops",
      writable: true,
    });
    expect(latest?.binding).toMatchObject({ writable: true, target: "#ops" });
  });
});
