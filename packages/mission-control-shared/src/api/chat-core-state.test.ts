import { beforeEach, expect, it, vi } from "vitest";
import { fetchChatSessionCoreState } from "./chat";
const request = vi.hoisted(() => vi.fn());
vi.mock("./client-core.js", async original => ({ ...await original<typeof import("./client-core.js")>(), request }));
beforeEach(() => { request.mockReset(); });
it("uses one encoded canonical core read instead of three separate requests", async () => {
  const canonical = { sessionId: "s/1", thread: { sessionId: "s/1", turns: [] }, binding: null, prefs: { sessionId: "s/1", revision: 1 } };
  request.mockResolvedValue(canonical); expect(await fetchChatSessionCoreState("s/1")).toBe(canonical);
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/chat/sessions/s%2F1/core-state");
});
it("retains transcript-free refresh intent", async () => {
  request.mockResolvedValue({ sessionId: "s1", binding: null, prefs: { sessionId: "s1" } }); await fetchChatSessionCoreState("s1", { includeThread: false });
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/chat/sessions/s1/core-state?includeThread=false");
});
it("propagates owner failure without retries or speculative fallback reads", async () => {
  const failure = new Error("Owner unavailable"); request.mockRejectedValue(failure);
  let observed: unknown; try { await fetchChatSessionCoreState("s1"); } catch (error) { observed = error; }
  expect(observed).toBe(failure); expect(request).toHaveBeenCalledTimes(1);
});
