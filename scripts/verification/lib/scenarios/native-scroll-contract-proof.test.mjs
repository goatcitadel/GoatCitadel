import assert from "node:assert/strict";
import { test } from "node:test";

import {
  driveNativeStageToStableBottom,
  validateNativeNestedScrollerSnapshot,
  validateNativeStageSnapshot,
  waitForVisibleNativeStageSnapshot,
} from "./native-scroll-contract-proof.mjs";

test("accepts a bounded native stage at its visible bottom", () => {
  assert.doesNotThrow(() =>
    validateNativeStageSnapshot(
      {
        found: true,
        overflowY: "auto",
        clientHeight: 700,
        documentScrollTop: 0,
        atBottom: true,
        contentBottom: 680,
        visibleBottom: 700,
      },
      "settings-providers",
    ),
  );
});

test("rejects document scrolling and obscured route bottoms", () => {
  assert.throws(
    () =>
      validateNativeStageSnapshot(
        { found: true, overflowY: "auto", clientHeight: 700, documentScrollTop: 20, atBottom: false },
        "ops-runtime",
      ),
    /document scrolled/,
  );
  assert.throws(
    () =>
      validateNativeStageSnapshot(
        {
          found: true,
          overflowY: "auto",
          clientHeight: 700,
          documentScrollTop: 0,
          atBottom: true,
          contentBottom: 730,
          visibleBottom: 700,
        },
        "ops-runtime",
      ),
    /final route content remained below/,
  );
});

test("requires nested native collections to hand vertical scrolling to the stage", () => {
  assert.doesNotThrow(() =>
    validateNativeNestedScrollerSnapshot({ found: true, overscrollBehaviorY: "auto" }, "library-skills"),
  );
  assert.throws(
    () => validateNativeNestedScrollerSnapshot({ found: true, overscrollBehaviorY: "contain" }, "library-skills"),
    /blocked vertical handoff/,
  );
});

test("waits through a transient zero-height layout before certifying the native stage", async () => {
  const clock = createClock();
  const page = createStagePage({
    clock,
    samples: [stageSnapshot(0, 0), stageSnapshot(1_408, 952)],
  });

  const snapshot = await waitForVisibleNativeStageSnapshot(page, {
    label: "settings-workspaces",
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: clock.now,
  });

  assert.equal(snapshot.clientHeight, 952);
  assert.equal(page.sampleCount, 2);
  assert.equal(page.waitCount, 1);
  assert.equal(clock.value, 10);
});

test("fails closed when the native stage remains at zero height through the layout deadline", async () => {
  const clock = createClock();
  const page = createStagePage({ clock, samples: [stageSnapshot(0, 0)] });

  await assert.rejects(
    () =>
      waitForVisibleNativeStageSnapshot(page, {
        label: "settings-workspaces",
        timeoutMs: 30,
        pollIntervalMs: 10,
        now: clock.now,
      }),
    /settings-workspaces: stage scroller had no visible height before the layout deadline \(samples=4,elapsedMs=30,clientHeight=0\)/u,
  );
  assert.equal(page.sampleCount, 4);
  assert.equal(page.waitCount, 3);
});

test("re-drives the stage when route-owned async content grows after the first bottom scroll", async () => {
  const clock = createClock();
  const page = createStagePage({
    clock,
    samples: [
      stageSnapshot(1_408, 952, 0),
      stageSnapshot(2_108, 952, 456),
      stageSnapshot(2_108, 952),
      stageSnapshot(2_108, 952),
      stageSnapshot(2_108, 952),
    ],
  });

  const snapshot = await driveNativeStageToStableBottom(page, {
    label: "library-files",
    timeoutMs: 50,
    minimumObservationMs: 0,
    pollIntervalMs: 10,
    requiredStableSamples: 3,
    now: clock.now,
  });

  assert.equal(snapshot.maxScrollTop, 1_156);
  assert.equal(page.sampleCount, 5);
  assert.equal(page.driveCount, 2);
  assert.equal(page.waitCount, 4);
});

test("resets stability and re-drives when the stage leaves bottom between polls", async () => {
  const clock = createClock();
  const page = createStagePage({
    clock,
    samples: [
      stageSnapshot(1_408, 952),
      stageSnapshot(1_408, 952),
      stageSnapshot(1_408, 952, 0),
      stageSnapshot(2_108, 952),
      stageSnapshot(2_108, 952),
      stageSnapshot(2_108, 952),
    ],
  });

  const snapshot = await driveNativeStageToStableBottom(page, {
    label: "projects",
    timeoutMs: 60,
    minimumObservationMs: 0,
    pollIntervalMs: 10,
    requiredStableSamples: 3,
    now: clock.now,
  });

  assert.equal(snapshot.maxScrollTop, 1_156);
  assert.equal(page.sampleCount, 6);
  assert.equal(page.driveCount, 1);
  assert.equal(page.waitCount, 5);
});

