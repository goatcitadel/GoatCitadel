import { describe, it, expect } from "vitest";
import {
  parseAppRoute,
  buildAppHref,
  buildNavigationTarget,
  normalizeAppRoute,
  buildModeRail,
  getRouteDescription,
  getRouteLabel,
  getRouteReleaseScope,
  RAIL_GROUPS,
  RAIL_ITEMS,
  routeKicker,
} from "./route-model";

describe("single chat surface route compatibility", () => {
  it("collapses /code to chat without preserving a Code mode", () => {
    const r = parseAppRoute("http://x/code?sessionId=s1");
    expect(r.area).toBe("chat");
    expect(r.mode).toBeUndefined();
    expect(r.sessionId).toBe("s1");
  });
  it("collapses /cowork root to chat without preserving a Cowork mode", () => {
    const r = parseAppRoute("http://x/cowork");
    expect(r.area).toBe("chat");
    expect(r.mode).toBeUndefined();
  });
  it("routes /cowork/tasks into Ops Kanban", () => {
    const r = parseAppRoute("http://x/cowork/tasks");
    expect(r.area).toBe("ops");
    expect(r.section).toBe("kanban");
  });
  it("routes /cowork/board into Ops Kanban", () => {
    const r = parseAppRoute("http://x/cowork/board");
    expect(r.area).toBe("ops");
    expect(r.section).toBe("kanban");
  });
  it("ignores legacy non-chat ?mode= values on the chat area", () => {
    expect(parseAppRoute("http://x/chat?mode=cowork").mode).toBeUndefined();
    expect(parseAppRoute("http://x/chat?mode=code").mode).toBeUndefined();
    expect(parseAppRoute("http://x/chat?mode=chat").mode).toBe("chat");
    expect(parseAppRoute("http://x/chat").mode).toBeUndefined();
  });
  it("ignores an invalid ?mode=", () => {
    expect(parseAppRoute("http://x/chat?mode=bogus").mode).toBeUndefined();
  });
  it("does not round-trip legacy mode values in chat hrefs", () => {
    expect(buildAppHref({ area: "chat", mode: "code", sessionId: "s9" })).toBe("/chat?sessionId=s9");
  });
  it("emits bare /chat for implicit and explicit chat mode", () => {
    expect(buildAppHref({ area: "chat" })).toBe("/chat");
    expect(buildAppHref({ area: "chat", mode: "chat" })).toBe("/chat");
  });
  it("normalizes a stray area:code into chat", () => {
    const n = normalizeAppRoute({ area: "code", sessionId: "s2" } as never);
    expect(n.area).toBe("chat");
    expect(n.mode).toBeUndefined();
  });
  it("labels the chat surface as Work regardless of legacy mode", () => {
    expect(getRouteLabel({ area: "chat" })).toBe("Work");
    expect(getRouteLabel({ area: "chat", mode: "cowork" })).toBe("Work");
    expect(getRouteLabel({ area: "code" })).toBe("Work");
    expect(getRouteDescription({ area: "chat" })).toContain("One chat workspace");
    expect(getRouteDescription({ area: "chat", mode: "code" })).toContain("One chat workspace");
  });
});

describe("buildModeRail", () => {
  it("chat mode → Thread + Artifacts + Memory + Approvals", () => {
    const ids = buildModeRail("chat").map((i) => i.id);
    expect(ids).toContain("chat-thread");
    expect(ids).toContain("chat-artifacts");
    expect(ids).toContain("chat-memory");
    expect(ids).toContain("chat-approvals");
  });
  it("legacy cowork mode still returns the chat rail", () => {
    const items = buildModeRail("cowork");
    expect(items.map((i) => i.id)).toContain("chat-artifacts");
    expect(items.some((i) => i.area === "cowork")).toBe(false);
  });
  it("legacy code mode still returns the chat rail", () => {
    const items = buildModeRail("code");
    expect(items.map((i) => i.id)).toContain("chat-artifacts");
    expect(items.some((i) => i.id === "mode-files")).toBe(false);
  });
  it("preserves context ids when returning to the conversation thread", () => {
    for (const mode of ["cowork", "code"] as const) {
      const threadItem = buildModeRail(mode).find((item) => item.id === "chat-thread");
      expect(threadItem).toBeDefined();
      expect(
        buildNavigationTarget(
          {
            area: "chat",
            mode,
            sessionId: "session-1",
            turnId: "turn-2",
            runId: "run-3",
            artifactId: "artifact-4",
            approvalId: "approval-5",
            projectId: "project-6",
          },
          threadItem!,
        ),
      ).toMatchObject({
        area: "chat",
        mode: undefined,
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-3",
        artifactId: "artifact-4",
        approvalId: "approval-5",
        projectId: "project-6",
      });
    }
  });
  it("every mode rail ends with Approvals", () => {
    for (const m of ["chat", "cowork", "code"] as const) {
      expect(buildModeRail(m).some((i) => i.section === "approvals")).toBe(true);
    }
  });
  it("defaults to the chat rail when mode is undefined", () => {
    expect(buildModeRail(undefined).map((i) => i.id)).toContain("chat-artifacts");
  });
});

describe("trusted saved Ops boards route", () => {
  it("round-trips /ops/boards as a shipped Observe route", () => {
    const route = parseAppRoute("http://x/ops/boards");

    expect(route).toMatchObject({ area: "ops", section: "boards" });
    expect(buildAppHref(route)).toBe("/ops/boards");
    expect(getRouteLabel(route)).toBe("Boards");
    expect(routeKicker(route)).toBe("Ops · Observe · Boards");
    expect(getRouteReleaseScope(route)).toMatchObject({ status: "ship" });
    expect(RAIL_ITEMS.ops.some((item) => item.id === "ops-boards" && item.section === "boards")).toBe(true);
    expect(RAIL_GROUPS.ops?.find((group) => group.id === "ops-observe")?.sections).toContain("boards");
  });
});

describe("remote-worker Ops route (HX-507B)", () => {
  it("round-trips /ops/workers under the Observe group", () => {
    const route = parseAppRoute("http://x/ops/workers");

    expect(route).toMatchObject({ area: "ops", section: "workers" });
    expect(buildAppHref(route)).toBe("/ops/workers");
    expect(getRouteLabel(route)).toBe("Workers");
    expect(routeKicker(route)).toBe("Ops · Observe · Workers");
    expect(RAIL_ITEMS.ops.some((item) => item.id === "ops-workers" && item.section === "workers")).toBe(true);
    expect(RAIL_GROUPS.ops?.find((group) => group.id === "ops-observe")?.sections).toContain("workers");
  });
});
