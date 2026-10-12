// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchCronReviewQueue } from "@goatcitadel/mission-control-shared/api/cron";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { SchedulerReviewQueue } from "./SchedulerReviewQueue";

vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({ fetchCronReviewQueue: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

it("does not request the queue when the settings refresh fails, even though the cached flag was on", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { cronReviewQueueV1Enabled: true } } as Awaited<
    ReturnType<typeof fetchSettings>
  >);
  vi.mocked(fetchCronReviewQueue).mockResolvedValue({ items: [] } as unknown as Awaited<
    ReturnType<typeof fetchCronReviewQueue>
  >);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SchedulerReviewQueue />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(fetchCronReviewQueue).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));

  // The flag owner is now unavailable; react-query keeps the cached `true` alongside the error.
  vi.mocked(fetchSettings).mockRejectedValue(new Error("settings unavailable"));
  const refresh = await vi.waitFor(() => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Refresh",
    );
    expect(button?.disabled).toBe(false);
    return button!;
  });
  await act(async () => refresh.click());
  await vi.waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));

  expect(fetchCronReviewQueue).toHaveBeenCalledTimes(1);
});
