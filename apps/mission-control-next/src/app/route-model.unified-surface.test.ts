import { describe, it, expect } from "vitest";
import { parseAppRoute, buildAppHref, normalizeAppRoute } from "./route-model";

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
    expect(buildAppHref({ area: "chat", mode: "code", sessionId: "s9" }))
      .toBe("/chat?sessionId=s9&mode=code");
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
});
