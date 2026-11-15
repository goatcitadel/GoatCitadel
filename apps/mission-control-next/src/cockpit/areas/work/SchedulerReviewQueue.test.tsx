// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchCronReviewQueue } from "@goatcitadel/mission-control-shared/api/cron";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { SchedulerReviewQueue } from "./SchedulerReviewQueue";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({ fetchCronReviewQueue: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/state/ui-preferences")>()),
  useUiPreferences: () => preferences,
}));

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
  preferences.showTechnicalDetails = false;
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

it("names a flagged run in plain words and keeps job and run ids out of the primary text", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { cronReviewQueueV1Enabled: true } } as Awaited<
    ReturnType<typeof fetchSettings>
  >);
  vi.mocked(fetchCronReviewQueue).mockResolvedValue({
    items: [
      {
        itemId: "item-a",
        jobId: "job-nightly-7f3a",
        runId: "cron-run-9c1d",
        severity: "high",
        status: "open",
        summary: { trigger: "scheduled_due", childDurableRunId: "durable-1234", childDurableStatus: "dead_lettered" },
        createdAt: "2026-10-14T09:00:00.000Z",
        updatedAt: "2026-10-14T09:05:00.000Z",
      },
    ],
  } as unknown as Awaited<ReturnType<typeof fetchCronReviewQueue>>);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SchedulerReviewQueue scheduleName={(jobId) => (jobId === "job-nightly-7f3a" ? "Nightly digest" : undefined)} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Nightly digest · On its schedule"));
  expect(container.textContent).toContain("High severity");
  expect(container.textContent).toContain("Needs review");
  expect(container.textContent).toContain("Child run: Failed · needs recovery.");
  for (const raw of ["job-nightly-7f3a", "cron-run-9c1d", "durable-1234", "open", "2026-10-14T"])
    expect(container.textContent).not.toContain(raw);
});

const reviewItem = (summary: Record<string, unknown>) => ({
  itemId: "item-b",
  jobId: "job-b",
  runId: "run-b",
  severity: "medium",
  status: "open",
  summary,
  createdAt: "2026-10-14T09:00:00.000Z",
  updatedAt: "2026-10-14T09:05:00.000Z",
});

it("names the trigger and profile of each review row with no underscore (U-GL-032)", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { cronReviewQueueV1Enabled: true } } as never);
  vi.mocked(fetchCronReviewQueue).mockResolvedValue({
    items: [reviewItem({ trigger: "manual_run", profilePosture: "creator_profile_missing", childDurableRunId: "d-1" })],
  } as never);
  await renderQueue();
  await vi.waitFor(() => expect(container.textContent).toContain("Started by hand"));
  expect(container.textContent).toContain("Profile: Creator profile missing.");
  expect(container.textContent).not.toMatch(/_/);
});

it("shows an unknown trigger, profile or child state as Other with the raw value in technical details", async () => {
  preferences.showTechnicalDetails = true;
  vi.mocked(fetchSettings).mockResolvedValue({ features: { cronReviewQueueV1Enabled: true } } as never);
  vi.mocked(fetchCronReviewQueue).mockResolvedValue({
    items: [
      reviewItem({
        trigger: "brand_new_trigger",
        profilePosture: "brand_new_profile",
        childDurableRunId: "d-1",
        childDurableStatus: "brand_new_state",
      }),
    ],
  } as never);
  await renderQueue();
  await vi.waitFor(() => expect(container.textContent).toContain("Other trigger"));
  expect(container.textContent).toContain("Profile: Other profile.");
  expect(container.textContent).toContain("Child run: Another state.");
  const details = container.querySelector("details");
  expect(details?.textContent).toContain("brand_new_trigger");
  expect(details?.textContent).toContain("brand_new_profile");
  expect(details?.textContent).toContain("brand_new_state");
});

async function renderQueue() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SchedulerReviewQueue />
      </QueryClientProvider>,
    ),
  );
}
const switchLink = () =>
  [...container.querySelectorAll("a")].find((entry) => entry.textContent === "Turn it on in Settings › Advanced");
const hashOf = (link: Element | undefined) => new URL(link!.getAttribute("href")!, "http://cockpit.invalid").hash;

it("says scheduler review is off and links to its switch", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ revision: 2, features: { cronReviewQueueV1Enabled: false } } as never);
  await renderQueue();
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Scheduler review is turned off on this installation, so no review items can be shown.",
    ),
  );
  expect(hashOf(switchLink())).toBe("#feature-switch-scheduler-review");
  expect(fetchCronReviewQueue).not.toHaveBeenCalled();
});

it("links the switch when the Gateway refuses the queue because the feature is off", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { cronReviewQueueV1Enabled: true } } as never);
  vi.mocked(fetchCronReviewQueue).mockRejectedValue(
    new ApiRequestError("off", {
      kind: "http",
      method: "GET",
      path: "/api/v1/cron/review-queue",
      status: 409,
      body: { code: "FEATURE_DISABLED", details: { flag: "cronReviewQueueV1Enabled" } },
    }),
  );
  await renderQueue();
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Scheduler review is turned off on this installation, so no review items can be shown.",
    ),
  );
  expect(hashOf(switchLink())).toBe("#feature-switch-scheduler-review");
});

it("does not blame the switch when a 409 is not about the feature being off", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { cronReviewQueueV1Enabled: true } } as never);
  vi.mocked(fetchCronReviewQueue).mockRejectedValue(
    new ApiRequestError("conflict", {
      kind: "http",
      method: "GET",
      path: "/api/v1/cron/review-queue",
      status: 409,
      body: { code: "STATE_CONFLICT" },
    }),
  );
  await renderQueue();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Scheduler review is unavailable on this installation"),
  );
  expect(container.textContent).not.toContain("turned off");
  expect(switchLink()).toBeUndefined();
});
