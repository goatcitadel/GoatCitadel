// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatOutageRecovery } from "./use-chat-outage-recovery";

const client = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchOnboardingState: client.probe,
}));

let root: Root;
let container: HTMLDivElement;

function Probe(props: { streamError: string | null; onDismissError: () => void; onRefreshThread: () => void }) {
  useChatOutageRecovery(props);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  client.probe.mockReset();
});

const show = (props: Parameters<typeof Probe>[0]) => act(async () => root.render(<Probe {...props} />));
const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

it("clears the can't-reach notice and reads the thread once the Gateway answers (U-CH-026)", async () => {
  client.probe.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ completed: true });
  const onDismissError = vi.fn();
  const onRefreshThread = vi.fn();
  await show({ streamError: "Network error: Failed to fetch", onDismissError, onRefreshThread });
  await advance(5_000);
  expect(onDismissError).not.toHaveBeenCalled();
  await advance(5_000);
  expect(onDismissError).toHaveBeenCalledTimes(1);
  expect(onRefreshThread).toHaveBeenCalledTimes(1);
  await advance(20_000);
  expect(client.probe).toHaveBeenCalledTimes(2);
  expect(onDismissError).toHaveBeenCalledTimes(1);
});

it("leaves every other error alone and never probes for it (U-CH-026)", async () => {
  const onDismissError = vi.fn();
  await show({ streamError: "Run data refresh failed", onDismissError, onRefreshThread: vi.fn() });
  await advance(30_000);
  expect(client.probe).not.toHaveBeenCalled();
  expect(onDismissError).not.toHaveBeenCalled();
});

it("stops probing when the notice goes away", async () => {
  client.probe.mockRejectedValue(new TypeError("Failed to fetch"));
  await show({ streamError: "Network error: Failed to fetch", onDismissError: vi.fn(), onRefreshThread: vi.fn() });
  await advance(5_000);
  expect(client.probe).toHaveBeenCalledTimes(1);
  await show({ streamError: null, onDismissError: vi.fn(), onRefreshThread: vi.fn() });
  await advance(30_000);
  expect(client.probe).toHaveBeenCalledTimes(1);
});
