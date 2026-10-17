// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approvalExpiryLabel } from "./approval-preview";
import { __resetMinuteClockForTests, hasExpired, useMinuteClock } from "./use-minute-clock";

let root: Root;
let container: HTMLDivElement;
let renders = 0;

function Label({ expiresAt }: { expiresAt: string }) {
  renders += 1;
  const now = useMinuteClock(expiresAt);
  return <p>{hasExpired(expiresAt, now) ? "Expired" : approvalExpiryLabel(expiresAt, now)}</p>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  __resetMinuteClockForTests();
  renders = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetMinuteClockForTests();
  vi.useRealTimers();
});

it("ticks expiry labels once a minute from one shared clock, then expires on time (IN-05)", async () => {
  await act(async () =>
    root.render(
      <>
        <Label expiresAt="2026-10-16T12:02:30Z" />
        <Label expiresAt="2026-10-16T12:02:30Z" />
      </>,
    ),
  );
  expect(container.textContent).toBe("Expires in 3 minutesExpires in 3 minutes");
  const afterMount = renders;
  // No per-second re-render: nothing renders again inside the minute.
  await act(async () => vi.advanceTimersByTime(59_000));
  expect(renders).toBe(afterMount);
  await act(async () => vi.advanceTimersByTime(1_000));
  expect(container.textContent).toBe("Expires in 2 minutesExpires in 2 minutes");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(container.textContent).toBe("Expires in 1 minuteExpires in 1 minute");
  // The expiry moment itself re-renders once, without waiting for the next minute tick.
  await act(async () => vi.advanceTimersByTime(30_001));
  expect(container.textContent).toBe("ExpiredExpired");
  expect(vi.getTimerCount()).toBe(1);
});
