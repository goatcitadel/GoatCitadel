// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserErrandStatus } from "@goatcitadel/mission-control-shared/api/browser-errands";
import { ChatBrowserErrandCard, errandPollInterval } from "./ChatBrowserErrandCard";

const api = vi.hoisted(() => ({ fetchBrowserErrandStatus: vi.fn(), stopBrowserErrand: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/browser-errands", () => ({
  fetchBrowserErrandStatus: api.fetchBrowserErrandStatus,
  stopBrowserErrand: api.stopBrowserErrand,
}));
// The image fetch is the shared AttachmentImage's; these tests cover which attachment the card asks for.
vi.mock("../../ui/AttachmentImage", () => ({
  AttachmentImage: ({ attachmentId, alt }: { attachmentId: string; alt: string }) => (
    <img data-attachment={attachmentId} alt={alt} />
  ),
}));

const running: BrowserErrandStatus = {
  errandId: "errand-1",
  toolRunId: "run-1",
  state: "running",
  stepCount: 3,
  stepText: "Searching for flights",
  thumbnailAttachmentId: "thumb-1",
  modelRequests: 4,
};
const finished: BrowserErrandStatus = {
  ...running,
  state: "finished",
  stepText: "",
  thumbnailAttachmentId: undefined,
  finalAttachmentId: "final-1",
  modelRequests: 7,
  outcome: "done",
  summary: "Found the cheapest flight.",
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function mount(props: { fallback?: Record<string, unknown>; toolRunOpen?: boolean } = {}) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBrowserErrandCard toolRunId="run-1" fallbackResult={props.fallback} toolRunOpen={props.toolRunOpen} />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const buttons = () => [...container.querySelectorAll("button")];

describe("ChatBrowserErrandCard", () => {
  it("shows step text and Stop while running", async () => {
    api.fetchBrowserErrandStatus.mockResolvedValue(running);
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Searching for flights"));
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Step 3");
    expect(container.querySelector("img")?.getAttribute("data-attachment")).toBe("thumb-1");
    expect(buttons().some((button) => button.textContent === "Stop")).toBe(true);
    expect(container.textContent).not.toContain("errand-1");
    expect(container.textContent).not.toContain("waiting_on_you");
  });

  it("stops polling when finished and shows the final screenshot", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchBrowserErrandStatus.mockResolvedValueOnce(running).mockResolvedValue(finished);
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Searching for flights"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Found the cheapest flight."));
    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("7 model requests");
    expect(container.querySelector("img")?.getAttribute("data-attachment")).toBe("final-1");
    expect(buttons().some((button) => button.textContent === "Stop")).toBe(false);
    const calls = api.fetchBrowserErrandStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.fetchBrowserErrandStatus.mock.calls.length).toBe(calls);
  });

  it("Stop calls stopBrowserErrand", async () => {
    api.fetchBrowserErrandStatus.mockResolvedValue(running);
    api.stopBrowserErrand.mockResolvedValue({ stopped: true });
    await mount();
    await vi.waitFor(() => expect(buttons().some((button) => button.textContent === "Stop")).toBe(true));
    await act(async () =>
      buttons()
        .find((button) => button.textContent === "Stop")!
        .click(),
    );
    expect(api.stopBrowserErrand).toHaveBeenCalledWith("errand-1");
  });

  it("uses the tool result when the Gateway no longer holds the errand", async () => {
    api.fetchBrowserErrandStatus.mockResolvedValue(null);
    await mount({
      fallback: {
        outcome: "declined",
        summary: "You declined the step.",
        steps: 2,
        modelRequests: 1,
        finalScreenshotAttachmentId: "final-9",
      },
    });
    await vi.waitFor(() => expect(container.textContent).toContain("You declined the step."));
    expect(container.textContent).toContain("Cancelled");
    expect(container.textContent).toContain("1 model request");
    expect(container.querySelector("img")?.getAttribute("data-attachment")).toBe("final-9");
    expect(container.textContent).not.toContain("declined\n");
  });

  it("labels waiting and paused states with the shared vocabulary", async () => {
    api.fetchBrowserErrandStatus.mockResolvedValue({ ...running, state: "taken_over" });
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Paused"));
    expect(container.textContent).not.toContain("taken_over");
  });

  it("keeps the polled step text out of live regions", async () => {
    api.fetchBrowserErrandStatus.mockResolvedValue(running);
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Searching for flights"));
    const step = [...container.querySelectorAll("p")].find((p) => p.textContent === "Searching for flights");
    expect(step).toBeDefined();
    expect(container.querySelector("[aria-live], [role=status], [role=alert]")).toBeNull();
  });

  it("backs off while reads fail and stops once the tool run has closed", () => {
    const failing = (consecutiveFailures: number, toolRunOpen: boolean) =>
      errandPollInterval({ data: undefined, status: "error", consecutiveFailures, toolRunOpen });
    expect(failing(1, true)).toBe(4_000);
    expect(failing(2, true)).toBe(8_000);
    expect(failing(10, true)).toBe(30_000);
    expect(failing(1, false)).toBe(false);
    expect(errandPollInterval({ data: running, status: "success", consecutiveFailures: 0, toolRunOpen: true })).toBe(
      2_000,
    );
    expect(errandPollInterval({ data: finished, status: "success", consecutiveFailures: 0, toolRunOpen: true })).toBe(
      false,
    );
  });

  it("backs off across consecutive failed polls and starts over after a good one", async () => {
    vi.useFakeTimers();
    const fail = () => Promise.reject(new Error("Gateway unavailable"));
    api.fetchBrowserErrandStatus
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(running)
      .mockImplementationOnce(fail)
      .mockResolvedValue(running);
    await mount({ toolRunOpen: true });
    let elapsed = 0;
    const callsAt = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms - elapsed);
      });
      elapsed = ms;
      return api.fetchBrowserErrandStatus.mock.calls.length;
    };
    expect(await callsAt(0)).toBe(1);
    // Reads at 0 s (fails), 4 s (fails), 12 s (fails), 28 s (good), 30 s (fails), 34 s: the count restarts after 28 s.
    const expected: Array<[number, number]> = [
      [3_900, 1],
      [4_100, 2],
      [11_900, 2],
      [12_100, 3],
      [27_900, 3],
      [28_100, 4],
      [29_900, 4],
      [30_100, 5],
      [33_900, 5],
      [34_100, 6],
    ];
    for (const [at, calls] of expected) {
      expect(await callsAt(at), `reads by ${at} ms`).toBe(calls);
    }
  });

  it("stops asking after a failed read when the tool run is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchBrowserErrandStatus.mockRejectedValue(new Error("Gateway unavailable"));
    await mount();
    await vi.waitFor(() => expect(container.querySelector("p.text-status-failed")).not.toBeNull());
    const calls = api.fetchBrowserErrandStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.fetchBrowserErrandStatus.mock.calls.length).toBe(calls);
  });
});
