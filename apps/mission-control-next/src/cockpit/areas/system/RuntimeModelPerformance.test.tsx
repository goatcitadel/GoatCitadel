// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeModelPerformance } from "./RuntimeModelPerformance";
import { runtimeData } from "./runtime-page.test-data";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("../../data/use-model-label", () => ({
  useProviderLabelLookup: () => (providerId?: string) => (providerId === "anthropic" ? "Anthropic" : undefined),
}));

const run = {
  runId: "eval-run-123456",
  promptHash: "h",
  status: "completed",
  createdAt: "2026-10-21T10:00:00Z",
  candidates: [],
  results: [
    { providerId: "anthropic", model: "m1", paretoOptimal: true, notes: [], measurementSource: "measured" },
    { providerId: "local", model: "m2", paretoOptimal: false, notes: [], measurementSource: "measured" },
  ],
  warnings: [],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  preferences.showTechnicalDetails = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (data = runtimeData()) => act(() => root.render(<RuntimeModelPerformance data={data} />));

it("is the efficiency anchor and counts comparison candidates without showing run IDs", () => {
  render(runtimeData({ evalProofRuns: [run] }));
  expect(host.querySelector("section")?.id).toBe("ops-runtime-efficiency");
  expect(host.querySelector("h2")?.textContent).toBe("Model performance");
  expect(host.textContent).toContain("2 candidates");
  expect(host.textContent).not.toContain("eval-run-123456");
});

it("says so when no local engines are configured", () => {
  render();
  expect(host.textContent).toContain("No local engines are configured.");
});

it("names a measured call's provider by its display name", () => {
  render(
    runtimeData({
      runtimeMeasurements: [
        {
          measurementId: "m",
          providerId: "anthropic",
          model: "claude-sonnet",
          status: "completed",
          source: "measured",
          collectedAt: "2026-10-21T10:00:00Z",
          metrics: { latencyMs: 120 },
        },
      ],
    }),
  );
  expect(host.textContent).toContain("claude-sonnet · Anthropic");
});

it("says a source could not be read instead of listing nothing", () => {
  render(runtimeData({}, ["localEngines"]));
  expect(host.textContent).toContain("Local engines could not be read.");
});
