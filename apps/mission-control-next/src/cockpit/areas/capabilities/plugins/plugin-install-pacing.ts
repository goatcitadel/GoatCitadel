/**
 * Waits between reads while something is applied: a second for the first 30, then 3 seconds. The detail read allows
 * 60 a minute, which a steady read a second would use up. A read that fails counts as one, so failing reads slow too.
 */
const APPLYING_MS = 1_000;
const APPLYING_FAST_WAITS = 30;
const APPLYING_SLOW_MS = 3_000;
/** Waits between reads while an approval waits: 5 seconds at first, then less often, at most every 30. */
const WAITING_MS = [5_000, 5_000, 5_000, 10_000, 20_000, 30_000] as const;
export type Pace = "applying" | "waiting";

export function pluginInstallWaitMs(pace: Pace, count: number): number {
  return pace === "waiting"
    ? (WAITING_MS[Math.min(count, WAITING_MS.length) - 1] ?? WAITING_MS[0])
    : count <= APPLYING_FAST_WAITS
      ? APPLYING_MS
      : APPLYING_SLOW_MS;
}
