import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_AUTONOMY_PREFS, type AsyncStorage } from "@goatcitadel/storage";
import { StarterHeartbeat } from "./starter-heartbeat.js";

function fixture() {
  const rows = new Map<string, { value: unknown }>();
  const prefs = new Map<string, typeof DEFAULT_SESSION_AUTONOMY_PREFS>();
  const archived = new Set<string>();
  const traces = new Set(["first", "second", "external", "off"]);
  const storage = {
    systemSettings: {
      get: async (key: string) => rows.get(key),
      compareAndSet: async (key: string, previous: unknown, value: unknown) => {
        if (rows.get(key) !== previous) return undefined;
        const row = { value };
        rows.set(key, row);
        return row;
      },
      set: async (key: string, value: unknown) => rows.set(key, { value }),
    },
    chatSessionMeta: {
      get: async (sessionId: string) => ({
        workspaceId: "workspace",
        sessionId,
        createdAt: "2026-11-20",
        origin: sessionId === "external" ? "channel" : "operator",
        lifecycleStatus: archived.has(sessionId) ? "archived" : "active",
      }),
    },
    sessions: { getBySessionId: async () => ({ kind: "dm" }) },
    chatTurnTraces: {
      listBySession: async (sessionId: string) =>
        traces.has(sessionId)
          ? [{ status: "completed", completion: { status: "complete", providerCallCount: 1 } }]
          : [],
    },
    sessionAutonomyPrefs: { get: async (sessionId: string) => prefs.get(sessionId) ?? DEFAULT_SESSION_AUTONOMY_PREFS },
  } as unknown as ConstructorParameters<typeof StarterHeartbeat>[0] & Partial<AsyncStorage>;
  return { starter: new StarterHeartbeat(storage), prefs, archived, storage };
}

describe("starter heartbeat enrollment", () => {
  it("enrolls one qualifying private Chat across concurrent sweeps and restart", async () => {
    const f = fixture();
    const results = await Promise.all(["first", "second"].map((id) => f.starter.armIfEligible(id, async () => true)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const selected = results[0] ? "first" : "second";
    const rebooted = new StarterHeartbeat(f.storage);
    expect(await rebooted.isArmed(selected)).toBe(true);
    f.archived.add(selected);
    expect(await rebooted.isArmed(selected)).toBe(false);
    expect(await rebooted.armIfEligible(results[0] ? "second" : "first", async () => true)).toBe(false);
  });

  it("preserves explicit monitors and refuses automatic enrollment from other sources", async () => {
    const f = fixture();
    f.prefs.set("off", { ...DEFAULT_SESSION_AUTONOMY_PREFS, heartbeatEnabled: false });
    expect(await f.starter.armIfEligible("off", async () => true)).toBe(false);
    expect(await f.starter.armIfEligible("external", async () => true)).toBe(false);
    expect(await f.starter.armIfEligible("empty", async () => true)).toBe(false);
    expect(await f.starter.armIfEligible("first", async () => false)).toBe(false);
    await f.starter.captureExplicitChoice("second", true);
    expect(await f.starter.isArmed("second")).toBe(true);
    await f.starter.captureExplicitChoice("second", false);
    expect(await f.starter.isArmed("second")).toBe(false);
    expect(await f.starter.armIfEligible("second", async () => true)).toBe(false);
  });
});
