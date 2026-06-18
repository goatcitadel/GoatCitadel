import { afterEach, describe, expect, it } from "vitest";
import { StartupPhaseRecorder, getStartupPhaseRecorder, resetStartupPhaseRecorderForTests } from "./startup-phases.js";

afterEach(() => {
  resetStartupPhaseRecorderForTests();
});

describe("StartupPhaseRecorder", () => {
  it("records open and close timestamps and computes duration", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    const phase = recorder.open("storage_init", { owner: "storage" });
    now += 1500;
    phase.close();
    const snapshot = recorder.snapshot();
    expect(snapshot.phases).toHaveLength(1);
    expect(snapshot.phases[0].durationMs).toBe(1500);
    expect(snapshot.phases[0].owner).toBe("storage");
    expect(snapshot.phases[0].status).toBe("completed");
  });

  it("keeps close idempotent so late cleanup cannot stretch a phase", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    const phase = recorder.open("listen", { owner: "gateway" });
    now += 100;
    phase.close("listening");
    now += 900;
    phase.close("late cleanup");

    const snapshot = recorder.snapshot();

    expect(snapshot.phases[0]).toMatchObject({
      durationMs: 100,
      notes: "listening",
      status: "completed",
    });
  });

  it("records failed startup phases with failure notes", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    const phase = recorder.open("bundled_postgres", { owner: "storage" });
    now += 250;
    phase.fail("spawn failed");
    now += 250;
    phase.fail("late failure");

    const snapshot = recorder.snapshot();

    expect(snapshot.phases[0]).toMatchObject({
      durationMs: 250,
      notes: "spawn failed",
      status: "failed",
    });
  });

  it("supports nested phases (inner closes before outer)", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    const outer = recorder.open("plugin_discovery", { owner: "plugins" });
    now += 100;
    const inner = recorder.open("plugin_load_addon", { owner: "plugins" });
    now += 500;
    inner.close();
    now += 100;
    outer.close();
    const snapshot = recorder.snapshot();
    expect(snapshot.phases.map((p) => p.id)).toEqual(["plugin_discovery", "plugin_load_addon"]);
  });

  it("reports in-progress phases when queried mid-run", () => {
    let now = 1_000_000;
    const recorder = new StartupPhaseRecorder(() => now);
    recorder.open("plugin_discovery", { owner: "plugins" });
    now += 7000;
    const snapshot = recorder.snapshot();
    expect(snapshot.inProgress).toHaveLength(1);
    expect(snapshot.inProgress[0].ageMs).toBe(7000);
  });

  it("tick emits in-progress log when threshold crossed and respects 10s cadence", () => {
    let now = 1_000_000;
    const logs: Array<{ phase: string; ageMs: number }> = [];
    const recorder = new StartupPhaseRecorder(
      () => now,
      (entry) => logs.push({ phase: entry.phase, ageMs: entry.ageMs }),
    );
    recorder.open("plugin_discovery", { owner: "plugins" });
    now += 5500;
    recorder.tick();
    expect(logs.length).toBe(1);
    now += 1000;
    recorder.tick();
    expect(logs.length).toBe(1); // still 1, hasn't been 10s
    now += 10_000;
    recorder.tick();
    expect(logs.length).toBe(2);
  });

  it("singleton getStartupPhaseRecorder is reset by helper", () => {
    const first = getStartupPhaseRecorder();
    expect(first).toBe(getStartupPhaseRecorder());
    resetStartupPhaseRecorderForTests();
    const second = getStartupPhaseRecorder();
    expect(second).not.toBe(first);
  });
});
