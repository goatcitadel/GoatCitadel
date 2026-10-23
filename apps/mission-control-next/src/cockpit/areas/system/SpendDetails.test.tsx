// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpendDetails } from "./SpendDetails";

const route = vi.hoisted(() => ({ search: "", hash: "#coverage", navigate: vi.fn() }));
const api = vi.hoisted(() => ({ fetchCostSummary: vi.fn() }));
const preferences = vi.hoisted(() => ({
  activeWorkspaceId: "ws-1",
  activeCitadelId: "c-1",
  showTechnicalDetails: false,
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ fetchCostSummary: api.fetchCostSummary }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("./SpendAttempts", () => ({
  SpendAttempts: ({ from }: { from: string }) => <p>Attempts from {from}</p>,
}));
vi.mock("./SpendObservedModels", () => ({ SpendObservedModels: () => null }));

const segment = (providerKey: string, label: string, costUsd: number) => ({
  providerKey,
  label,
  tokenInput: 10,
  tokenOutput: 5,
  tokenTotal: 15,
  costUsd,
  metricAvailability: {
    inputTokensComplete: true,
    outputTokensComplete: true,
    cachedInputTokensComplete: true,
    costUsdComplete: costUsd > 0,
  },
});
const summary = {
  scope: "day",
  from: "2026-10-16T00:00:00.000Z",
  to: "2026-10-22T23:59:59.999Z",
  usageAvailability: {
    trackedEvents: 12,
    unknownEvents: 3,
    totalAgentEvents: 15,
    metricAvailability: {
      inputTokens: { knownAttemptCount: 12, unknownAttemptCount: 0, complete: true },
      outputTokens: { knownAttemptCount: 12, unknownAttemptCount: 0, complete: true },
      cachedInputTokens: { knownAttemptCount: 12, unknownAttemptCount: 0, complete: true },
      costUsd: { knownAttemptCount: 9, unknownAttemptCount: 3, complete: false },
    },
  },
  items: [],
  dailySeries: ["2026-10-20", "2026-10-21", "2026-10-22"].map((isoDate) => ({
    isoDate,
    tokenTotal: 30,
    costUsd: 1,
    segments: [segment("openai", "OpenAI", 1), segment("local", "Local model", 0)],
  })),
};
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  route.search = "?workspaceId=ws-1&cockpitReturnView=spend-overview";
  api.fetchCostSummary.mockResolvedValue(summary);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});
const render = async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SpendDetails />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Providers"));
};
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;

it("renders natively with the Spend details heading", async () => {
  await render();
  expect(host.querySelector(".cockpit-embedded-classic")).toBeNull();
  expect(host.querySelector("h1")?.textContent).toBe("Spend details");
});

it("writes the time window to the URL and keeps the return view and hash", async () => {
  await render();
  await act(async () => button("3 days").click());
  const [href, options] = route.navigate.mock.calls[0]!;
  const target = new URL(href, "http://cockpit.invalid");
  expect(target.pathname).toBe("/system/spend/details");
  expect(target.searchParams.get("window")).toBe("3");
  expect(target.searchParams.get("cockpitReturnView")).toBe("spend-overview");
  expect(target.hash).toBe("#coverage");
  expect(options).toEqual({ replace: true });
});

it("shows Unknown for a provider whose cost was not reported, never $0.00", async () => {
  await render();
  const local = [...host.querySelectorAll("li")].find((node) => node.textContent?.includes("Local model"))!;
  expect(local.textContent).toContain("Unknown");
  expect(host.textContent).not.toContain("$0.00");
});

it("states call coverage for all providers", async () => {
  await render();
  const term = [...host.querySelectorAll("dt")].find((node) => node.textContent === "Calls with a known cost");
  expect(term?.nextElementSibling?.textContent).toBe("9 of 12");
});

it("narrows to the provider in the URL", async () => {
  route.search = "?provider=openai";
  await render();
  expect(button("OpenAI").getAttribute("aria-pressed")).toBe("true");
  expect([...host.querySelectorAll("h3")].map((node) => node.textContent)).toEqual(["OpenAI"]);
});
