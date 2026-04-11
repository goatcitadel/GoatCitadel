import React, { useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { useChatThreadController } from "./useChatThreadController";

let latest: ReturnType<typeof useChatThreadController> | null = null;

function Harness(props: {
  routeSearch: string;
  sessions?: Array<any>;
  projects?: Array<any>;
  thread?: any;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState("all");
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

  it("filters visible sessions by project and search query", async () => {
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
              title: "Alpha session",
              sessionKey: "alpha",
            },
            {
              sessionId: "session-2",
              scope: "external",
              lifecycleStatus: "active",
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
      latest?.setSearch("alpha");
    });

    expect(latest?.visibleSessions.map((item) => item.sessionId)).toEqual(["session-1"]);
    expect(latest?.missionSessions).toHaveLength(1);
    expect(latest?.externalSessions).toHaveLength(0);
  });
});
