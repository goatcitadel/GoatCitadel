import { describe, expect, it, vi } from "vitest";
import {
  applyAutoRouteToInput,
  applySurfaceRoutingPreflight,
  recordModeOverrideIfChanged,
} from "./surface-router-entry.js";

function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    readChatSessionMode: vi.fn(async () => undefined as string | undefined),
    persistChatSessionMode: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("applyAutoRouteToInput", () => {
  it("normalizes a legacy autoRoute turn to chat without any classifier", async () => {
    const host = makeHost();
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "run tests in the repo", autoRoute: true });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("does not rewrite the pinned mode when the session is already chat", async () => {
    const host = makeHost({ readChatSessionMode: vi.fn(async () => "chat") });
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", autoRoute: true });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
  });

  it("repairs a persisted legacy sticky mode", async () => {
    const host = makeHost({ readChatSessionMode: vi.fn(async () => "code") });
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", autoRoute: true });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("does nothing when autoRoute is not set and no mode is given", async () => {
    const host = makeHost();
    const input = { content: "hi" };
    expect(await applyAutoRouteToInput(host as never, "s1", input)).toBe(input);
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
  });

  it("normalizes an explicit legacy mode to chat", async () => {
    const host = makeHost();
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", mode: "code" as never });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("clears a legacy autoRoute flag on an explicit chat turn without a prefs write", async () => {
    const host = makeHost();
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", mode: "chat", autoRoute: true });
    expect(out).toEqual({ content: "hi", mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
  });

  it("leaves an explicit chat turn without autoRoute unchanged", async () => {
    const host = makeHost();
    const input = { content: "hi", mode: "chat" as const };
    expect(await applyAutoRouteToInput(host as never, "s1", input)).toBe(input);
  });
});

function makeOverrideHost(overrides: Record<string, unknown> = {}) {
  return {
    readChatSessionMode: vi.fn(() => "code"),
    persistChatSessionMode: vi.fn(),
    ...overrides,
  };
}

describe("recordModeOverrideIfChanged", () => {
  it("re-pins to chat when explicit mode differs from persisted", async () => {
    const host = makeOverrideHost();
    await recordModeOverrideIfChanged(host as never, "s1", { content: "actually just chat", mode: "chat" });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("repairs a sticky legacy turn", async () => {
    const host = makeOverrideHost();
    await recordModeOverrideIfChanged(host as never, "s1", { content: "keep going", mode: "code" });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("does nothing on the first turn (no persisted mode)", async () => {
    const host = makeOverrideHost({ readChatSessionMode: vi.fn(() => undefined) });
    await recordModeOverrideIfChanged(host as never, "s1", { content: "x", mode: "code" });
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
  });
});

describe("applySurfaceRoutingPreflight", () => {
  it("routes and persists on success path", async () => {
    const host = makeHost();
    const out = await applySurfaceRoutingPreflight(host as never, "s1", {
      content: "run tests in the repo",
      autoRoute: true,
    });
    expect(out.mode).toBe("chat");
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("calls onError and returns original input when persisting the mode throws", async () => {
    const onError = vi.fn();
    const host = makeHost({
      persistChatSessionMode: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const input = { content: "hi", autoRoute: true };
    expect(await applySurfaceRoutingPreflight(host as never, "s1", input, onError)).toBe(input);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
