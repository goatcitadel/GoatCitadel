import { useEffect, useState, useSyncExternalStore } from "react";

/** Expiry labels count whole minutes, so one shared minute tick keeps every label current (IN-05). */
export const MINUTE_CLOCK_TICK_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) timer = setInterval(tick, MINUTE_CLOCK_TICK_MS);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function snapshot() {
  // A clock read after a quiet spell (no subscribers, or a throttled tab) never returns a value older than one tick.
  const elapsed = Date.now() - now;
  // A wall clock that moved backwards (a corrected system clock) must not leave the cached time in the future.
  if (elapsed >= MINUTE_CLOCK_TICK_MS || elapsed < 0) now = Date.now();
  return now;
}

/**
 * The current time, re-rendering subscribers once a minute from one shared timer. With `deadline`, the component also
 * re-renders once at that moment, so an expiry takes effect on time without a per-second re-render.
 */
export function useMinuteClock(deadline?: string): number {
  const clock = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [reachedAt, setReachedAt] = useState(0);
  useEffect(() => {
    const at = deadline ? Date.parse(deadline) : NaN;
    if (!Number.isFinite(at)) return;
    const wait = at - Date.now();
    // Past deadlines are already reflected by the clock; far ones exceed the timer range and the minute tick covers them.
    if (wait < 0 || wait > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => setReachedAt(Date.now()), wait + 1);
    return () => clearTimeout(timer);
  }, [deadline]);
  return Math.max(clock, reachedAt);
}

/** True when an expiry is set, readable, and not after `at`. */
export function hasExpired(expiresAt: string | undefined, at: number): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= at;
}

export function __resetMinuteClockForTests() {
  if (timer) clearInterval(timer);
  timer = undefined;
  listeners.clear();
  now = Date.now();
}
