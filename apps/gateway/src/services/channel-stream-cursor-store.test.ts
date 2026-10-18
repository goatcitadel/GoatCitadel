import { describe, expect, it } from "vitest";
import {
  CHANNEL_STREAM_CURSOR_SETTING_PREFIX,
  createSystemSettingsChannelStreamCursorStore,
} from "./channel-stream-cursor-store.js";

function fakeSettings() {
  const map = new Map<string, unknown>();
  return {
    map,
    settings: {
      get: async (key: string) => (map.has(key) ? { key, value: map.get(key), updatedAt: "t" } : undefined),
      set: async (key: string, value: unknown) => {
        map.set(key, value);
        return { key, value, updatedAt: "t" };
      },
    },
  };
}

describe("channel stream cursor store", () => {
  it("round-trips a cursor and scope", async () => {
    const { settings } = fakeSettings();
    const store = createSystemSettingsChannelStreamCursorStore(settings as never);
    await store.write("matrix", "c1", { cursor: "s1_2", scope: "@bot:hs" });
    expect(await store.read("matrix", "c1")).toEqual({ cursor: "s1_2", scope: "@bot:hs" });
    await store.write("matrix", "c1", { cursor: "s1_3" });
    expect(await store.read("matrix", "c1")).toEqual({ cursor: "s1_3" });
  });

  it("uses the channel_stream_cursor_v1:<channel>:<id> key and stamps updatedAt", async () => {
    const { settings, map } = fakeSettings();
    const store = createSystemSettingsChannelStreamCursorStore(
      settings as never,
      () => new Date("2026-10-17T00:00:00.000Z"),
    );
    await store.write("matrix", "abc", { cursor: "x" });
    expect(CHANNEL_STREAM_CURSOR_SETTING_PREFIX).toBe("channel_stream_cursor_v1");
    expect(map.get("channel_stream_cursor_v1:matrix:abc")).toEqual({
      cursor: "x",
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
  });

  it("returns undefined for a missing or malformed key", async () => {
    const { settings, map } = fakeSettings();
    const store = createSystemSettingsChannelStreamCursorStore(settings as never);
    expect(await store.read("matrix", "none")).toBeUndefined();
    map.set("channel_stream_cursor_v1:matrix:bad", { cursor: 5 });
    expect(await store.read("matrix", "bad")).toBeUndefined();
  });
});