test("returns after the current bottom and layout remain stable", async () => {
  const clock = createClock();
  const page = createStagePage({ clock, samples: [stageSnapshot(1_408, 952)] });

  const snapshot = await driveNativeStageToStableBottom(page, {
    label: "projects",
    timeoutMs: 30,
    minimumObservationMs: 20,
    pollIntervalMs: 10,
    requiredStableSamples: 3,
    now: clock.now,
  });

  assert.equal(snapshot.scrollTop, 456);
  assert.equal(page.sampleCount, 3);
  assert.equal(page.driveCount, 0);
  assert.equal(page.waitCount, 2);
});

test("observes for the full minimum window and catches growth after an initial stable streak", async () => {
  const clock = createClock();
  let grewToCurrentBottom = false;
  const page = createStagePage({
    clock,
    sampleAt: (now) => {
      if (now < 500) {
        return stageSnapshot(1_408, 952);
      }
      return grewToCurrentBottom ? stageSnapshot(2_108, 952) : stageSnapshot(2_108, 952, 456);
    },
    onDrive: () => {
      grewToCurrentBottom = true;
    },
  });

  const snapshot = await driveNativeStageToStableBottom(page, {
    label: "library-files",
    timeoutMs: 2_000,
    minimumObservationMs: 1_000,
    pollIntervalMs: 50,
    requiredStableSamples: 6,
    now: clock.now,
  });

  assert.equal(snapshot.maxScrollTop, 1_156);
  assert.equal(clock.value, 1_000);
  assert.equal(page.driveCount, 1);
  assert.ok(page.sampleCount > 6);
});

test("fails closed with a bounded numeric snapshot when layout never settles", async () => {
  const clock = createClock();
  const page = createStagePage({
    clock,
    samples: [
      stageSnapshot(1_408, 952),
      stageSnapshot(1_508, 952),
      stageSnapshot(1_608, 952),
      stageSnapshot(1_708, 952),
    ],
  });

  await assert.rejects(
    () =>
      driveNativeStageToStableBottom(page, {
        label: "library-files",
        timeoutMs: 40,
        minimumObservationMs: 0,
        pollIntervalMs: 10,
        requiredStableSamples: 3,
        now: clock.now,
      }),
    /library-files: stage bottom did not stabilize within 40 ms \(samples=4,elapsedMs=40,clientHeight=952,scrollHeight=1708,scrollTop=756,maxScrollTop=756,stableSamples=1\)/u,
  );
  assert.equal(page.sampleCount, 4);
  assert.equal(page.driveCount, 0);
  assert.equal(page.waitCount, 4);
});

test("charges evaluator time against the real wall-clock deadline", async () => {
  const clock = createClock();
  const page = createStagePage({
    clock,
    evaluateDurationMs: 30,
    samples: [stageSnapshot(1_408, 952)],
  });

  await assert.rejects(
    () =>
      driveNativeStageToStableBottom(page, {
        label: "projects",
        timeoutMs: 25,
        minimumObservationMs: 0,
        pollIntervalMs: 10,
        requiredStableSamples: 1,
        now: clock.now,
      }),
    /projects: stage bottom did not stabilize within 25 ms \(samples=1,elapsedMs=30,clientHeight=952,scrollHeight=1408,scrollTop=456,maxScrollTop=456,stableSamples=0\)/u,
  );
  assert.equal(page.sampleCount, 1);
  assert.equal(page.waitCount, 0);
});

function stageSnapshot(scrollHeight, clientHeight, scrollTop = Math.max(0, scrollHeight - clientHeight)) {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return {
    found: true,
    overflowY: "auto",
    clientHeight,
    scrollHeight,
    scrollTop,
    maxScrollTop,
    documentScrollTop: 0,
    atBottom: Math.abs(scrollTop - maxScrollTop) <= 2,
    contentBottom: clientHeight,
    visibleBottom: clientHeight,
  };
}

function createStagePage({ clock, samples, sampleAt, onDrive, evaluateDurationMs = 0 }) {
  let sampleCount = 0;
  let driveCount = 0;
  let waitCount = 0;
  return {
    get sampleCount() {
      return sampleCount;
    },
    get waitCount() {
      return waitCount;
    },
    get driveCount() {
      return driveCount;
    },
    async evaluate(_expression, argument) {
      clock.advance(evaluateDurationMs);
      if (typeof argument === "string") {
        driveCount += 1;
        onDrive?.(clock.value);
        return undefined;
      }
      const sample = sampleAt?.(clock.value) ?? samples[Math.min(sampleCount, samples.length - 1)];
      sampleCount += 1;
      return sample;
    },
    async waitForTimeout(durationMs) {
      waitCount += 1;
      clock.advance(durationMs);
    },
  };
}

function createClock() {
  let value = 0;
  return {
    get value() {
      return value;
    },
    now: () => value,
    advance(durationMs) {
      value += durationMs;
    },
  };
}
