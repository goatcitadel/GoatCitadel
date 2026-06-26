import { describe, it, expect } from "vitest";
import {
  parseAppRoute,
  buildAppHref,
  normalizeAppRoute,
  buildModeRail,
  getRouteDescription,
  getRouteLabel,
} from "./route-model";

describe("unified surface mode field", () => {
  it("collapses /code to chat with mode=code", () => {
    const r = parseAppRoute("http://x/code?sessionId=s1");
    expect(r.area).toBe("chat");
    expect(r.mode).toBe("code");
    expect(r.sessionId).toBe("s1");
  });
  it("collapses /cowork (root) to chat with mode=cowork", () => {
    const r = parseAppRoute("http://x/cowork");
    expect(r.area).toBe("chat");
    expect(r.mode).toBe("cowork");
  });
  it("keeps /cowork/tasks as the Task Board route", () => {
    const r = parseAppRoute("http://x/cowork/tasks");
    expect(r.area).toBe("cowork");
    expect(r.section).toBe("tasks");
  });
  it("keeps /cowork/board as the Agent Board route", () => {
    const r = parseAppRoute("http://x/cowork/board");
    expect(r.area).toBe("cowork");
    expect(r.section).toBe("board");
  });
  it("reads ?mode= on the chat area", () => {
    expect(parseAppRoute("http://x/chat?mode=cowork").mode).toBe("cowork");
    expect(parseAppRoute("http://x/chat").mode).toBeUndefined();
  });
  it("ignores an invalid ?mode=", () => {
    expect(parseAppRoute("http://x/chat?mode=bogus").mode).toBeUndefined();
  });
  it("round-trips a code thread href", () => {
    expect(buildAppHref({ area: "chat", mode: "code", sessionId: "s9" })).toBe("/chat?sessionId=s9&mode=code");
  });
  it("emits bare /chat for chat mode", () => {
    expect(buildAppHref({ area: "chat", mode: "chat" })).toBe("/chat");
    expect(buildAppHref({ area: "chat" })).toBe("/chat");
  });
  it("normalizes a stray area:code into chat+mode", () => {
    const n = normalizeAppRoute({ area: "code", sessionId: "s2" } as never);
    expect(n.area).toBe("chat");
    expect(n.mode).toBe("code");
  });
  it("labels the unified root as Work and mode routes by their routed mode", () => {
    expect(getRouteLabel({ area: "chat" })).toBe("Work");
    expect(getRouteLabel({ area: "chat", mode: "cowork" })).toBe("Cowork");
    expect(getRouteLabel({ area: "code" })).toBe("Code");
    expect(getRouteDescription({ area: "chat" })).toContain("One conversation/work surface");
    expect(getRouteDescription({ area: "chat", mode: "code" })).toContain("Code mode");
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
  it("cowork mode → Task Board + Agent Board", () => {
    const items = buildModeRail("cowork");
    const tasks = items.find((i) => i.id === "mode-tasks");
    expect(tasks?.area).toBe("cowork");
    expect(tasks?.section).toBe("tasks");
    expect(items.some((i) => i.id === "mode-board" && i.section === "board")).toBe(true);
  });
  it("code mode → Files + Runtime + Prompt Packs", () => {
    const items = buildModeRail("code");
    expect(items.some((i) => i.section === "files")).toBe(true);
    expect(items.some((i) => i.section === "runtime")).toBe(true);
    expect(items.some((i) => i.section === "prompt-packs")).toBe(true);
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
