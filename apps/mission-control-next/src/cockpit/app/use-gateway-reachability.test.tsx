// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useGatewayReachability } from "./use-gateway-reachability";

const api = vi.hoisted(() => ({ fetchOnboardingState: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchOnboardingState: api.fetchOnboardingState,
  isApiRequestError: (error: unknown) => error instanceof Error && "kind" in error,
}));

let root: Root;
let container: HTMLDivElement;
function Probe({ streamState }: { streamState: EventStreamConnectionState }) {
  const connection = useGatewayReachability(true, streamState);
  return <div data-unavailable={connection.unavailable} data-last-confirmed={connection.lastConfirmedAt ?? ""} />;
}

beforeEach(() => {
  api.fetchOnboardingState.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("Gateway reachability", () => {
  it("requires a failed HTTP probe before marking an event-stream retry as an outage", async () => {
    api.fetchOnboardingState.mockResolvedValue({ completed: true });
    await act(async () => root.render(<Probe streamState="open" />));
    expect(container.firstElementChild?.getAttribute("data-unavailable")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-last-confirmed")).not.toBe("");
    await act(async () => root.render(<Probe streamState="retrying" />));
    expect(container.firstElementChild?.getAttribute("data-unavailable")).toBe("false");
    expect(api.fetchOnboardingState).toHaveBeenCalledOnce();
  });

  it("marks network loss and clears it after a successful recovery probe", async () => {
    vi.useFakeTimers();
    api.fetchOnboardingState
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { kind: "network" }))
      .mockResolvedValue({ completed: true });
    await act(async () => root.render(<Probe streamState="retrying" />));
    expect(container.firstElementChild?.getAttribute("data-unavailable")).toBe("true");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.firstElementChild?.getAttribute("data-unavailable")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-last-confirmed")).not.toBe("");
  });
});
