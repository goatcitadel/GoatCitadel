import React, { useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { useChatThreadController } from "./useChatThreadController";

let latest: ReturnType<typeof useChatThreadController> | null = null;

function Harness(props: { routeSearch: string; sessions?: Array<any>; projects?: Array<any>; thread?: any }) {
  const [selectedProjectId, setSelectedProjectId] = useState("all");
  const [selectedFolderId, setSelectedFolderId] = useState("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [followThreadOutput, setFollowThreadOutput] = useState(false);
  const applyFetchedThreadRef = useRef(() => false);
  const messageMutationVersionRef = useRef(0);

  latest = useChatThreadController({
    routeSearch: props.routeSearch,
    sessions: props.sessions,
    projects: props.projects,
    thread: props.thread ?? null,
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
    applyFetchedThreadRef,
    messageMutationVersionRef,
  });
  return null;
}

describe("useChatThreadController", () => {
  it("resets pending route selection for empty and incomplete route searches", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Harness
          routeSearch="?sessionId=session-2&turnId=turn-2"
          sessions={[{ sessionId: "session-2", scope: "mission", lifecycleStatus: "active" }]}
        />,
      );
    });
    expect(latest?.selectedSessionId).toBe("session-2");

    await act(async () => {
      renderer.update(
        <Harness
          routeSearch="?turnId=turn-2"
          sessions={[{ sessionId: "session-2", scope: "mission", lifecycleStatus: "active" }]}
        />,
      );
    });
    expect(latest?.selectedSessionId).toBe("session-2");

    await act(async () => {
      renderer.update(
        <Harness routeSearch="" sessions={[{ sessionId: "session-2", scope: "mission", lifecycleStatus: "active" }]} />,
      );
    });
    expect(latest?.selectedSessionId).toBe("session-2");
  });

  it("applies route-selected session and turn once the session list is available", async () => {
    await act(async () => {
      create(
        <Harness
          routeSearch="?sessionId=session-2&turnId=turn-2"
          sessions={[
            { sessionId: "session-1", scope: "mission", lifecycleStatus: "active" },
            { sessionId: "session-2", scope: "mission", lifecycleStatus: "active", title: "Pinned run" },
          ]}
          projects={[]}
          thread={{
            sessionId: "session-2",
            turns: [
              { turnId: "turn-1", userMessage: { content: "one" } },
              { turnId: "turn-2", userMessage: { content: "two" } },
            ],
            selectedTurnId: "turn-2",
            activeLeafTurnId: "turn-2",
          }}
        />,
      );
    });

    expect(latest?.selectedSessionId).toBe("session-2");
    expect(latest?.selectedTurnId).toBe("turn-2");
    expect(latest?.followThreadOutput).toBe(true);
  });

  it("waits for route sessions and does not reapply the same route selection", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness routeSearch="?sessionId=session-3&turnId=turn-3" sessions={[]} />);
    });
    expect(latest?.selectedSessionId).toBeNull();

    await act(async () => {
      renderer.update(
        <Harness
          routeSearch="?sessionId=session-3&turnId=turn-3"
          sessions={[{ sessionId: "session-3", scope: "mission", lifecycleStatus: "active" }]}
          thread={{
            sessionId: "session-3",
            turns: [{ turnId: "turn-3", userMessage: { content: "three" } }],
            selectedTurnId: "turn-3",
            activeLeafTurnId: "turn-3",
          }}
        />,
      );
    });
    expect(latest?.selectedSessionId).toBe("session-3");

    act(() => {
      latest?.setSelectedTurnId("manual-turn");
    });
    await act(async () => {
      renderer.update(
        <Harness
          routeSearch="?sessionId=session-3&turnId=turn-3"
          sessions={[{ sessionId: "session-3", scope: "mission", lifecycleStatus: "active" }]}
          thread={{
            sessionId: "session-3",
            turns: [{ turnId: "manual-turn", userMessage: { content: "manual" } }],
            selectedTurnId: "manual-turn",
            activeLeafTurnId: "manual-turn",
          }}
        />,
      );
    });
    expect(latest?.selectedTurnId).toBe("manual-turn");
  });

  it("filters visible sessions by project and folder", async () => {
    await act(async () => {
      create(
        <Harness
          routeSearch=""
          sessions={[
            {
              sessionId: "session-1",
              scope: "mission",
              lifecycleStatus: "active",
              projectId: "project-1",
              folderId: "launch",
              folderName: "Launch",
              tags: ["release"],
              title: "Alpha session",
              sessionKey: "alpha",
            },
            {
              sessionId: "session-2",
              scope: "external",
              lifecycleStatus: "active",
              tags: ["ops"],
              title: "Slack bridge",
              channel: "slack",
              account: "ops",
            },
          ]}
          projects={[{ projectId: "project-1", name: "Alpha" }]}
        />,
      );
    });

    act(() => {
      latest?.setSelectedProjectId("project-1");
      latest?.setSelectedFolderId("launch");
    });

    expect(latest?.visibleSessions.map((item) => item.sessionId)).toEqual(["session-1"]);
    expect(latest?.missionSessions).toHaveLength(1);
    expect(latest?.externalSessions).toHaveLength(0);
  });

  it("derives none filters, tags, labels, counts, and selected project metadata", async () => {
    await act(async () => {
      create(
        <Harness
          routeSearch=""
          sessions={[
            {
              sessionId: "session-1",
              scope: "mission",
              lifecycleStatus: "active",
              projectId: "project-1",
              folderId: "launch",
              folderName: "Launch",
              tags: ["Release", "Ops"],
              title: "Alpha session",
              sessionKey: "alpha",
            },
            {
              sessionId: "session-2",
              scope: "mission",
              lifecycleStatus: "archived",
              tags: ["release"],
              title: "Unfiled session",
              sessionKey: "unfiled",
            },
            {
              sessionId: "session-3",
              scope: "external",
              lifecycleStatus: "active",
              folderId: "ops",
              folderName: "Ops",
              tags: [],
              title: "Slack bridge",
              channel: "slack",
              account: "ops",
            },
          ]}
          projects={[{ projectId: "project-1", name: "Alpha" }]}
          thread={{
            sessionId: "session-1",
            turns: [{ turnId: "turn-1", userMessage: { content: "hello" }, assistantMessage: { content: "hi" } }],
            selectedTurnId: "turn-1",
            activeLeafTurnId: "turn-1",
          }}
        />,
      );
    });

    act(() => {
      latest?.setSelectedSessionId("session-1");
    });
    expect(latest?.selectedProject?.name).toBe("Alpha");
    expect(latest?.availableFolders.map((item) => item.folderId)).toEqual(["launch", "ops"]);
    expect(latest?.availableTags).toEqual([
      { tag: "Ops", count: 1 },
      { tag: "release", count: 2 },
    ]);
    expect(latest?.workspaceMissionSessionCount).toBe(1);
    expect(latest?.boundMissionSessionCount).toBe(1);
    expect(latest?.messages.map((item) => item.content)).toEqual(["hello", "hi"]);
    expect(latest?.visibleSessionLabelById.get("session-1")).toContain("Alpha session");

    act(() => {
      latest?.setSelectedProjectId("none");
      latest?.setSelectedFolderId("none");
    });
    expect(latest?.visibleSessions.map((item) => item.sessionId)).toEqual(["session-2"]);

    act(() => {
      latest?.setSelectedProjectId("all");
      latest?.setSelectedFolderId("all");
      latest?.setSelectedTag("release");
    });
    expect(latest?.visibleSessions.map((item) => item.sessionId)).toEqual(["session-1", "session-2"]);

    act(() => {
      latest?.setSelectedTag(null);
      latest?.setSelectedFolderId("missing-folder");
    });
    expect(latest?.visibleSessions).toEqual([]);
  });
});
