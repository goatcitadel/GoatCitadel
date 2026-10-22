// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CostSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { SpendDailyChart } from "./SpendDailyChart";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const segment = { providerKey: "a", label: "Alpha", tokenTotal: 10, models: ["m1"] };
const summary = (days: NonNullable<CostSummaryResponse["dailySeries"]>) =>
  ({ dailySeries: days }) as unknown as CostSummaryResponse;
async function render(value: CostSummaryResponse) {
  await act(async () => root.render(<SpendDailyChart summary={value} />));
}

describe("Spend cost by day (SY-N04, SY-08, VR-04)", () => {
  it("says No day has a known amount when every day is unknown", async () => {
    await render(
      summary([
        { isoDate: "2026-10-06", costUsd: undefined, segments: [{ ...segment }] },
        {
          isoDate: "2026-10-07",
          costUsd: 0,
          segments: [{ ...segment }],
          metricAvailability: { costUsdComplete: false },
        },
      ] as never),
    );
    expect(container.textContent).toContain("No day has a known amount");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("treats exact $0.00 days as known, and says when no day had usage", async () => {
    await render(
      summary([
        {
          isoDate: "2026-10-06",
          costUsd: 0,
          segments: [{ ...segment }],
          metricAvailability: { costUsdComplete: true },
        },
      ] as never),
    );
    expect(container.textContent).toContain("highest day $0.00");
    expect(container.textContent).not.toContain("No day has a known amount");
    await render(summary([{ isoDate: "2026-10-06", costUsd: 0, segments: [] }] as never));
    expect(container.textContent).toContain("No usage recorded in this period");
    expect(container.textContent).not.toContain("No day has a known amount");
  });

  it("keeps the lower-bound marker on the highest day", async () => {
    await render(
      summary([
        {
          isoDate: "2026-10-06",
          costUsd: 2.5,
          segments: [{ ...segment }],
          metricAvailability: { costUsdComplete: false },
        },
        {
          isoDate: "2026-10-07",
          costUsd: 1,
          segments: [{ ...segment }],
          metricAvailability: { costUsdComplete: true },
        },
      ] as never),
    );
    expect(container.textContent).toContain("highest day At least $2.50");
  });

  it("titles day labels with a formatted date, not ISO", async () => {
    await render(
      summary([
        {
          isoDate: "2026-10-08",
          costUsd: 1,
          segments: [{ ...segment }],
          metricAvailability: { costUsdComplete: true },
        },
      ] as never),
    );
    const time = container.querySelector("time")!;
    expect(time.getAttribute("title")).toBe("Thu 8 Oct (UTC)");
    expect(time.getAttribute("dateTime")).toBe("2026-10-08");
  });
});
