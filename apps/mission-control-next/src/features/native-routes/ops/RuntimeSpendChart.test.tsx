import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildSpendChartAriaLabel,
  computeSpendChartModel,
  RuntimeSpendChart,
  type SpendDay,
} from "./RuntimeSpendChart";

const days: SpendDay[] = [
  { isoDate: "2026-05-19", shortLabel: "Tue", segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }] },
  { isoDate: "2026-05-20", shortLabel: "Wed", segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }] },
  {
    isoDate: "2026-05-21",
    shortLabel: "Thu",
    segments: [{ providerKey: "anthropic", label: "Anthropic", costUsd: 5 }],
  },
  { isoDate: "2026-05-22", shortLabel: "Fri", segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }] },
];

describe("RuntimeSpendChart", () => {
  it("computes median, provider order, and spend anomalies", () => {
    const model = computeSpendChartModel(days, 1.5);

    expect(model.total).toBe(8);
    expect(model.median).toBe(1);
    expect(model.anomalyDay?.isoDate).toBe("2026-05-21");
    expect(model.providerOrder).toEqual(["anthropic", "openai"]);
    expect(buildSpendChartAriaLabel(model)).toContain("Anomaly on Thu");
  });

  it("renders explicit empty state instead of fabricating daily spend", () => {
    const markup = renderToStaticMarkup(<RuntimeSpendChart days={[]} />);

    expect(markup).toContain("No spend history available");
    expect(markup).toContain("Seven-day spend chart, no data available.");
  });

  it("retains meaningful precision for positive sub-cent ticks and values", () => {
    const subCentDays: SpendDay[] = [
      {
        isoDate: "2026-05-19",
        shortLabel: "Tue",
        segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 0.0026 }],
      },
    ];
    const model = computeSpendChartModel(subCentDays, 1.5);
    const markup = renderToStaticMarkup(<RuntimeSpendChart days={subCentDays} />);

    expect(buildSpendChartAriaLabel(model)).toContain("Total $0.0026");
    expect(markup).toContain("$0.00125");
    expect(markup).toContain("$0.0026");
    expect(markup).not.toContain("Total $0.00 across");
  });
});
