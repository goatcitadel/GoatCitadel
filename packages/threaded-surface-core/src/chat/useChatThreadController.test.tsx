import React, { useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useChatThreadController } from "./useChatThreadController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = [
  {
    sessionId: "session-1",
    sessionKey: "session-1",
    workspaceId: "workspace-1",
    scope: "mission",
    mode: "chat",
    title: "Launch Room",
    projectId: "project-1",
    folderId: "folder-1",
    folderName: "Launch",
    tags: ["Alpha", "Release"],
    lifecycleStatus: "active",
    channel: "mission",
    account: "local",
  },
  {
    sessionId: "session-2",
    sessionKey: "session-2",
    workspaceId: "workspace-1",
    scope: "mission",
    mode: "cowork",
    title: "mission:operator:chat_abc",
    projectId: null,
    folderId: "folder-2",
    folderName: "Research",
    tags: ["alpha"],
    lifecycleStatus: "archived",
    channel: "mission",
    account: "local",
  },
  {
    sessionId: "session-3",
    sessionKey: "session-3",
    workspaceId: "workspace-1",
    scope: "external",
    mode: "chat",
    projectId: "project-1",
    folderId: null,
    folderName: null,
    tags: ["Support"],
    lifecycleStatus: "active",
    channel: "discord",
    account: "ops",
  },
] as ChatSessionRecord[];

const thread = {
  sessionId: "session-2",
  turns: [
    {
      turnId: "turn-1",
      userMessage: { messageId: "message-1", role: "user", content: "Start", createdAt: "2026-05-01T00:00:00Z" },
      assistantMessage: {
        messageId: "message-2",
        role: "assistant",
        content: "Done",
        createdAt: "2026-05-01T00:00:01Z",
      },
    },
    {
      turnId: "turn-2",
      userMessage: { messageId: "message-3", role: "user", content: "Next", createdAt: "2026-05-01T00:00:02Z" },
    },
  ],
} as ChatThreadResponse;

let latest: ReturnType<typeof useChatThreadController> | null = null;

function Harness(props: {
  routeSearch?: string;
  showAllModes?: boolean;
  selectedProjectId?: string;
  selectedFolderId?: string;
  selectedTag?: string | null;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(props.selectedProjectId ?? "all");
  const [selectedFolderId, setSelectedFolderId] = useState(props.selectedFolderId ?? "all");
  const [selectedTag, setSelectedTag] = useState<string | null>(props.selectedTag ?? null);
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>("session-1");
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [followThreadOutput, setFollowThreadOutput] = useState(false);
  latest = useChatThreadController({
    surfaceMode: "chat",
    showAllModes: props.showAllModes,
    routeSearch: props.routeSearch ?? "",
    sessions,
    projects: [{ projectId: "project-1", name: "Launch Project" }],
    thread,
    selectedProjectId,
    setSelectedProjectId,
    selectedFolderId,
    setSelectedFolderId,
    selectedTag,
    setSelectedTag,
    historyView,
    setHistoryView,
    selectedSessionId,
    setSelectedSessionId,
    selectedTurnId,
    setSelectedTurnId,
    search,
    setSearch,
    followThreadOutput,
    setFollowThreadOutput,
    applyFetchedThreadRef: useRef(() => true),
    messageMutationVersionRef: useRef(0),
  });
  return null;
}

describe("useChatThreadController", () => {
  it("applies route session and turn selection once thread data is available", async () => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness routeSearch="?sessionId=session-2&turnId=turn-2" showAllModes />);
    });

    expect(latest!.selectedSessionId).toBe("session-2");
    expect(latest!.selectedTurnId).toBe("turn-2");
    expect(latest!.selectedSession?.sessionId).toBe("session-2");
    expect(latest!.selectedProject).toBeNull();
    expect(latest!.followThreadOutput).toBe(true);
    expect(latest!.messages.map((message) => message.messageId)).toEqual(["message-1", "message-2", "message-3"]);

    await act(async () => {
      renderer!.update(<Harness routeSearch="?sessionId=session-2&turnId=turn-2&nonce=1" showAllModes />);
    });
    expect(latest!.selectedSessionId).toBe("session-2");

    await act(async () => {
      renderer!.update(<Harness routeSearch="?turnId=turn-1" showAllModes />);
    });
    expect(latest!.selectedSessionId).toBe("session-2");
  });

  it("derives folders, tags, visible sessions, labels, and mission counts", async () => {
    await act(async () => {
      create(
        <Harness selectedProjectId="project-1" selectedFolderId="folder-1" selectedTag="alpha" showAllModes={false} />,
      );
    });

    expect(latest!.availableFolders.map((folder) => [folder.folderId, folder.count])).toEqual([
      ["folder-1", 1],
      ["folder-2", 1],
    ]);
    expect(latest!.availableTags.map((tag) => [tag.tag.toLowerCase(), tag.count])).toContainEqual(["alpha", 2]);
    expect(latest!.visibleSessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    expect(latest!.missionSessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    expect(latest!.externalSessions).toEqual([]);
    expect(latest!.workspaceMissionSessionCount).toBe(1);
    expect(latest!.boundMissionSessionCount).toBe(1);
    expect(latest!.visibleSessionLabelById.get("session-1")).toBe("Launch Room");

    await act(async () => {
      create(<Harness selectedProjectId="none" showAllModes />);
    });
    expect(latest!.visibleSessions.map((session) => session.sessionId)).toContain("session-2");
    expect(latest!.visibleSessions.map((session) => session.sessionId)).not.toContain("session-1");

    await act(async () => {
      create(<Harness selectedProjectId="project-missing" showAllModes />);
    });
    expect(latest!.visibleSessions).toEqual([]);

    await act(async () => {
      create(<Harness selectedFolderId="none" showAllModes />);
    });
    expect(latest!.visibleSessions.map((session) => session.sessionId)).toContain("session-3");
    expect(latest!.visibleSessions.map((session) => session.sessionId)).not.toContain("session-1");
  });
});
